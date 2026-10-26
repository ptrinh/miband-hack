#!/bin/bash
# Install, start and uninstall each quick app in Xiaomi's Vela emulator (Mi Band 9 and 10 skins); exits 1 if any app
# fails to install, fails to start, logs a JS error or crashes the system. Run it before an app goes near a real band.
#   tools/emulator/preflight.sh                       # every public/apps/*.rpk, both AVDs
#   tools/emulator/preflight.sh --avd Vela_Band10 demo-apps/counter/dist/*.rpk
# Setup and limits: tools/emulator/README.md
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
gate="$HOME/ClaudeCode/tools/cpu-gate.sh"
if [[ -x "$gate" ]]; then "$gate"; fi
exec node "$repo_dir/tools/emulator/preflight.mjs" "$@"
