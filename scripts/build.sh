#!/usr/bin/env bash
set -euo pipefail

echo "🌅 Building Horizon..."

# Clean
rm -rf dist
mkdir -p dist/chrome dist/firefox

# Chrome build
echo "  → Chrome..."
cp -r manifest.json newtab icons background.js dist/chrome/
cd dist/chrome
zip -r ../horizon-chrome.zip . > /dev/null
cd ../..

# Firefox build
echo "  → Firefox..."
cp -r manifest.json newtab icons background.js dist/firefox/
cd dist/firefox
zip -r ../horizon-firefox.zip . > /dev/null
cd ../..

echo ""
echo "✅ Build complete!"
echo "   Chrome:  dist/horizon-chrome.zip"
echo "   Firefox: dist/horizon-firefox.zip"
ls -lh dist/*.zip