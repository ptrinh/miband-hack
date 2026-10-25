# Developing MiBand Hack

## Setup

You need **Node.js 22+** (the latest LTS is recommended), Git, and Chrome/Edge.

```bash
git clone https://github.com/ptrinh/miband-hack.git
cd miband-hack
npm install
npm test            # should report "Tests 20 passed" or more
npm run dev         # open http://localhost:5173
```

Browsers treat `localhost` as secure, so Web Serial and Web Bluetooth work without HTTPS.

To also run the QR key retrieval (`/api/xiaomi/*`, which runs on a Cloudflare Worker):

```bash
npm run dev:worker  # build, then run the Worker + page at http://localhost:8787
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (frontend only) |
| `npm run dev:worker` | Run the Worker locally via `wrangler dev` |
| `npm test` | Vitest: crypto, packets, parsers, simulated band, Xiaomi request signing |
| `npm run typecheck` | TypeScript for both `src/` and `worker/` |
| `npm run build` | Typecheck + build to `dist/` |
| `npm run deploy` | Build + `wrangler deploy` (needs Cloudflare access, see README) |

## Code map

```
src/
  main.ts              UI (plain DOM, no framework)
  device.ts            Orchestration: auth → device info → app list → install
  core/
    auth.ts            "miwear-auth" handshake, key derivation, AES-CCM (V1) / AES-CTR (V2)
    crypto.ts          Hand-written AES-CCM (WebCrypto has no CCM), HMAC, MD5
    packets.ts         Encode/decode SPP V1 and V2 frames
    proto.ts           Trimmed protobuf schema (field numbers kept as in Gadgetbridge)
    files.ts           Read .rpk (zip + manifest.json) and watchface .bin
  transport/
    serial.ts          Web Serial → Bluetooth Classic SPP (Mi Band 9/10)
    ble.ts             Web Bluetooth, auto-detects BLE V1 (Mi Band 8) or V2 (9 Active)
  protocol/
    stream-link.ts     SPP V1/V2: version probe, sliding window, ack/nack, retransmit
    ble-v1-link.ts     Mi Band 8 chunk protocol
  rpk/                 Repack + re-sign .rpk in the browser (used for Notes)
  i18n.ts              EN / 中文 / VI dictionaries and the t() function
worker/
  index.ts             Serves dist/ + API /api/xiaomi/qr, /api/xiaomi/poll
  xiaomi-cloud.ts      Xiaomi QR login, RC4 request signing, BLE key retrieval
public/apps/           Demo apps (catalog.json + .rpk) shown in the "Demo apps" section
demo-apps/             Demo app sources
test/
  fake-band.ts         Simulated band: band side uses node:crypto, independent of the main code
```

Protocol notes (strongly recommended reading before changing `core/` or `protocol/`): [docs/protocol.md](docs/protocol.md).

## Rules

- **Every protocol change needs a test.** Add cases to `test/fake-band.ts` if the simulated band needs to do something new.
- Data from the band or from files (app names, manifests…) **must only go into the DOM via `textContent`**, never via `innerHTML`.
- Don't log or store Xiaomi tokens in the Worker.
- Don't add firmware flashing (risk of bricking the band).

## Testing with a real band

1. Get the auth key (the QR button on the page, or following [Gadgetbridge](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/)).
2. Turn off Bluetooth on your phone.
3. Mi Band 9/10: pair the band in the OS Bluetooth settings first.
4. `npm run dev` → connect → watch the **Connection log** on the page and the DevTools Console.
5. Report odd behaviour with logs in an issue. Especially important: whether the band takes the SPP V2 path, what the chunk size is, and whether there are NACKs.

## Adding a demo app

1. Put the source in `demo-apps/<name>/`, with a README describing how to build it.
2. Copy the `.rpk` file and icon into `public/apps/`.
3. Add an entry to `public/apps/catalog.json` (`description` can be a string or `{en, zh, vi}`).

Each demo app has its own `node_modules` of about 355 MB (aiot-toolkit). Delete it after building if you're short on disk space.

## Adding UI text

All visible text lives in `src/i18n.ts`; every key must have all 3 languages `en`, `zh`, `vi` (TypeScript errors if one is missing).
