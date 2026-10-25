# Drawing (demo quick app for Mi Band 9 / 10)

Finger-drawing app written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
Demo app for MiBand Hack (`public/apps/drawing.rpk`). MIT License.

- Package: `uk.trinh.miband.drawing`, name `Drawing`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` (same as the calculator demo)
- Feature used: `system.storage` (the last drawing is saved and restored)

## How it draws (no `<canvas>`)

Xiaomi's Vela component docs (iot.mi.com/vela/quickapp, Components section) list no `<canvas>` component.
The toolkit's parser accepts a `canvas` tag, but nothing documents a 2D context on Vela. So every stroke is a chain of
small round `div`s (`position: absolute`) placed along the finger path. `src/common/sketch.js` does the work:
- fills in points between touch samples, so fast swipes still give a continuous line with round caps and joins
- skips near-duplicate dots
- caps the drawing at 1000 dots (`MAX_DOTS`) to keep the band's UI tree small

Toolbar: 5 colours, brush size S/M/L (tap the dot to cycle), Erase (removes dots under the finger), Undo (last drawn stroke),
Clear (tap twice).

Back gesture: a stroke that starts in the 12 px strip at the left edge is not drawn, so the system swipe-right-to-go-back
still works from there. `onBackPress` blocks a back that fires during a stroke or within 400 ms after it.

## Rebuild

Needs Node >= 18. Toolchain: Xiaomi's official `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/drawing
npm install
npm test                       # engine checks (plain node)
mkdir -p sign && cp ../calculator/sign/*.pem sign/   # same self-signed key as the calculator; sign/ is gitignored
npm run release                # dist/uk.trinh.miband.drawing.release.1.0.0.rpk
cp dist/uk.trinh.miband.drawing.release.1.0.0.rpk ../../public/apps/drawing.rpk
cp src/common/logo.png ../../public/apps/drawing.png
```

`npm run build` makes a debug rpk instead, signed with the toolkit's built-in debug key.

Status: builds and package structure verified; not yet tested on a real band.
