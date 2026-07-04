#!/bin/zsh
# Dev build: assembles Certify.app (current arch, ad-hoc signed) into ./build
set -euo pipefail
cd "$(dirname "$0")"

SERVER_SRC="${CERTIFY_SERVER_SRC:-$PWD/server}"
[ -d "$SERVER_SRC/node_modules" ] || (cd "$SERVER_SRC" && npm install --omit=dev)
[ -f assets/node ] || ./assets/fetch-node.sh

swift build -c release

# Assemble and sign outside iCloud-synced folders (the file provider
# re-stamps xattrs that break codesign), then copy back.
STAGE=$(mktemp -d /tmp/certify-build.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
STAGED_APP="$STAGE/Certify.app"

mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources/server"
cp .build/release/Certify "$STAGED_APP/Contents/MacOS/Certify"
cp Info.plist "$STAGED_APP/Contents/Info.plist"
cp AppIcon.icns "$STAGED_APP/Contents/Resources/AppIcon.icns"
cp assets/node "$STAGED_APP/Contents/Resources/node"

cp "$SERVER_SRC/server.js" "$SERVER_SRC/package.json" "$STAGED_APP/Contents/Resources/server/"
cp -R "$SERVER_SRC/public" "$STAGED_APP/Contents/Resources/server/public"
cp -R "$SERVER_SRC/node_modules" "$STAGED_APP/Contents/Resources/server/node_modules"

mkdir -p "$STAGED_APP/Contents/Frameworks"
ditto .build/release/Sparkle.framework "$STAGED_APP/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath @executable_path/../Frameworks "$STAGED_APP/Contents/MacOS/Certify"
xattr -cr "$STAGED_APP"

codesign --force --deep --sign - "$STAGED_APP/Contents/Frameworks/Sparkle.framework"
codesign --force --sign - "$STAGED_APP/Contents/Resources/node"
codesign --force --sign - "$STAGED_APP"

APP=build/Certify.app
rm -rf "$APP"
mkdir -p build
ditto "$STAGED_APP" "$APP"

echo "Built $APP"
