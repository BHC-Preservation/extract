#!/usr/bin/env node
// Put the webcrack modules (NNNN.js) back into a runnable bundle, so fixes can be made in readable code.
//
//   node rebundle.mjs <deob dir> <output.js>
//
// webcrack writes two things: deobfuscated.js (the whole bundle: webpack runtime + the app's start-up code +
// all modules inline) and one file per module. Only the module files are convenient to read and patch, but
// the runtime and start-up code exist only in deobfuscated.js. So: take deobfuscated.js as the skeleton and
// replace the body of every module with the content of its NNNN.js, undoing webcrack's module conversion:
//   import * as X from "./N.js"   ->  var X = require(N);      (and require.r(exports) at the top)
//   require("./N.js")             ->  require(N)
// Everything else in the module files is used as is, so patches applied to NNNN.js end up in the bundle.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

const [deobDir, outFile] = process.argv.slice(2);
if (!deobDir || !outFile) {
  console.error("usage: node rebundle.mjs <deob dir> <output.js>");
  process.exit(2);
}

/** Apply [start, end, text] edits to src (non-overlapping). */
function splice(src, edits) {
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s, e, t] of edits) src = src.slice(0, s) + t + src.slice(e);
  return src;
}

function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
    else if (v && typeof v.type === "string") walk(v, fn);
  }
}

const MOD_PATH = /^\.\/(\d+)\.js$/;

/** Module file -> body of a webpack module function (module, exports, require). */
function moduleBody(id) {
  const src = readFileSync(join(deobDir, `${id}.js`), "utf8");
  const ast = parse(src, { sourceType: "module", allowReturnOutsideFunction: true });
  const edits = [];
  let isEsm = false;
  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" || stmt.type === "ExportAllDeclaration") {
      throw new Error(`${id}.js: export statements are not handled`);
    }
    if (stmt.type !== "ImportDeclaration") continue;
    isEsm = true;
    const m = MOD_PATH.exec(stmt.source.value);
    const spec = stmt.specifiers;
    if (!m || spec.length !== 1 || spec[0].type !== "ImportNamespaceSpecifier") {
      throw new Error(`${id}.js: unexpected import form at line ${stmt.loc.start.line}`);
    }
    edits.push([stmt.start, stmt.end, `var ${spec[0].local.name} = require(${m[1]});`]);
  }
  walk(ast.program, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require"
        && n.arguments.length === 1 && n.arguments[0].type === "StringLiteral") {
      const m = MOD_PATH.exec(n.arguments[0].value);
      if (m) edits.push([n.arguments[0].start, n.arguments[0].end, m[1]]);
    }
  });
  return (isEsm ? "require.r(exports);\n" : "") + splice(src, edits);
}

// Find the webpack module table in deobfuscated.js: an object whose keys are module ids and values functions.
const bundleSrc = readFileSync(join(deobDir, "deobfuscated.js"), "utf8");
const bundle = parse(bundleSrc, { sourceType: "script" });
const files = new Set(readdirSync(deobDir).filter((f) => /^\d+\.js$/.test(f)).map((f) => f.slice(0, -3)));
let table = null;
walk(bundle.program, (n) => {
  if (table || n.type !== "ObjectExpression" || n.properties.length < files.size) return;
  const ok = n.properties.every((p) => p.type === "ObjectProperty" && p.key.type === "NumericLiteral"
    && p.value.type === "FunctionExpression" && files.has(String(p.key.value)));
  if (ok) table = n;
});
if (!table) throw new Error("module table not found in deobfuscated.js");
if (table.properties.length !== files.size) {
  throw new Error(`module table has ${table.properties.length} entries, ${files.size} module files`);
}

const edits = table.properties.map((p) => [
  p.value.start, p.value.end,
  `function (module, exports, require) {\n${moduleBody(p.key.value)}\n}`,
]);
const out = splice(bundleSrc, edits);
parse(out, { sourceType: "script" }); // fails loudly if the result is not valid JS
writeFileSync(outFile, out);
console.error(`rebundle: ${edits.length} modules → ${outFile} (${out.length} bytes)`);
