#!/usr/bin/env bash
set -euo pipefail

# Build and bundle Clawdis into a minimal .app we can open.
# Outputs to dist/Clawdis.app

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$ROOT_DIR/dist/Clawdis.app"
BUILD_PATH="$ROOT_DIR/apps/macos/.build"
PRODUCT="Clawdis"
BUNDLE_ID="${BUNDLE_ID:-com.steipete.clawdis.debug}"
PKG_VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
BUILD_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BUILD_NUMBER=$(cd "$ROOT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
APP_VERSION="${APP_VERSION:-$PKG_VERSION}"
APP_BUILD="${APP_BUILD:-$GIT_BUILD_NUMBER}"
BUILD_CONFIG="${BUILD_CONFIG:-debug}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-AGCY8w5vHirVfGGDGc8Szc5iuOqupZSh9pMj/Qs67XI=}"
SPARKLE_FEED_URL="${SPARKLE_FEED_URL:-https://raw.githubusercontent.com/steipete/clawdis/main/appcast.xml}"
AUTO_CHECKS=true
if [[ "$BUNDLE_ID" == *.debug ]]; then
  SPARKLE_FEED_URL=""
  AUTO_CHECKS=false
fi

echo "📦 Ensuring deps (pnpm install)"
(cd "$ROOT_DIR" && pnpm install --no-frozen-lockfile --config.node-linker=hoisted)
if [[ "${SKIP_TSC:-0}" != "1" ]]; then
  echo "📦 Building JS (pnpm exec tsc)"
  (cd "$ROOT_DIR" && pnpm exec tsc -p tsconfig.json)
else
  echo "📦 Skipping TS build (SKIP_TSC=1)"
fi

cd "$ROOT_DIR/apps/macos"

echo "🔨 Building $PRODUCT ($BUILD_CONFIG)"
swift build -c "$BUILD_CONFIG" --product "$PRODUCT" --build-path "$BUILD_PATH"

BIN="$BUILD_PATH/$BUILD_CONFIG/$PRODUCT"
echo "pkg: binary $BIN" >&2
echo "🧹 Cleaning old app bundle"
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS"
mkdir -p "$APP_ROOT/Contents/Resources"
mkdir -p "$APP_ROOT/Contents/Resources/Relay"
mkdir -p "$APP_ROOT/Contents/Frameworks"

echo "📄 Copying Info.plist template"
INFO_PLIST_SRC="$ROOT_DIR/apps/macos/Sources/Clawdis/Resources/Info.plist"
if [ ! -f "$INFO_PLIST_SRC" ]; then
  echo "ERROR: Info.plist template missing at $INFO_PLIST_SRC" >&2
  exit 1
fi
cp "$INFO_PLIST_SRC" "$APP_ROOT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_BUILD}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :ClawdisBuildTimestamp ${BUILD_TS}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :ClawdisGitCommit ${GIT_COMMIT}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUFeedURL ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${SPARKLE_FEED_URL}" "$APP_ROOT/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" \
  || /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${SPARKLE_PUBLIC_ED_KEY}" "$APP_ROOT/Contents/Info.plist" || true
if /usr/libexec/PlistBuddy -c "Set :SUEnableAutomaticChecks ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist"; then
  true
else
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool ${AUTO_CHECKS}" "$APP_ROOT/Contents/Info.plist" || true
fi

echo "🚚 Copying binary"
cp "$BIN" "$APP_ROOT/Contents/MacOS/Clawdis"
chmod +x "$APP_ROOT/Contents/MacOS/Clawdis"
# SwiftPM outputs ad-hoc signed binaries; strip the signature before install_name_tool to avoid warnings.
/usr/bin/codesign --remove-signature "$APP_ROOT/Contents/MacOS/Clawdis" 2>/dev/null || true

SPARKLE_FRAMEWORK="$BUILD_PATH/$BUILD_CONFIG/Sparkle.framework"
if [ -d "$SPARKLE_FRAMEWORK" ]; then
  echo "✨ Embedding Sparkle.framework"
  cp -R "$SPARKLE_FRAMEWORK" "$APP_ROOT/Contents/Frameworks/"
  chmod -R a+rX "$APP_ROOT/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_ROOT/Contents/MacOS/Clawdis"
fi

echo "🖼  Copying app icon"
cp "$ROOT_DIR/apps/macos/Sources/Clawdis/Resources/Clawdis.icns" "$APP_ROOT/Contents/Resources/Clawdis.icns"

RELAY_DIR="$APP_ROOT/Contents/Resources/Relay"

if [[ "${SKIP_GATEWAY_PACKAGE:-0}" != "1" ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun missing. Install bun to package the embedded gateway." >&2
    exit 1
  fi

  echo "🧰 Building bundled relay (bun --compile)"
  mkdir -p "$RELAY_DIR"
	  RELAY_OUT="$RELAY_DIR/clawdis"
	  bun build "$ROOT_DIR/dist/macos/relay.js" \
	    --compile \
	    --bytecode \
	    --outfile "$RELAY_OUT" \
	    -e electron \
	    --define "__CLAWDIS_VERSION__=\\\"$PKG_VERSION\\\""
	  chmod +x "$RELAY_OUT"

  echo "🎨 Copying gateway A2UI host assets"
  rm -rf "$RELAY_DIR/a2ui"
  cp -R "$ROOT_DIR/src/canvas-host/a2ui" "$RELAY_DIR/a2ui"

  echo "🧠 Copying bundled skills"
  rm -rf "$RELAY_DIR/skills"
  cp -R "$ROOT_DIR/skills" "$RELAY_DIR/skills"

  echo "📄 Writing embedded runtime package.json (Pi compatibility)"
  cat > "$RELAY_DIR/package.json" <<JSON
{
  "name": "clawdis-embedded",
  "version": "$PKG_VERSION",
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
JSON

  echo "🎨 Copying Pi theme payload (optional)"
  PI_ENTRY_URL="$(cd "$ROOT_DIR" && node --input-type=module -e "console.log(import.meta.resolve('@mariozechner/pi-coding-agent'))")"
  PI_ENTRY="$(cd "$ROOT_DIR" && node --input-type=module -e "console.log(new URL(process.argv[1]).pathname)" "$PI_ENTRY_URL")"
  PI_DIR="$(cd "$(dirname "$PI_ENTRY")/.." && pwd)"
  THEME_SRC="$PI_DIR/dist/modes/interactive/theme"
  if [ -d "$THEME_SRC" ]; then
    rm -rf "$RELAY_DIR/theme"
    cp -R "$THEME_SRC" "$RELAY_DIR/theme"
  else
    echo "WARN: Pi theme dir missing at $THEME_SRC (continuing)" >&2
  fi
else
  echo "🧰 Skipping gateway payload packaging (SKIP_GATEWAY_PACKAGE=1)"
fi

echo "⏹  Stopping any running Clawdis"
killall -q Clawdis 2>/dev/null || true

echo "🔏 Signing bundle (auto-selects signing identity if SIGN_IDENTITY is unset)"
"$ROOT_DIR/scripts/codesign-mac-app.sh" "$APP_ROOT"

echo "✅ Bundle ready at $APP_ROOT"
