#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="$repo_dir/tools/native-probe"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/miband-native.XXXXXX")"
trap 'rm -rf -- "$probe_dir"' EXIT
if [[ $# -lt 1 ]]; then
  echo 'Usage: run.sh /path/to/manifest.sqlite-wal [--classic-first] | --offline-test' >&2
  exit 64
fi
"$repo_dir/node_modules/.bin/esbuild" "$source_dir/probe.ts" --bundle --platform=node --format=esm \
  "--alias:miband-source=$repo_dir/src" "--outfile=$probe_dir/probe.mjs"
cp "$source_dir/extract-key.py" "$probe_dir/extract-key.py"
if [[ "$1" == '--offline-test' ]]; then
  "$repo_dir/node_modules/.bin/esbuild" "$source_dir/MockBLE.ts" --bundle --platform=node --format=cjs \
    "--alias:miband-source=$repo_dir/src" "--alias:miband-test=$repo_dir/test" \
    '--banner:js=#!/usr/bin/env node' "--outfile=$probe_dir/mock-ble"
  cp "$source_dir/offline-smoke.py" "$probe_dir/offline-smoke.py"
  python3 "$probe_dir/offline-smoke.py"
else
  swiftc -module-cache-path "$probe_dir/swift-cache" -framework CoreBluetooth \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/Info.plist" \
    "$source_dir/NativeBLE.swift" -o "$probe_dir/native-ble"
  node "$probe_dir/probe.mjs" "$@"
fi
