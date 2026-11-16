#!/usr/bin/env node
// Give the webcrack modules readable names, without touching anything else.
//
//   node annotate.mjs <deob dir> <out dir> [names.json]
//
// Only identifiers are renamed and the layout is kept line for line, so `diff -r deob out` shows nothing but
// renames, and line numbers stay valid. Only obfuscated names (_0x…) are touched. Names come from, in this
// order (a binding keeps the first name it gets):
//   manual    names.json "names": {"3488": {"_0x2ee3f5": "bleState"}}
//   export    webpack export getters: require.d(exports, { buildFrame: function () { return _0x3cf0e2; } })
//   table     method tables: { u_startScan: _0xd0f8e9 }
//   import    var _0x1aa053 = require("./7616.js") -> helpers_7616 (aliases: names.json "modules")
//   fnprop    named function expressions in a property: { u_checkDeviceId: function _0x20baaa() {…} }
//   helper    Babel runtime helpers recognised by their code (_classCallCheck, _typeof, _asyncToGenerator, …)
//   async     async wrapper pairs: function showLoading() { return _0x6fdeb4.apply(this, arguments) } -> showLoading_impl
//   regen     regenerator state machines: .wrap(function (_context) …), .mark(function _callee() …)
//   dom       document.querySelector(".loading") -> loadingEl, createElement("button") -> buttonEl
//   value     localStorage.getItem("arcAddress") -> arcAddress, new Media(…) -> media, x.findIndex(…) -> index,
//             getAttribute("data-id") -> id
//   local     catch (err), array callbacks (item, index), new Promise(resolve, reject), event handlers (event),
//             for loop counters (i)
// A name is only used when it doesn't occur anywhere in the binding's scope yet (otherwise _2, _3, …), and every
// file is checked afterwards: each identifier must still resolve to the same declaration (or the same global).
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
const PARSE = { sourceType: "module", allowReturnOutsideFunction: true };

// Babel runtime helpers, recognised by code fragments that only they contain. [name, all of these, max size]
const HELPERS = [
  ["_regeneratorRuntime", ["Generator is already running"], Infinity],
  ["_classCallCheck", ["Cannot call a class as a function"], 400],
  ["_typeof", ['typeof Symbol.iterator == "symbol"', "Symbol.prototype"], 600],
  ["_toPrimitive", ["@@toPrimitive must return a primitive value."], 800],
  ["_inherits", ["Super expression must either be null or a function"], 1200],
  ["_assertThisInitialized", ["this hasn't been initialised - super() hasn't been called"], 400],
  ["_possibleConstructorReturn", ["Derived constructors may only return object or undefined"], 800],
  ["_nonIterableRest", ["Invalid attempt to destructure non-iterable instance"], 600],
  ["_nonIterableSpread", ["Invalid attempt to spread non-iterable instance"], 600],
  ["_createForOfIteratorHelper", ["Invalid attempt to iterate non-iterable instance"], 4000],
  ["_unsupportedIterableToArray", ['"Arguments"', "Array.from"], 1200],
  ["_createClass", ['"prototype"', "writable: false"], 1200],
  ["_defineProperties", ['"value" in', "enumerable", "Object.defineProperty"], 1500],
  ["_asyncGeneratorStep", ["Promise.resolve(", ".done"], 800],
  ["_asyncToGenerator", ["new Promise(", '"next"', '"throw"'], 1500],
];

function moduleAlias(id) {
  return moduleNames[id] ? `${moduleNames[id]}_${id}` : `m${id}`;
}
const camel = (s) => s.replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/[^A-Za-z0-9_$]/g, "");
const lcfirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** ".main-menu .menu .continue, .x" -> "continue"; "#log" -> "log"; "button" -> "button" */
function selectorName(sel) {
  const last = sel.split(",")[0].trim().split(/[\s>+~]+/).pop() ?? "";
  const clean = last.replace(/\[.*?\]/g, "").replace(/:.*/, "");
  const parts = clean.match(/[.#]?[A-Za-z][\w-]*/g);
  if (!parts) return null;
  const pick = [...parts].reverse().find((p) => p[0] === "." || p[0] === "#") ?? parts[0];
  const n = camel(pick.replace(/^[.#]/, ""));
  return /^[A-Za-z]/.test(n) ? n : null;
}

/** For every identifier (in traversal order): which declaration it resolves to, or which global. */
function resolution(ast) {
  const order = new Map();
  const ids = [];
  traverse(ast, {
    Identifier(p) {
      if (!(p.isReferencedIdentifier() || p.isBindingIdentifier())) return;
      order.set(p.node, ids.length);
      ids.push(p);
    },
  });
  return ids.map((p) => {
    const b = p.scope.getBinding(p.node.name);
    return b ? order.get(b.identifier) ?? `?${p.node.name}` : `G:${p.node.name}`;
  });
}

function annotate(id, src) {
  const ast = parse(src, PARSE);
  const before = resolution(parse(src, PARSE));

  // name -> scopes in which it occurs (to keep new names from clashing)
  const occurs = new Map();
  const note = (name, scope) => { if (!occurs.has(name)) occurs.set(name, []); occurs.get(name).push(scope); };
  traverse(ast, { Identifier(p) { if (p.isReferencedIdentifier() || p.isBindingIdentifier()) note(p.node.name, p.scope); } });
  const takenIn = (scope, name) => (occurs.get(name) ?? []).some((s) => {
    for (let c = s; c; c = c.parent) if (c === scope) return true;
    return false;
  });

  let program;
  traverse(ast, { Program(p) { program = p; p.stop(); } });

  const edits = new Map(); // start offset -> [end, name]
  const report = [];
  const done = new Set();

  function rename(binding, newName0, source) {
    if (!binding || done.has(binding)) return;
    const oldName = binding.identifier.name;
    if (!OBF.test(oldName) || !newName0 || !IDENT.test(newName0) || RESERVED.has(newName0)) return;
    if (source !== "manual" && newName0.length < 3 && !["i", "j"].includes(newName0)) return; // webpack's Z, P, Vq
    if (binding.referencePaths.some((r) => r.parentPath.isObjectProperty({ shorthand: true }))) return;
    let newName = newName0;
    for (let i = 2; takenIn(binding.scope, newName) || RESERVED.has(newName); i++) newName = `${newName0}_${i}`;

    const nodes = [[binding.identifier, binding.scope], ...binding.referencePaths.map((r) => [r.node, r.scope])];
    for (const v of binding.constantViolations) {
      const n = v.node;
      if (n.type === "AssignmentExpression" && n.left.type === "Identifier") nodes.push([n.left, v.scope]);
      else if (n.type === "UpdateExpression" && n.argument.type === "Identifier") nodes.push([n.argument, v.scope]);
      else if (n.type === "FunctionDeclaration" || n.type === "VariableDeclarator") nodes.push([n.id, v.scope]);
    }
    const seen = new Set();
    for (const [n, s] of nodes) {
      if (!n || n.name !== oldName || n.start == null || seen.has(n.start)) continue;
      seen.add(n.start);
      edits.set(n.start, [n.end, newName]);
      note(newName, s);
    }
    binding.scope.rename(oldName, newName);
    done.add(binding);
    report.push({ old: oldName, new: newName, source, refs: seen.size });
  }
  const progBinding = (name) => program.scope.getOwnBinding(name);

  // manual, export, table, import (module level)
  for (const [oldName, newName] of Object.entries(manual[id] ?? {})) rename(progBinding(oldName), newName, "manual");
  const exportNames = [], tableNames = [], importNames = [];
  traverse(ast, {
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type === "MemberExpression" && callee.object.name === "require" && callee.property.name === "d"
          && args[1]?.type === "ObjectExpression") {
        for (const prop of args[1].properties) {
          const body = prop.value?.body?.body;
          const ret = body?.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : null;
          if (ret?.type === "Identifier" && prop.key?.type === "Identifier") exportNames.push([ret.name, prop.key.name]);
        }
      }
    },
    ObjectProperty(p) {
      const { key, value, computed, shorthand } = p.node;
      if (!computed && !shorthand && key.type === "Identifier" && value.type === "Identifier") tableNames.push([value.name, key.name]);
    },
    VariableDeclarator(p) {
      const init = p.node.init;
      if (p.node.id.type === "Identifier" && init?.type === "CallExpression" && init.callee.name === "require"
          && init.arguments[0]?.type === "StringLiteral") {
        const m = MOD_PATH.exec(init.arguments[0].value);
        if (m) importNames.push([p.node.id.name, moduleAlias(m[1])]);
      }
    },
    ImportDeclaration(p) {
      const m = MOD_PATH.exec(p.node.source.value);
      const spec = p.node.specifiers[0];
      if (m && spec?.type === "ImportNamespaceSpecifier") importNames.push([spec.local.name, moduleAlias(m[1])]);
    },
  });
  for (const [o, n] of exportNames) rename(progBinding(o), n, "export");
  for (const [o, n] of tableNames) rename(progBinding(o), n, "table");
  for (const [o, n] of importNames) rename(progBinding(o), n, "import");

  // Collect the remaining candidates first (paths stay valid across renames), then rename.
  const later = [];
  const add = (source, getBinding, name) => later.push([source, getBinding, name]);
  traverse(ast, {
    FunctionExpression(p) {
      const fid = p.node.id;
      if (!fid || !OBF.test(fid.name)) return;
      const parent = p.parent;
      let key = null;
      if (parent.type === "ObjectProperty" && !parent.computed && parent.key.type === "Identifier") key = parent.key.name;
      if (parent.type === "AssignmentExpression" && parent.left.type === "MemberExpression" && !parent.left.computed) key = parent.left.property.name;
      if (key) add("fnprop", () => p.scope.getOwnBinding(fid.name) ?? p.scope.getBinding(fid.name), key);
    },
    FunctionDeclaration(p) {
      const fid = p.node.id;
      if (!fid || p.parentPath !== program) return;
      if (OBF.test(fid.name)) {
        const code = src.slice(p.node.start, p.node.end);
        for (const [name, frags, max] of HELPERS) {
          if (code.length <= max && frags.every((f) => code.includes(f))) {
            add("helper", () => program.scope.getOwnBinding(fid.name), name);
            break;
          }
        }
      }
      // function W() { return X.apply(this, arguments); } -> X = W_impl (W is named by then, or skipped)
      const body = p.node.body.body;
      const ret = body.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : null;
      if (ret?.type === "CallExpression" && ret.callee.type === "MemberExpression" && ret.callee.property.name === "apply"
          && ret.callee.object.type === "Identifier" && ret.arguments[0]?.type === "ThisExpression") {
        const target = ret.callee.object.name;
        add("async", () => program.scope.getOwnBinding(target), () => (OBF.test(fid.name) ? null : `${fid.name}_impl`));
      }
    },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      const prop = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
      const fn = args[0] && (args[0].type === "FunctionExpression" || args[0].type === "ArrowFunctionExpression") ? args[0] : null;
      const fnPath = fn ? p.get("arguments.0") : null;
      const param = (i, name, source) => {
        const prm = fn?.params[i];
        if (prm?.type === "Identifier") add(source, () => fnPath.scope.getOwnBinding(prm.name), name);
      };
      if (prop === "wrap" && fn) param(0, "_context", "regen");
      if (prop === "mark" && fn?.id) add("regen", () => fnPath.scope.getOwnBinding(fn.id.name), "_callee");
      if (["find", "findIndex", "filter", "map", "forEach", "some", "every", "flatMap"].includes(prop) && fn) {
        param(0, "item", "local");
        param(1, "index", "local");
      }
      if (prop === "reduce" && fn) { param(0, "acc", "local"); param(1, "item", "local"); }
      if (prop === "addEventListener" && args[1] && (args[1].type === "FunctionExpression" || args[1].type === "ArrowFunctionExpression")) {
        const h = args[1], hp = p.get("arguments.1");
        if (h.params[0]?.type === "Identifier") add("local", () => hp.scope.getOwnBinding(h.params[0].name), "event");
      }
    },
    NewExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type === "Identifier" && callee.name === "Promise" && args[0]?.params) {
        const fp = p.get("arguments.0");
        ["resolve", "reject"].forEach((n, i) => {
          const prm = args[0].params[i];
          if (prm?.type === "Identifier") add("local", () => fp.scope.getOwnBinding(prm.name), n);
        });
      }
    },
    CatchClause(p) {
      const prm = p.node.param;
      if (prm?.type === "Identifier") add("local", () => p.scope.getOwnBinding(prm.name), "err");
    },
    ForStatement(p) {
      const init = p.node.init;
      if (init?.type === "VariableDeclaration" && init.declarations.length === 1 && init.declarations[0].id.type === "Identifier"
          && init.declarations[0].init?.type === "NumericLiteral" && init.declarations[0].init.value === 0) {
        const n = init.declarations[0].id.name;
        add("local", () => p.scope.getBinding(n), "i");
      }
    },
  });

  // dom / value: name a variable after what it holds, when every assignment to it agrees.
  function valueName(v) {
    if (!v) return null;
    if (v.type === "CallExpression" && v.callee.type === "MemberExpression" && !v.callee.computed) {
      const obj = v.callee.object, m = v.callee.property.name, a0 = v.arguments[0];
      const str = a0?.type === "StringLiteral" ? a0.value : null;
      if (str != null && (m === "querySelector" || m === "getElementById" || m === "closest")) {
        const n = m === "getElementById" ? camel(str) : selectorName(str);
        return n && /^[A-Za-z]/.test(n) ? [`${n}El`, "dom"] : null;
      }
      if (str != null && (m === "querySelectorAll" || m === "getElementsByClassName")) {
        const n = m === "querySelectorAll" ? selectorName(str) : camel(str);
        return n ? [`${n}Els`, "dom"] : null;
      }
      if (str != null && m === "createElement" && obj.name === "document") return [`${camel(str)}El`, "dom"];
      if (str != null && m === "getItem" && obj.name === "localStorage" && IDENT.test(camel(str))) return [camel(str), "value"];
      if (m === "findIndex" || m === "indexOf") return ["index", "value"];
      if (str != null && m === "getAttribute" && IDENT.test(camel(str.replace(/^data-/, "")))) return [camel(str.replace(/^data-/, "")), "value"];
    }
    if (v.type === "NewExpression") {
      const c = v.callee;
      const n = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : null;
      if (n && !OBF.test(n) && /^[A-Z]/.test(n) && n.length >= 3 && n !== "Promise") return [lcfirst(n), "value"];
    }
    return null;
  }
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.id.type !== "Identifier" || !OBF.test(p.node.id.name)) return;
      const name = p.node.id.name;
      // var _0x1a6f1b = jquery_9755;  ->  jquery  (webpack's interop copy of an import)
      const init = p.node.init;
      if (init?.type === "Identifier" && /^[a-z][A-Za-z0-9]*_\d+$/.test(init.name)) {
        add("import", () => p.scope.getBinding(name), init.name.replace(/_\d+$/, ""));
        return;
      }
      add("dom/value", () => {
        const b = p.scope.getBinding(name);
        if (!b) return null;
        const values = [p.node.init, ...b.constantViolations.map((v) => (v.node.type === "AssignmentExpression" && v.node.operator === "=" ? v.node.right : undefined))]
          .filter((x) => x !== null); // `var x;` without init is fine
        const names = values.map((x) => (x === undefined ? null : valueName(x)));
        if (!names.length || names.some((n) => !n) || new Set(names.map((n) => n[0])).size !== 1) return null;
        return b;
      }, () => {
        const b = p.scope.getBinding(name) ?? null;
        const v = [p.node.init, ...(b?.constantViolations ?? []).map((x) => x.node.right)].find(Boolean);
        return valueName(v);
      });
    },
  });

  for (const [source, getBinding, name] of later) {
    const b = getBinding();
    if (!b) continue;
    const n = typeof name === "function" ? name() : name;
    if (Array.isArray(n)) rename(b, n[0], n[1]);
    else if (n) rename(b, n, source);
  }

  const sorted = [...edits.entries()].sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [s, [e, t]] of sorted) out = out.slice(0, s) + t + out.slice(e);
  if (out.split("\n").length !== src.split("\n").length) throw new Error(`${id}.js: line count changed`);
  const after = resolution(parse(out, PARSE));
  if (after.length !== before.length || after.some((x, i) => (typeof x === "string" && x.startsWith("G:") ? x !== before[i] : x !== before[i]))) {
    const i = after.findIndex((x, k) => x !== before[k]);
    throw new Error(`${id}.js: identifier #${i} resolves differently after renaming (${before[i]} -> ${after[i]})`);
  }
  return { out, report };
}

mkdirSync(outDir, { recursive: true });
const all = {};
let total = 0;
for (const f of readdirSync(deobDir).sort()) {
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
