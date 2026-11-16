#!/usr/bin/env node
// Give the webcrack modules readable names, without touching anything else.
//
//   node annotate.mjs <deob dir> <out dir> [names.json]
//
// Only identifiers are renamed and the layout is kept line for line, so `diff -r deob out` shows nothing but
// renames, and line numbers stay valid. Names come from, in this order (first one wins):
//   1. names.json "names":   {"3488": {"_0x2ee3f5": "ble"}}              (hand-written)
//   2. webpack export getters: require.d(exports, { buildFrame: function () { return _0x3cf0e2; } })
//   3. method tables:          { u_startScan: _0xd0f8e9 }
//   4. module imports:         var _0x1aa053 = require(7616)  ->  helpers_7616, using names.json "modules"
//                              (import * as X from "./7616.js" in the same way)
// Only module-level bindings with obfuscated names (_0x…) are renamed. A name is skipped when it already occurs
// anywhere in the file, so nothing can be shadowed.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";

const traverse = traverseMod.default ?? traverseMod;
const [deobDir, outDir, namesFile] = process.argv.slice(2);
if (!deobDir || !outDir) {
  console.error("usage: node annotate.mjs <deob dir> <out dir> [names.json]");
  process.exit(2);
}
const cfg = namesFile ? JSON.parse(readFileSync(namesFile, "utf8")) : {};
const moduleNames = cfg.modules ?? {};
const manual = cfg.names ?? {};

const OBF = /^_0x[0-9a-f]+$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MOD_PATH = /^\.\/(\d+)\.js$/;
const RESERVED = new Set(("break case catch class const continue debugger default delete do else export extends " +
  "finally for function if import in instanceof new return super switch this throw try typeof var void while with " +
  "yield let static enum await implements package protected interface private public null true false undefined " +
  "arguments eval require exports module window document").split(" "));

function moduleAlias(id) {
  return moduleNames[id] ? `${moduleNames[id]}_${id}` : `m${id}`;
}

function annotate(id, src) {
  const ast = parse(src, { sourceType: "module", allowReturnOutsideFunction: true });
  const used = new Set();
  // Variable names only: object keys and .property names can't clash with a binding.
  traverse(ast, { Identifier(p) { if (p.isReferencedIdentifier() || p.isBindingIdentifier()) used.add(p.node.name); } });

  let program;
  traverse(ast, { Program(p) { program = p; p.stop(); } });
  const scope = program.scope;

  const wanted = new Map(); // old name -> [new name, source]
  const want = (oldName, newName, source) => {
    if (!OBF.test(oldName) || !scope.hasOwnBinding(oldName) || wanted.has(oldName)) return;
    if (!IDENT.test(newName) || RESERVED.has(newName)) return;
    if (source !== "manual" && newName.length < 3) return; // webpack's mangled export names (Z, P, Vq) say nothing
    wanted.set(oldName, [newName, source]);
  };

  for (const [oldName, newName] of Object.entries(manual[id] ?? {})) want(oldName, newName, "manual");

  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      // require.d(exports, { name: function () { return _0x…; } })
      if (callee.type === "MemberExpression" && callee.object.name === "require" && callee.property.name === "d"
          && args[1]?.type === "ObjectExpression") {
        for (const prop of args[1].properties) {
          const body = prop.value?.body?.body;
          const ret = body?.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : null;
          if (ret?.type === "Identifier" && prop.key?.type === "Identifier") want(ret.name, prop.key.name, "export");
        }
      }
    },
  });
  traverse(ast, {
    ObjectProperty(p) {
      const { key, value, computed, shorthand } = p.node;
      if (computed || shorthand || key.type !== "Identifier" || value.type !== "Identifier") return;
      want(value.name, key.name, "table");
    },
  });
  traverse(ast, {
    VariableDeclarator(p) {
      const init = p.node.init;
      if (p.node.id.type === "Identifier" && init?.type === "CallExpression" && init.callee.name === "require"
          && init.arguments[0]?.type === "StringLiteral") {
        const m = MOD_PATH.exec(init.arguments[0].value);
        if (m) want(p.node.id.name, moduleAlias(m[1]), "import");
      }
    },
    ImportDeclaration(p) {
      const m = MOD_PATH.exec(p.node.source.value);
      const spec = p.node.specifiers[0];
      if (m && spec?.type === "ImportNamespaceSpecifier") want(spec.local.name, moduleAlias(m[1]), "import");
    },
  });

  // Resolve clashes: a new name must not exist in the file yet, and must be unique among the renames.
  const edits = [];
  const report = [];
  for (const [oldName, [newName0, source]] of wanted) {
    let newName = newName0;
    for (let i = 2; used.has(newName); i++) newName = `${newName0}_${i}`;
    used.add(newName);
    const binding = scope.getOwnBinding(oldName);
    const nodes = [binding.identifier, ...binding.referencePaths.map((r) => r.node)];
    for (const v of binding.constantViolations) {
      const n = v.node;
      if (n.type === "AssignmentExpression" && n.left.type === "Identifier") nodes.push(n.left);
      else if (n.type === "UpdateExpression" && n.argument.type === "Identifier") nodes.push(n.argument);
      else if (n.type === "FunctionDeclaration" || n.type === "VariableDeclarator") nodes.push(n.id);
    }
    const seen = new Set();
    for (const n of nodes) {
      if (!n || n.name !== oldName || seen.has(n.start)) continue;
      seen.add(n.start);
      edits.push([n.start, n.end, newName]);
    }
    report.push({ old: oldName, new: newName, source, refs: seen.size });
  }
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, e, t] of edits) out = out.slice(0, s) + t + out.slice(e);
  if (out.split("\n").length !== src.split("\n").length) throw new Error(`${id}.js: line count changed`);
  parse(out, { sourceType: "module", allowReturnOutsideFunction: true });
  return { out, report };
}

mkdirSync(outDir, { recursive: true });
const all = {};
let total = 0;
for (const f of readdirSync(deobDir)) {
  const m = /^(\d+)\.js$/.exec(f);
  if (!m) {
    copyFileSync(join(deobDir, f), join(outDir, f)); // deobfuscated.js too: rebundle.mjs needs it
    continue;
  }
  const { out, report } = annotate(m[1], readFileSync(join(deobDir, f), "utf8"));
  writeFileSync(join(outDir, f), out);
  all[m[1]] = report;
  total += report.length;
}
writeFileSync(join(outDir, "names.report.json"), JSON.stringify(all, null, 1));
const bySource = {};
for (const r of Object.values(all).flat()) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
console.error(`annotate: ${total} names in ${Object.keys(all).length} modules`, bySource);
