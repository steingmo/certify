#!/bin/zsh
# Downloads the official Node.js 22 macOS binaries (arm64 + x64) and merges
# them into a universal binary at assets/node. The ~110 MB result is not
# committed to git — run this once after cloning.
set -euo pipefail
cd "$(dirname "$0")"

TARBALL=$(curl -s https://nodejs.org/dist/latest-v22.x/ \
    | grep -oE 'node-v22\.[0-9.]+-darwin-arm64\.tar\.gz' | head -1)
VERSION=${TARBALL#node-}
VERSION=${VERSION%-darwin-arm64.tar.gz}

STAGE=$(mktemp -d /tmp/certify-node.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

echo "==> Downloading Node ${VERSION} (arm64 + x64)"
for arch in arm64 x64; do
    curl -sSL "https://nodejs.org/dist/latest-v22.x/node-v${VERSION}-darwin-${arch}.tar.gz" \
        -o "$STAGE/node-${arch}.tar.gz"
    tar xzf "$STAGE/node-${arch}.tar.gz" -C "$STAGE" "node-v${VERSION}-darwin-${arch}/bin/node"
done

lipo -create \
    "$STAGE/node-v${VERSION}-darwin-arm64/bin/node" \
    "$STAGE/node-v${VERSION}-darwin-x64/bin/node" \
    -output node
lipo -info node
./node --version
