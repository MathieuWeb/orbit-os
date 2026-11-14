#!/bin/zsh
# Builds "Orbit OS.app" and installs it in /Applications.
# Usage: npm run install:app
set -e
cd "$(dirname "$0")/.."
APP="Orbit OS.app"
# App icon: render the SVG to a 1024px PNG (electron-builder turns it into .icns), then clear the corners.
[ -f build/icon.png ] || { qlmanage -t -s 1024 -o build build/icon.svg >/dev/null && mv build/icon.svg.png build/icon.png && python3 scripts/icon-mask.py build/icon.png; }
npm run dist
# Local (ad hoc) signature: needed on Apple Silicon after packaging.
codesign --force --deep --sign - "dist/mac-arm64/$APP"
osascript -e 'tell application "Orbit OS" to quit' 2>/dev/null || true
# The app used to be called "AI Terminal": remove that old copy so there is only one.
osascript -e 'tell application "AI Terminal" to quit' 2>/dev/null || true
sleep 1
rm -rf "/Applications/$APP" "/Applications/AI Terminal.app"
ditto "dist/mac-arm64/$APP" "/Applications/$APP"
# Remove the build copy so Spotlight and Launchpad list the app only once.
rm -rf dist/mac-arm64
echo "✔ Installed in /Applications/$APP"
