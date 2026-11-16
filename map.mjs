#!/usr/bin/env node
// Map of the app's webpack modules, generated from the code: what each module is, what it uses and what it exposes.
//
//   node map.mjs <modules dir> <out.md> [names.json]
//
// Works on deob/ or annotated/ (annotated gives readable export and import names). For each module: size, the
// modules it requires and is required by, its exports, HTML templates it loads, localStorage keys, BLE frames
// built from constants (buildFrame([...])), console messages, and a guess for bundled libraries. The output is a
// derived index of the user's own copy (not for publishing); it contains short strings from the code.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";

const traverse = traverseMod.default ?? traverseMod;
const [dir, outFile, namesFile] = process.argv.slice(2);
if (!dir || !outFile) {
  console.error("usage: node map.mjs <modules dir> <out.md> [names.json]");
  process.exit(2);
}
const cfg = namesFile ? JSON.parse(readFileSync(namesFile, "utf8")) : {};
const alias = cfg.modules ?? {};
const MOD_PATH = /^\.\/(\d+)\.js$/;

// Libraries bundled into the app, recognised by strings only they contain.
const VENDORS = [
  ["jquery", ["jQuery", "Sizzle"]], ["jquery", ["jQuery", ".fn.extend"]], ["lodash", ["lodash"]],
  ["buffer", ["TYPED_ARRAY_SUPPORT"]], ["howler", ["Howler"]], ["base64-js", ["Invalid string. Length must be a multiple of 4"]],
  ["ieee754", ["Math.LN2"]], ["crc", ["crc8"]], ["md5", ["0x5A827999"]], ["md5", ["1732584193", "271733879"]],
  ["core-js", ["core-js"]], ["moment", ["isMoment", "updateLocale"]], ["lottie", ["lottie", "animationData"]], ["hammerjs", ["Hammer"]],
  ["typed.js", ["typeSpeed", "backSpeed"]], ["swiper", ["swiper-slide", "slidesPerView"]], ["dexie", ["Dexie"]], ["i18next", ["i18next", "fallbackLng"]],
];

const mods = {};
for (const f of readdirSync(dir).filter((f) => /^\d+\.js$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b))) {
  const id = f.slice(0, -3);
  const src = readFileSync(join(dir, f), "utf8");
  const ast = parse(src, { sourceType: "module", allowReturnOutsideFunction: true, errorRecovery: true });
  const m = {
    id, bytes: src.length, lines: src.split("\n").length, imports: new Set(), exports: [], templates: new Set(),
    storage: new Set(), frames: [], logs: [], strings: new Map(), vendor: null,
  };
  traverse(ast, {
    ImportDeclaration(p) { const x = MOD_PATH.exec(p.node.source.value); if (x) m.imports.add(x[1]); },
    StringLiteral(p) {
      const v = p.node.value;
      const t = /templates[-\w]*\/[\w/.-]+\.html/.exec(v);
      if (t) m.templates.add(t[0]);
      if (v.length >= 6 && v.length <= 60 && /[a-z] [a-z]/i.test(v)) m.strings.set(v, (m.strings.get(v) ?? 0) + 1);
    },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type === "Identifier" && callee.name === "require" && args[0]?.type === "StringLiteral") {
        const x = MOD_PATH.exec(args[0].value); if (x) m.imports.add(x[1]);
      }
      const prop = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
      if (callee.type === "MemberExpression" && callee.object.name === "require" && prop === "d" && args[1]?.type === "ObjectExpression") {
        for (const pr of args[1].properties) if (pr.key?.type === "Identifier") m.exports.push(pr.key.name);
      }
      if ((prop === "getItem" || prop === "setItem" || prop === "removeItem") && callee.object.name === "localStorage"
          && args[0]?.type === "StringLiteral") m.storage.add(args[0].value);
      if (prop === "buildFrame" && args[0]?.type === "ArrayExpression" && args[0].elements.every((e) => e?.type === "StringLiteral")) {
        m.frames.push({ bytes: args[0].elements.map((e) => e.value.replace(/^0x/, "").padStart(2, "0")).join(" "), line: p.node.loc.start.line });
      }
      if (callee.type === "MemberExpression" && callee.object.name === "console" && args[0]) {
        const a = args[0];
        const text = a.type === "StringLiteral" ? a.value : a.type === "TemplateLiteral" ? a.quasis.map((q) => q.value.cooked).join("…") : null;
        if (text && text.trim()) m.logs.push({ text: text.slice(0, 70), line: p.node.loc.start.line });
      }
    },
  });
  // A module that uses the app's own modules (named in names.json) is app code, even if it mentions a library.
  const usesApp = [...m.imports].some((x) => alias[x]) || alias[id];
  if (!usesApp) for (const [name, frags] of VENDORS) if (!m.vendor && frags.every((s) => src.includes(s))) m.vendor = name;
  mods[id] = m;
}
for (const m of Object.values(mods)) m.importedBy = Object.values(mods).filter((o) => o.imports.has(m.id)).map((o) => o.id);

const label = (id) => (alias[id] ? `${id} (${alias[id]})` : mods[id]?.vendor ? `${id} [${mods[id].vendor}]` : id);
const list = (xs, max = 12) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, … (${xs.length})` : xs.join(", ")) || "–";
const esc = (s) => s.replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\n/g, " ");

let md = `# Module map\n\nGenerated by \`map.mjs\` from \`${basename(dir)}/\`. ${Object.keys(mods).length} modules.\n` +
  `Names in parentheses come from \`names.json\`, names in brackets are detected libraries.\n\n` +
  `| module | KB | lines | uses | used by | exports | what it touches |\n|---|---|---|---|---|---|---|\n`;
for (const m of Object.values(mods)) {
  const what = [m.templates.size && `${m.templates.size} templates`, m.storage.size && `${m.storage.size} storage keys`,
    m.frames.length && `${m.frames.length} BLE frames`, m.logs.length && `${m.logs.length} logs`].filter(Boolean).join(", ");
  md += `| [${label(m.id)}](#m${m.id}) | ${(m.bytes / 1024).toFixed(0)} | ${m.lines} | ${m.imports.size} | ${m.importedBy.length} | ${m.exports.length} | ${what || "–"} |\n`;
}
for (const m of Object.values(mods)) {
  md += `\n## <a id="m${m.id}"></a>${label(m.id)}\n\n`;
  md += `- **uses:** ${list([...m.imports].map(label))}\n- **used by:** ${list(m.importedBy.map(label))}\n`;
  md += `- **exports:** ${list(m.exports.map((e) => `\`${e}\``), 40)}\n`;
  if (m.templates.size) md += `- **templates:** ${list([...m.templates].map((t) => `\`${t}\``), 40)}\n`;
  if (m.storage.size) md += `- **localStorage:** ${list([...m.storage].map((t) => `\`${t}\``), 40)}\n`;
  if (m.frames.length) md += `- **BLE frames (constant):** ${m.frames.map((f) => `\`${f.bytes}\` (l. ${f.line})`).join(", ")}\n`;
  if (m.logs.length) md += `- **console:** ${list(m.logs.map((l) => `l. ${l.line} \`${esc(l.text)}\``), 15)}\n`;
  if (!m.vendor && !m.logs.length && !alias[m.id]) {
    const top = [...m.strings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s]) => `\`${esc(s)}\``);
    if (top.length) md += `- **strings:** ${top.join(", ")}\n`;
  }
}
writeFileSync(outFile, md);
const vendors = Object.values(mods).filter((m) => m.vendor).map((m) => `${m.id}=${m.vendor}`);
console.error(`map: ${Object.keys(mods).length} modules → ${outFile}; libraries: ${vendors.join(" ") || "none"}`);
