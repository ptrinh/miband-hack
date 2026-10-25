#!/bin/sh
# Downloads Xiaomi's "XMS Wearable" phone SDK (xms-wearable-lib 1.4) from the interconnect demo that the
# Vela docs link to (iot.mi.com/vela/quickapp → Features → Interconnect → Reference appendix), checks its
# SHA-256 and puts the .aar in app/libs/. The SDK is Xiaomi's and is not committed to this repo.
set -eu
cd "$(dirname "$0")"
URL="https://cdn.cnbj3-fusion.fds.api.mi-img.com/quickapp-vela/interconnect_dev_test_demo.zip"
ZIP_SHA256="8e3d74eebda558e2bef45e32f0965c5b77ef939a06cdc55136929f9427a95ca7"
AAR_SHA256="9c40fd1c5409bb948523d503af71e2978ae522c35636afe7d64f474c0f6bc195"
AAR="xms-wearable-lib_1.4_release.aar"

if [ -f "app/libs/$AAR" ] && [ "$(shasum -a 256 "app/libs/$AAR" | cut -d' ' -f1)" = "$AAR_SHA256" ]; then
  echo "app/libs/$AAR already present"
  exit 0
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/demo.zip" "$URL"
got="$(shasum -a 256 "$tmp/demo.zip" | cut -d' ' -f1)"
if [ "$got" != "$ZIP_SHA256" ]; then
  echo "SHA-256 mismatch for the Xiaomi demo zip: $got (expected $ZIP_SHA256)" >&2
  exit 1
fi
unzip -q -j -o "$tmp/demo.zip" "interconnect_dev_test_demo/libs/$AAR" -d "$tmp"
got="$(shasum -a 256 "$tmp/$AAR" | cut -d' ' -f1)"
if [ "$got" != "$AAR_SHA256" ]; then
  echo "SHA-256 mismatch for $AAR: $got" >&2
  exit 1
fi
mkdir -p app/libs
mv "$tmp/$AAR" "app/libs/$AAR"
echo "app/libs/$AAR ready"
