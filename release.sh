#!/bin/zsh
# Builds a signed, notarized, universal Certify.app ready to share.
# Uses the same Developer ID certificate and notary profile as KeyType.
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="${CERTIFY_IDENTITY:-Developer ID Application}"
PROFILE="${CERTIFY_NOTARY_PROFILE:-keytype-notary}"
SERVER_SRC="${CERTIFY_SERVER_SRC:-$PWD/server}"
APP=build/Certify.app
ZIP=build/Certify.zip

[ -d "$SERVER_SRC/node_modules" ] || (cd "$SERVER_SRC" && npm install --omit=dev)
[ -f assets/node ] || ./assets/fetch-node.sh

echo "==> Building universal binary (arm64 + x86_64)"
swift build -c release --arch arm64 --arch x86_64

# Assemble and sign outside iCloud-synced folders (the file provider
# re-stamps xattrs that break codesign).
STAGE=$(mktemp -d /tmp/certify-release.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
STAGED_APP="$STAGE/Certify.app"
STAGED_ZIP="$STAGE/Certify.zip"

echo "==> Assembling ${STAGED_APP}"
mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources/server"
cp .build/apple/Products/Release/Certify "$STAGED_APP/Contents/MacOS/Certify"
cp Info.plist "$STAGED_APP/Contents/Info.plist"
cp AppIcon.icns "$STAGED_APP/Contents/Resources/AppIcon.icns"
cp assets/node "$STAGED_APP/Contents/Resources/node"
cp "$SERVER_SRC/server.js" "$SERVER_SRC/package.json" "$STAGED_APP/Contents/Resources/server/"
cp -R "$SERVER_SRC/public" "$STAGED_APP/Contents/Resources/server/public"
cp -R "$SERVER_SRC/node_modules" "$STAGED_APP/Contents/Resources/server/node_modules"
xattr -cr "$STAGED_APP"

echo "==> Signing with '${IDENTITY}' (hardened runtime)"
# The bundled Node runtime is a nested executable: sign it first, with the
# JIT entitlements V8 needs under the hardened runtime.
codesign --force --options runtime --timestamp \
    --entitlements node.entitlements \
    --sign "$IDENTITY" "$STAGED_APP/Contents/Resources/node"
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$STAGED_APP"
codesign --verify --strict --verbose=2 "$STAGED_APP"

echo "==> Notarizing (profile: ${PROFILE})"
ditto -c -k --keepParent "$STAGED_APP" "$STAGED_ZIP"
xcrun notarytool submit "$STAGED_ZIP" --keychain-profile "$PROFILE" --wait

echo "==> Stapling notarization ticket"
xcrun stapler staple "$STAGED_APP"

rm -f "$STAGED_ZIP"
ditto -c -k --keepParent "$STAGED_APP" "$STAGED_ZIP"
rm -rf "$APP" "$ZIP"
mkdir -p build
ditto "$STAGED_APP" "$APP"
cp "$STAGED_ZIP" "$ZIP"

echo ""
echo "Done. Share ${ZIP} — it opens on any Mac (macOS 13+) with no warnings."
spctl --assess --type execute --verbose "$APP" || true
