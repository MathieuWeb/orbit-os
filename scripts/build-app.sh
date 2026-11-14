#!/bin/zsh
# Builds "AI Terminal.app" and installs it in /Applications.
# Usage: npm run install:app
set -e
cd "$(dirname "$0")/.."
APP="AI Terminal.app"
# App icon: render the SVG to a 1024px PNG (electron-builder turns it into .icns).
[ -f build/icon.png ] || { qlmanage -t -s 1024 -o build build/icon.svg >/dev/null && mv build/icon.svg.png build/icon.png; }
npm run dist
# Local (ad hoc) signature: needed on Apple Silicon after packaging.
codesign --force --deep --sign - "dist/mac-arm64/$APP"
osascript -e 'tell application "AI Terminal" to quit' 2>/dev/null || true
sleep 1
rm -rf "/Applications/$APP"
ditto "dist/mac-arm64/$APP" "/Applications/$APP"
echo "✔ Installed in /Applications/$APP"
