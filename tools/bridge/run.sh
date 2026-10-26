#!/bin/bash
# Builds the IOBluetooth helper (once) and starts the local bridge for the webapp.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../native-probe"
mkdir -p "$here/build"
if [[ ! -x "$here/build/native-spp" || "$src/NativeSPP.m" -nt "$here/build/native-spp" ]]; then
  clang -fobjc-arc -fmodules -framework Foundation -framework IOBluetooth \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$src/Info.plist" \
    "$src/NativeSPP.m" -o "$here/build/native-spp"
fi
exec node "$here/bridge.mjs"
