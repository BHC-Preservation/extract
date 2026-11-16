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
- `out/map.md`: a map of all modules (see below)

## Verification

`SHA256SUMS` lists every file of a known-good 1.3.13 extract (2087 files) and its webcrack output (111 files,
webcrack version pinned by `package-lock.json`). The script checks both. If everything matches, the module
numbers and line references in the docs apply to your copy.

## Readable names: `annotate.mjs`

webcrack decodes strings and control flow, but local names stay `_0x2ee3f5`. `annotate.mjs` renames obfuscated
identifiers and changes nothing else: same layout, same line numbers, so `diff -r out/deob out/annotated` shows
only renames. About 3100 names, all found automatically except what is in `names.json`:

| source | example | count |
|---|---|---|
| webpack export getters | `require.d(exports, { buildFrame: … })` → `buildFrame` | ~400 |
| module imports (aliases in `names.json` → `modules`, libraries detected by `map.mjs`) | `helpers_7616`, `jquery` | ~420 |
| method tables, named function expressions | `{ u_startScan: _0xd0f8e9 }` → `u_startScan` | ~150 |
| Babel runtime helpers, recognised by their code | `_asyncToGenerator`, `_classCallCheck`, `_typeof` | ~190 |
| async wrappers and regenerator state machines | `showLoading_impl`, `_callee`, `_context` | ~330 |
| DOM and values | `querySelector(".loading")` → `loadingEl`, `localStorage.getItem("arcAddress")` → `arcAddress` | ~540 |
| local conventions | `catch (err)`, `.findIndex(function (item)`, `new Promise(function (resolve, reject)`, `for (var i` | ~1100 |
| hand-written | `names.json` → `names`, e.g. `{"3488": {"_0x2ee3f5": "bleState"}}` | |

A new name is only used where it doesn't occur in the binding's scope yet, and every file is checked afterwards:
each identifier must resolve to the same declaration (or the same global) as before, otherwise the script stops.
`out/annotated/names.report.json` lists every rename with its source. `names.json` contains names only, no code.

## Module map: `map.mjs`

```bash
node map.mjs out/annotated out/map.md names.json
```

`out/map.md` lists every module: size, which modules it uses and is used by, its exports, the HTML templates it
loads, localStorage keys, BLE frames built from constants, console messages, and bundled libraries it recognises
(jQuery, lodash, buffer, Swiper, …). For modules without any of that it shows their most frequent strings, which
is usually enough to tell what they are. It is generated from your copy and contains short strings from the code,
so it stays local like the rest of `out/`.

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
