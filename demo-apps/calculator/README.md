# Calculator (demo quick app for Mi Band 9 / 10)

Small calculator written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
Used as the one-click demo app in MiBand Hack (`public/apps/calculator.rpk`). MIT License.

- Package: `uk.trinh.miband.calculator`, name `Calculator`, version `1.0.0` (versionCode 1)
- `designWidth: 192` (Mi Band 9 is 192x490; on wider bands the framework scales px to screen width, layout is flex-based)
- `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` — same values as published Mi Band 9 quick apps
- No `features` used (no network / BLE / storage). Engine is in `src/common/calc.js` (pure JS; rounds to 10 significant digits, divide by zero -> `Error`)

## Rebuild

Requires Node >= 18 and `openssl` (only for release signing). Toolchain: Xiaomi's official `aiot-toolkit` (pinned 2.0.5, CLI `aiot`).

```bash
cd demo-apps/calculator
npm install
npm test                 # engine checks (plain node, not part of the main vitest suite)
npm run build            # debug: dist/uk.trinh.miband.calculator.debug.1.0.0.rpk, signed with the toolkit's built-in debug key
npm run release          # release: dist/uk.trinh.miband.calculator.release.1.0.0.rpk, signed with sign/private.pem + sign/certificate.pem
cp dist/uk.trinh.miband.calculator.release.1.0.0.rpk ../../public/apps/calculator.rpk
cp src/common/logo.png ../../public/apps/calculator.png
```

If `sign/` is missing, create a self-signed key pair first (command from the Vela docs):

```bash
mkdir -p sign && openssl req -newkey rsa:2048 -nodes -keyout sign/private.pem -x509 -days 3650 \
  -out sign/certificate.pem -subj "/CN=uk.trinh.miband.calculator"
```

Keep the same key for future versions: an update signed with a different certificate may be refused by the band.

Note: the toolkit compiles inside a temporary sibling folder `../.temp_calculator` and removes it when done.

Status: builds and package structure verified; not yet tested on a real band.
