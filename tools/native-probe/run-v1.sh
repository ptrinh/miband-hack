#!/bin/bash
# Mi Band 8 (BLE V1) from the terminal: MIBAND_AUTH_KEY=<hex> bash tools/native-probe/run-v1.sh [--match "band 8"] [--install file]
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="$repo_dir/tools/native-probe"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/miband-v1.XXXXXX")"
trap 'rm -rf -- "$probe_dir"' EXIT
"$repo_dir/node_modules/.bin/esbuild" "$source_dir/v1-test.ts" --bundle --platform=node --format=esm --log-level=warning \
  "--alias:miband-source=$repo_dir/src" "--outfile=$probe_dir/v1-test.mjs"
swiftc -module-cache-path "$probe_dir/swift-cache" -framework CoreBluetooth \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/Info.plist" \
  "$source_dir/NativeBLEV1.swift" -o "$probe_dir/native-ble-v1"
node "$probe_dir/v1-test.mjs" "$@"
