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

## Verification

`SHA256SUMS` lists every file of a known-good 1.3.13 extract (2087 files) and its webcrack output (111 files,
webcrack version pinned by `package-lock.json`). The script checks both. If everything matches, the module
numbers and line references in the docs apply to your copy.

The output is copyrighted by the publisher. Keep it for personal use and do not publish it.
