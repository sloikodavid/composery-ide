#!/usr/bin/env bash
# Fetch the Apple-licensed assets the framing uses, into ./fonts/ and
# ./wallpapers/ (both gitignored, never committed): the real SF Pro text and
# SF Symbols glyphs, and the macOS Tahoe default wallpaper the MacBook frame
# puts behind the Safari window.
#
# Needs 7-Zip (to crack the .dmg -> .pkg -> cpio payloads). On Windows:
#   winget install -e --id 7zip.7zip
# Then: bash screenshots/fonts.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fonts wallpapers

# macOS Tahoe default wallpaper, light + dark (6K originals).
WP="https://raw.githubusercontent.com/LAYTAT/macOS-Wallpapers/fae15d0c4fc58790bc93de33699e0adbb0ca987f"
[ -f wallpapers/tahoe-light.png ] || curl -sL -o wallpapers/tahoe-light.png "$WP/26-Tahoe-Light-6K.png"
[ -f wallpapers/tahoe-dark.png ] || curl -sL -o wallpapers/tahoe-dark.png "$WP/26-Tahoe-Dark-6K.png"

SZ="$(command -v 7z || command -v 7za || echo '/c/Program Files/7-Zip/7z.exe')"
[ -x "$SZ" ] || { echo "7-Zip not found. Install it, then re-run."; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
CDN="https://devimages-cdn.apple.com/design/resources/download"

echo "Downloading SF Pro + SF Symbols (~700 MB)..."
curl -sL -o "$tmp/pro.dmg" "$CDN/SF-Pro.dmg"
curl -sL -o "$tmp/sym.dmg" "$CDN/SF-Symbols-7.dmg"

# SF Pro Text: dmg -> pkg -> Payload (cpio) -> Library/Fonts/*.otf
"$SZ" e -y "$tmp/pro.dmg" "SFProFonts/SF Pro Fonts.pkg" -o"$tmp" >/dev/null
"$SZ" e -y "$tmp/SF Pro Fonts.pkg" "SFProFonts.pkg/Payload" -o"$tmp" >/dev/null
"$SZ" x -y "$tmp/Payload" -o"$tmp/pro" >/dev/null
"$SZ" x -y "$tmp/pro/Payload~" -o"$tmp/pro_x" >/dev/null
cp "$tmp/pro_x/Library/Fonts/SF-Pro-Text-Semibold.otf" fonts/
cp "$tmp/pro_x/Library/Fonts/SF-Pro-Text-Regular.otf" fonts/

# SF Symbols: the symbol glyphs live in the app bundle's fallback font.
"$SZ" e -y "$tmp/sym.dmg" "SFSymbols/SF Symbols.pkg" -o"$tmp" >/dev/null
"$SZ" e -y "$tmp/SF Symbols.pkg" -o"$tmp/sym_pkg" >/dev/null
"$SZ" x -y "$tmp/sym_pkg/Payload" -o"$tmp/sym_p" >/dev/null
"$SZ" x -y "$tmp/sym_p/Payload~" -o"$tmp/sym_x" >/dev/null
cp "$tmp/sym_x/Applications/SF Symbols.app/Contents/Resources/Fonts/SFSymbolsFallback.otf" fonts/SF-Symbols.otf

hash() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
check() {
  [ "$(hash "$2")" = "$1" ] || { echo "Unexpected $2; downloaded assets changed. Refuse to render."; exit 1; }
}
check 2da7e3fdb744566f9c96a9a3e48949e8b24209fc0b9bcf1d101f5dc88359f065 fonts/SF-Pro-Text-Regular.otf
check 1314411ab8c720273a9b57a6ad1d51888bd14ec6db3569970078bfb27c002bd9 fonts/SF-Pro-Text-Semibold.otf
check bba5e09ec296a17e7dfc4644caa2e3b2b1524c5630a7dfd708140cc51628c7ca fonts/SF-Symbols.otf
check 29aa57a43f972ab28a0820031cde598d1a32ed5e70fe8418b0e35e37cb3827b4 wallpapers/tahoe-light.png
check 86a2b684a31b02dc12f054af48d061e9c2ec0b8f12f869926ace64c83f5018db wallpapers/tahoe-dark.png

echo "Done:"; ls -la fonts/
