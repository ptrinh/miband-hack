# MiBand Hack

A webapp to **sideload apps (.rpk) and watchfaces (.bin) onto Mi Band 8 / 9 / 10 straight from the browser** on macOS, Windows and Linux. No software to install, no Android phone needed.

> Independent project, not affiliated with Xiaomi. The protocol is ported from [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) (AGPL-3.0).

**👉 Use it now: <https://miband.trinh.uk>** · [User guide](docs/GUIDE.md) · [Developer guide](CONTRIBUTING.md)

## Why

As of 10/2026, every existing way to sideload requires installing software:

| Tool | Platform | Notes |
|---|---|---|
| Notify for Xiaomi | Android | Paid app, has a tab for installing third-party apps |
| Gadgetbridge | Android | Open source, has RpkService |
| AstroBox-NG | Win / Linux / Android / iOS (native app) | Rust core, the Tauri app is closed source, no public web version yet |

MiBand Hack fills that gap: open a web page and install.

## Support

| Device | Connection | Browser API | Status |
|---|---|---|---|
| Mi Band 9, 10, 9 Pro, 10 Pro | Bluetooth Classic (SPP) | Web Serial (Chrome/Edge ≥ 117, desktop) | Implemented, not yet tested on a real device |
| Mi Band 9 Active | BLE V2 (`fe95` / `005e`, `005f`) | Web Bluetooth | Implemented, not yet tested on a real device |
| Mi Band 8 | BLE V1 (`fe95` / `0051`–`0055`) | Web Bluetooth | Implemented, not yet tested on a real device |

- Formats: `.rpk` (Vela quick app), watchface v2 (header `5A A5`). Watchface v3 and firmware are **deliberately not supported** (firmware can easily brick the band).
- Browser: desktop Chrome or Edge. Safari/Firefox have no Web Serial/Web Bluetooth.
- Linux: you may need to enable `chrome://flags/#enable-experimental-web-platform-features`.

## Usage

1. **Get the auth key**: press *"Get it automatically with your Xiaomi account"*, then scan the QR code with a phone signed in to Xiaomi. If no key comes out, see the [Gadgetbridge guide](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).
2. **Turn off Bluetooth on your phone** so the band is free to connect.
3. Mi Band 9/10: **pair the band** in the OS Bluetooth settings first.
4. Open the webapp → enter the key → **Connect** → drag and drop a `.rpk` file → **Install to band**.

## Demo apps (press Add to install)

| App | Description | Source |
|---|---|---|
| Calculator | Calculator + − × ÷, decimals | `demo-apps/calculator` |
| Drawing | Freehand drawing: 5 colours, 3 brush sizes, eraser, undo, autosave | `demo-apps/drawing` |
| Notes | Shows the user's notes (read-only). Notes are written in the webapp; the browser **repacks and re-signs the `.rpk`** and installs it | `demo-apps/notes` + `src/rpk/` |
| Snake | Snake game: swipe or tap the left/right half to turn, speeds up, saves the high score | `demo-apps/snake` |
| SAT Flashcards | Learn 372 SAT words: flip cards, Know it / Again, spaced repetition (Leitner boxes), progress saved on the band | `demo-apps/sat-flashcards` |
| Metronome | Silent metronome: the beat as a vibration on the wrist plus a flash, 30–250 BPM, tap tempo, accent on beat 1 in 2/4, 3/4, 4/4, 6/8 | `demo-apps/metronome` |

Outside the catalog: **Phone Remote** (`demo-apps/phone-remote`) — press on the band to take photos, change slides, play/pause on the phone. It needs the companion Android app (same package, same signature) and Mi Fitness to relay messages over `system.interconnect`; not yet verified on Mi Band 9/10, so it is not in the catalog yet.

All five catalog apps are built with `aiot-toolkit` 2.0.5 (Xiaomi Vela's official toolchain). **None has been run on a real band yet.**

`src/rpk/` is a WebCrypto port of aiot-toolkit's "RPK Sig Block 42" signature format (a variant of APK Signature Scheme v2, RSA PKCS#1 v1.5 + SHA-256). Tests confirm the signature is **byte-for-byte identical** to the one the toolkit produces. Notes is signed with a demo key that is **deliberately public** (`src/rpk/demo-key/`).

## Getting the key via QR: how it works

`worker/xiaomi-cloud.ts` is a port of the QR login flow from [Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) (MIT):
`/api/xiaomi/qr` creates the QR code, then `/api/xiaomi/poll` long-polls until the user scans it, gets the service token, lists devices and calls `blt_get_beaconkey`.
The login session (`ssecurity`/`serviceToken`) only lives within a single Worker request: it is not returned to the browser, not stored, and observability is off.
A proxy is needed because Xiaomi's API does not let browsers call it directly (CORS is blocked).

> **Unverified:** whether the key from the Mi Home cloud really is the Mi Band's auth key (beaconkeys of BLE sensors are usually only 24 hex long). The UI warns if the key is not 32 hex.

## Health data

Download what the band recorded (steps, heart rate, sleep, SpO₂, stress, workouts) as JSON, CSV or raw files, query it with your own AI agent through a local MCP server ([`tools/health-mcp`](tools/health-mcp/README.md)) Nothing leaves your machine. Format, privacy and what is still untested: [docs/health-data.md](docs/health-data.md).

## Deploy

One Worker serves both the static page (`dist/`) and `/api/*`, on the custom domain `miband.trinh.uk`:

```bash
echo 'CLOUDFLARE_ACCOUNT_ID=<your id>' > .env   # Wrangler reads this file itself; it is gitignored
npm run deploy
```

To deploy to a different domain, edit `routes` in `wrangler.jsonc`.

The page is a PWA (manifest + service worker): users press "Install as app" to get their own icon, and it opens even offline (except for the key retrieval step).

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (Web Serial/Bluetooth work on localhost)
npm run dev:worker # also runs the Worker (/api/xiaomi/*) at http://localhost:8787
npm test           # unit tests + integration tests against a simulated band
npm run build      # static build to dist/, deploy to any HTTPS host
```

### Structure

```
src/
  core/        bytes, checksum (CRC16/ARC, CRC32), crypto (hand-written AES-CCM, AES-CTR, HMAC),
               auth (miwear-auth handshake), proto (protobuf subset), packets (SPP V1/V2), files (.rpk/.bin)
  transport/   serial.ts (Web Serial → RFCOMM SPP), ble.ts (Web Bluetooth, auto-detects BLE V1/V2)
  protocol/    stream-link.ts (SPP V1/V2 + sliding window, used for both SPP and BLE V2),
               ble-v1-link.ts (Mi Band 8 chunk protocol)
  device.ts    auth, device info, app/watchface lists, install (DataUpload)
  main.ts      UI (including the "Demo apps" catalog read from public/apps/catalog.json)
worker/        Cloudflare Worker: serves the page + the Xiaomi QR key API
demo-apps/     demo app sources (Calculator)
test/
  core.test.ts         crypto checked against node:crypto, frame/protobuf vectors, file parsing
  fake-band.ts         simulated band (band-side crypto uses node:crypto, independent of the main code)
  integration.test.ts  version probe → SPP V2 → auth → end-to-end .rpk install
```

Protocol details: [docs/protocol.md](docs/protocol.md).

## Next steps

- [ ] Test on a real Mi Band 9/10 over Web Serial on macOS, Windows and Linux (the biggest risk, see the "Risks" section in the docs).
- [ ] Test Mi Band 8 and tune the BLE write size (default 180 bytes).
- [ ] App/watchface store (catalog + search + one-tap install).
- [ ] i18n (English / 中文).
- [ ] Confirm the QR-retrieved key works for the Mi Band. If not, look into the Mi Fitness API.

## License

AGPL-3.0-or-later, because the protocol code is a port of Gadgetbridge (AGPL-3.0). The Xiaomi login flow is ported from Xiaomi Cloud Tokens Extractor (MIT). See [LICENSE](LICENSE).
