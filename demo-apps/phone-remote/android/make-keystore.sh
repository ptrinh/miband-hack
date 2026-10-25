#!/bin/sh
# Interconnect only links a band quick app with a phone app that has the same package name AND the same
# signing certificate. The band app (../band, `npm run release`) is signed with the repo's PUBLIC demo key
# in src/rpk/demo-key, so this script wraps that same key + certificate in a PKCS#12 keystore for Gradle.
# Anyone can sign with that key: fine for a demo, not for a real app (see ../README.md, "Own key").
set -eu
cd "$(dirname "$0")"
KEY_DIR="${KEY_DIR:-../../../src/rpk/demo-key}"
mkdir -p keystore
openssl pkcs12 -export -inkey "$KEY_DIR/private.pem" -in "$KEY_DIR/certificate.pem" \
  -name demo -passout pass:miband-demo -out keystore/demo-key.p12
echo "keystore/demo-key.p12 ready (alias demo, password miband-demo)"
