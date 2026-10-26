#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="$repo_dir/tools/native-probe"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/miband-spp.XXXXXX")"
trap 'rm -rf -- "$probe_dir"' EXIT
if [[ $# -lt 1 ]]; then echo 'Usage: run-spp.sh /path/to/manifest.sqlite-wal | --offline-test' >&2; exit 64; fi
"$repo_dir/node_modules/.bin/esbuild" "$source_dir/spp-probe.ts" --bundle --platform=node --format=esm \
  "--alias:miband-source=$repo_dir/src" "--outfile=$probe_dir/spp-probe.mjs"
cp "$source_dir/extract-key.py" "$probe_dir/extract-key.py"
if [[ "$1" == '--offline-test' ]]; then
  "$repo_dir/node_modules/.bin/esbuild" "$source_dir/MockSPP.ts" --bundle --platform=node --format=cjs \
    "--alias:miband-source=$repo_dir/src" "--alias:miband-test=$repo_dir/test" \
    '--banner:js=#!/usr/bin/env node' "--outfile=$probe_dir/mock-spp"
  cp "$source_dir/spp-smoke.py" "$probe_dir/spp-smoke.py"
  python3 "$probe_dir/spp-smoke.py"
  exit 0
fi
clang -fobjc-arc -fmodules -framework Foundation -framework IOBluetooth \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/Info.plist" \
  "$source_dir/NativeSPP.m" -o "$probe_dir/native-spp"
node "$probe_dir/spp-probe.mjs" "$@"
