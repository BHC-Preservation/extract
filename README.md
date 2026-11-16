# Colonies app extract

Rebuilds the reverse-engineering workspace for **Colonies 1.3.13** (Beyond Humanity: Colonies companion app)
from **your own copy** of the app. This repo contains no app code or assets, only the script and a checksum manifest.

The app is Cordova. All game logic and assets live in `www/`, which is not FairPlay-encrypted, so a plain copy is enough.
The native binary is never touched.

## Getting the app

- **Apple Silicon Mac:** install "Beyond Humanity: Colonies" from the App Store (`id1549940628`).
- **Anywhere else:** download the `.ipa` with your own Apple ID that owns the app (e.g. with `ipatool`).

## Usage

```bash
mise install && mise trust     # Node 22 (webcrack's isolated-vm does not build on newer Node)
./extract.sh                   # default source: /Applications/Colonies.app, output: ./out
./extract.sh path/to/Colonies.ipa out
```

The source can be the installed app, the inner `Wrapper/Colonies.app`, an `.ipa`, or a `.zip` of the app.
`SKIP_DEOB=1` skips the webcrack step.

Output:

- `out/app-snapshot/`: `www/`, `Info.plist`, `config.xml`
- `out/deob/`: webcrack output, 109 webpack modules (`3488.js`, `7616.js`, …)
- `out/annotated/`: the same modules with readable names (see below)

## Verification

`SHA256SUMS` lists every file of a known-good 1.3.13 extract (2087 files) and its webcrack output (111 files,
webcrack version pinned by `package-lock.json`). The script checks both. If everything matches, the module
numbers and line references in the docs apply to your copy.

## Readable names: `annotate.mjs`

webcrack decodes strings and control flow, but local names stay `_0x2ee3f5`. `annotate.mjs` renames module-level
identifiers and changes nothing else: same layout, same line numbers, so `diff -r out/deob out/annotated` shows
only renames. Names come from:

1. `names.json` → `names`: hand-written, per module (`{"3488": {"_0x2ee3f5": "bleState"}}`),
2. webpack export getters: `require.d(exports, { buildFrame: function () { return _0x3cf0e2; } })`,
3. method tables in the code: `{ u_startScan: _0xd0f8e9 }`,
4. module imports: `var _0x1aa053 = require("./7616.js")` → `helpers_7616` (aliases in `names.json` → `modules`).

About 900 names come out of 2–4 automatically. A name that already exists in the file is never reused.
`out/annotated/names.report.json` lists every rename with its source. `names.json` contains names only, no code.

## Rebuilding a bundle: `rebundle.mjs`

```bash
node rebundle.mjs out/annotated out/index.js    # or out/deob
```

Puts the module files back into a runnable bundle: webcrack's `deobfuscated.js` provides the webpack runtime
and start-up code, and each module's body is replaced with its `NNNN.js` (ESM imports turned back into
`require`). Fixes made in the module files therefore end up in the app.
**Confirmed (November 2026):** both `deob/` and `annotated/` rebundled this way run in the rebuilt app in the
iOS Simulator the same way as the original `index.min.js`, up to the main menu.

Publish fixes as patches (`diff -U1` against `deob/` or `annotated/`), never the patched code.

The output is copyrighted by the publisher. Keep it for personal use and do not publish it.
