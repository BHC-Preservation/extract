#!/usr/bin/env bash
# Extract the Colonies 1.3.13 web layer (www/ + Info.plist + config.xml) from your own copy of the app,
# verify it against SHA256SUMS and deobfuscate index.min.js with webcrack.
#
# Usage:
#   ./extract.sh [SOURCE] [OUT_DIR]
#
# SOURCE (default: /Applications/Colonies.app) can be:
#   - the installed macOS (Apple Silicon) app:   /Applications/Colonies.app
#   - the inner iOS bundle:                     .../Colonies.app/Wrapper/Colonies.app
#   - an .ipa you downloaded yourself (e.g. with ipatool)
#   - a .zip of the macOS app (e.g. made with `ditto -c -k --keepParent`)
# OUT_DIR (default: ./out) gets app-snapshot/ and deob/.
#
# Only www/ is needed; it is not FairPlay-encrypted. The native binary is never copied.
# Set SKIP_DEOB=1 to skip webcrack.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-/Applications/Colonies.app}"
OUT="${2:-$HERE/out}"
EXPECTED_VERSION="1.3.13"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*" >&2; }

[ -e "$SRC" ] || die "source not found: $SRC"

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

# 1. Get a directory to search in.
if [ -d "$SRC" ]; then
  SEARCH="$SRC"
else
  case "$SRC" in
    *.ipa|*.zip|*.IPA|*.ZIP) ;;
    *) die "unsupported source (expected a directory, .ipa or .zip): $SRC" ;;
  esac
  TMP="$(mktemp -d)"
  info "unpacking $SRC"
  # Only the bits we need; skip AppleDouble files.
  unzip -q "$SRC" '*/www/*' '*/Info.plist' '*/config.xml' -x '__MACOSX/*' -d "$TMP" \
    || die "unzip failed"
  SEARCH="$TMP"
fi

# 2. Find the bundle: the directory that holds www/js/index.min.js.
INDEX="$(find "$SEARCH" -path '*/www/js/index.min.js' -not -path '*/__MACOSX/*' -print -quit)"
[ -n "$INDEX" ] || die "www/js/index.min.js not found under $SEARCH (is this the Colonies app?)"
APP="$(dirname "$(dirname "$(dirname "$INDEX")")")"
if [ -n "$TMP" ]; then info "app bundle: (archive)/${APP#"$TMP"/}"; else info "app bundle: $APP"; fi

[ -f "$APP/Info.plist" ] || die "Info.plist missing in $APP"
VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist" 2>/dev/null \
  || python3 -I -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleShortVersionString"])' "$APP/Info.plist")"
BUNDLE_ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$APP/Info.plist" 2>/dev/null \
  || python3 -I -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleIdentifier"])' "$APP/Info.plist")"
info "bundle $BUNDLE_ID, version $VERSION"
[ "$BUNDLE_ID" = "com.threeheadedmonster.beyondhumanity.colonies.companion" ] || die "unexpected bundle id"
[ "$VERSION" = "$EXPECTED_VERSION" ] || echo "warning: version $VERSION, expected $EXPECTED_VERSION (checksums and module numbers will not match)" >&2

# 3. Copy into OUT/app-snapshot.
SNAP="$OUT/app-snapshot"
[ -e "$SNAP" ] && die "$SNAP already exists; remove it or pick another OUT_DIR"
mkdir -p "$SNAP"
info "copying www/, Info.plist, config.xml → $SNAP"
cp -R "$APP/www" "$SNAP/www"
cp "$APP/Info.plist" "$APP/config.xml" "$SNAP/"
find "$SNAP" \( -name '.DS_Store' -o -name '._*' \) -delete

# 4. Verify against the manifest.
info "verifying against SHA256SUMS"
(
  cd "$OUT"
  grep '  app-snapshot/' "$HERE/SHA256SUMS" > "$OUT/.sums-app"
  bad=$(shasum -a 256 -c "$OUT/.sums-app" 2>/dev/null | grep -vc ': OK$' || true)
  total=$(wc -l < "$OUT/.sums-app" | tr -d ' ')
  extra=$(comm -13 <(sed 's/^[0-9a-f]*  //' "$OUT/.sums-app" | sort) \
                   <(find app-snapshot -type f | sort) | wc -l | tr -d ' ')
  rm -f "$OUT/.sums-app"
  if [ "$bad" = 0 ] && [ "$extra" = 0 ]; then
    echo "    app-snapshot: all $total files match" >&2
  else
    echo "    app-snapshot: $bad of $total files differ or are missing, $extra extra files" >&2
    echo "    (run: cd $OUT && shasum -a 256 -c $HERE/SHA256SUMS | grep -v OK)" >&2
  fi
)

[ "${SKIP_DEOB:-0}" = 1 ] && { info "SKIP_DEOB=1, done"; exit 0; }

# 5. Deobfuscate with the locked webcrack (Node 22; isolated-vm does not build on newer Node).
info "installing webcrack (npm ci) and deobfuscating index.min.js"
if command -v mise >/dev/null 2>&1; then
  RUN=(mise exec --cd "$HERE" --)
else
  node -v | grep -q '^v22\.' || echo "warning: Node 22 recommended (no mise found), have $(node -v)" >&2
  RUN=()
fi
(cd "$HERE" && ${RUN[@]+"${RUN[@]}"} npm ci --silent --no-audit --no-fund)
(cd "$HERE" && ${RUN[@]+"${RUN[@]}"} npx --no-install webcrack "$SNAP/www/js/index.min.js" -o "$OUT/deob" -f)

(
  cd "$OUT"
  grep '  deob/' "$HERE/SHA256SUMS" > "$OUT/.sums-deob"
  bad=$(shasum -a 256 -c "$OUT/.sums-deob" 2>/dev/null | grep -vc ': OK$' || true)
  total=$(wc -l < "$OUT/.sums-deob" | tr -d ' ')
  rm -f "$OUT/.sums-deob"
  if [ "$bad" = 0 ]; then
    echo "    deob: all $total files match (module numbers like 3488.js are valid)" >&2
  else
    echo "    deob: $bad of $total files differ (different webcrack version?)" >&2
  fi
)
# 6. Readable names (names.json + export tables), same line numbers as deob/.
info "naming identifiers → $OUT/annotated"
(cd "$HERE" && ${RUN[@]+"${RUN[@]}"} node annotate.mjs "$OUT/deob" "$OUT/annotated" names.json)
(cd "$HERE" && ${RUN[@]+"${RUN[@]}"} node map.mjs "$OUT/annotated" "$OUT/map.md" names.json)

# 7. Reading view: wakaru turns Babel output back into modern JS (async/await, classes, let/const). Line numbers change
#    and the result is ES modules, so it is for reading only; patches go on deob/. Skipped where wakaru has no binary.
WAKARU="$(cd "$HERE" && ${RUN[@]+"${RUN[@]}"} node -e 'try { process.stdout.write(require.resolve("@wakaru/cli-" + process.platform + "-" + process.arch + "/wakaru" + (process.platform === "win32" ? ".exe" : ""))) } catch {}')"
if [ -n "$WAKARU" ]; then
  info "reading view (wakaru) → $OUT/readable"
  mkdir -p "$OUT/readable"
  : > "$OUT/readable/wakaru.log"
  for f in "$OUT/annotated"/[0-9]*.js; do
    b="$(basename "$f")"
    "$WAKARU" "$f" -o "$OUT/readable/$b" 2>>"$OUT/readable/wakaru.log" \
      || { cp "$f" "$OUT/readable/$b"; echo "    wakaru failed on $b, kept the annotated version" >&2; }
  done
else
  echo "    wakaru not available for this platform, skipping $OUT/readable" >&2
fi
info "done: $OUT/app-snapshot, $OUT/deob, $OUT/annotated, $OUT/map.md${WAKARU:+, $OUT/readable}"
