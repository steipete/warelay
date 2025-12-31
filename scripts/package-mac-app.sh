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

if [[ "${SKIP_UI_BUILD:-0}" != "1" ]]; then
  echo "🖥  Building Control UI (pnpm ui:build)"
  (cd "$ROOT_DIR" && pnpm ui:build)
else
  echo "🖥  Skipping Control UI build (SKIP_UI_BUILD=1)"
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

echo "📄 Writing Info.plist"
cat > "$APP_ROOT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${APP_BUILD}</string>
    <key>CFBundleName</key>
    <string>Clawdis</string>
    <key>CFBundleExecutable</key>
    <string>Clawdis</string>
    <key>CFBundleIconFile</key>
    <string>Clawdis</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>com.steipete.clawdis.deeplink</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>clawdis</string>
            </array>
        </dict>
    </array>
    <key>ClawdisBuildTimestamp</key>
    <string>${BUILD_TS}</string>
    <key>ClawdisGitCommit</key>
    <string>${GIT_COMMIT}</string>
    <key>SUFeedURL</key>
    <string>${SPARKLE_FEED_URL}</string>
    <key>SUPublicEDKey</key>
    <string>${SPARKLE_PUBLIC_ED_KEY}</string>
    <key>SUEnableAutomaticChecks</key>
    <${AUTO_CHECKS}/>
    <key>NSUserNotificationUsageDescription</key>
    <string>Clawdis needs notification permission to show alerts for agent actions.</string>
    <key>NSScreenCaptureDescription</key>
    <string>Clawdis captures the screen when the agent needs screenshots for context.</string>
    <key>NSCameraUsageDescription</key>
    <string>Clawdis can capture photos or short video clips when requested by the agent.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Clawdis needs the mic for Voice Wake tests and agent audio capture.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Clawdis uses speech recognition to detect your Voice Wake trigger phrase.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Clawdis needs Automation (AppleScript) permission to drive Terminal and other apps for agent actions.</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoadsInWebContent</key>
        <true/>
        <key>NSExceptionDomains</key>
        <dict>
            <key>100.100.100.100</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
        </dict>
    </dict>
</dict>
</plist>
PLIST

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

  echo "🎛  Copying Control UI assets"
  rm -rf "$RELAY_DIR/control-ui"
  cp -R "$ROOT_DIR/dist/control-ui" "$RELAY_DIR/control-ui"

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
