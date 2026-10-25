# Phone Remote (demo quick app for Mi Band 9 / 10 + Android companion)

Three big buttons on the band that make the phone act:

| Band button | What the phone does |
|---|---|
| **Shutter** | Takes a photo in the companion app's camera screen (saved to `Pictures/MiBand Remote`) |
| **Prev / Next** | Left / Right arrow key on a laptop the phone is connected to as a Bluetooth keyboard (slides in PowerPoint, Keynote, Google Slides, PDF viewers). With no laptop connected: previous / next track on the phone |
| **Play / Pause** | Media play/pause key on the phone (whatever app holds the media session: Spotify, YouTube, podcasts…) |

The band shows the link state (green dot = phone app reachable), what Prev/Next will drive ("Slides: MacBook" or
"Slides: media keys"), and the result of each press. Each press gives a short vibration and a purple flash; an error
gives a long vibration. MIT License.

```
band/      Vela JS quick app (.ux) → uk.trinh.miband.remote.release.1.0.0.rpk
android/   Kotlin companion app, package uk.trinh.miband.remote (same id, same certificate: required)
```

## How the band reaches the phone (feasibility)

A quick app cannot act on the phone by itself. Options checked on 25/10/2026:

| Option | Verdict |
|---|---|
| **a) `@system.interconnect` → Android app using Xiaomi's phone SDK, relayed by Mi Fitness** | **Chosen.** Official, documented path. Requirements below. |
| b) Band as a Bluetooth HID (keyboard / media keys / volume-up shutter) | Not possible. No quick-app API for HID or BLE GATT; the Vela feature list has nothing like it. |
| c) Trigger the band's built-in camera remote / music control | Those system features exist, but we found no quick-app API that starts them or sends their commands. They also cannot do slides. Use them directly if they cover your case. |
| d) Own Android app talking to the band over Bluetooth directly (Gadgetbridge-style) | Not realistic now. Gadgetbridge's Xiaomi protobuf (`xiaomi.proto`, `wear_thirdparty_app.proto`) only covers installing/listing/removing rpk apps, not the messages a quick app sends; that format would have to be reverse-engineered from Mi Fitness. It would also replace Mi Fitness and need the band's auth key. |

How option a) works, from the Vela docs and Xiaomi's own interconnect demo:

- Band side: `@system.interconnect` → `instance()`, `send({data})`, `onmessage`, `onopen`, `onclose`, `onerror`
  (`1001` = phone app not installed), `getReadyState()` (`1` connected).
  [Vela docs: Interconnect](https://iot.mi.com/vela/quickapp/en/features/network/interconnect.html)
- Phone side: Xiaomi's "XMS Wearable" SDK (`xms-wearable-lib_1.4_release.aar`, from the
  [interconnect demo zip](https://cdn.cnbj3-fusion.fds.api.mi-img.com/quickapp-vela/interconnect_dev_test_demo.zip) linked
  in those docs). The SDK binds to **Mi Fitness** (`com.xiaomi.wearable`; `com.mi.health` = 小米运动健康 in China), which owns
  the band connection: `NodeApi.getConnectedNodes` → `AuthApi.requestPermission(DEVICE_MANAGER)` (the user confirms) →
  `MessageApi.addListener` / `sendMessage(bytes)`.
- The docs require the quick app's `package` to equal the Android `applicationId`, and both to be **signed with the same
  certificate**. They mention no developer registration or whitelist. An independent Mi Band 9 Pro project
  ([VoidTerminal-Vela](https://gitea.com/sisheng-mirror-4/VoidTerminal-Vela)) describes the same requirements and also
  says Mi Fitness must stay logged in and connected to the band.

**Not confirmed by anyone we could find:** that Mi Band 9 / 10 firmware ships `system.interconnect` (the docs give no
per-device table; the vibrator page, for comparison, does list Band 9 / 10), and that Mi Fitness relays messages for a
**sideloaded** quick app. If the band lacks the module, the app opens and shows "No phone link on this band".

## Setup

1. **Build the band app** (or use a built rpk) and install it with MiBand Hack (*Or install your own file*). Installing
   needs the phone's Bluetooth off; turn it back on afterwards so Mi Fitness reconnects to the band.
2. **Build and install the Android app** (below), open **MiBand Remote**, press **Start**, allow Bluetooth and
   notifications, then confirm the permission request from Mi Fitness. "Band: Listening to …" means the link is up.
3. Open **Phone Remote** on the band: the dot turns green and it says "Phone connected".
4. Photos: press **Open camera** on the phone, put the phone on its stand, press **Shutter** on the band.
   The camera screen must stay in front (Android does not let background apps use the camera).
5. Slides: on the laptop, pair with the phone (press *Slides: let a computer pair with this phone* to make it visible),
   then press *Slides: connect to a computer…* and pick the laptop. The band shows "Slides: <laptop>". The laptop sees
   a keyboard called "MiBand Remote"; next time the app reconnects to it by itself.
6. The **Try without the band** row on the phone runs each action locally, to check the phone side on its own.

## Band ↔ phone messages

UTF-8 JSON (band: `src/common/remote.js`, phone: `Protocol.kt`; keep them in sync):

```
band → phone   {"v":1,"id":7,"cmd":"shutter"|"prev"|"next"|"playpause"|"hello"}
phone → band   {"v":1,"id":7,"ok":true,"did":"photo"|"slide"|"track"|"media"|"hello","laptop":"MacBook","camera":true}
               {"v":1,"id":7,"ok":false,"error":"camera-closed"|"no-target"|"unknown-command"|"failed","laptop":null,"camera":false}
               {"v":1,"laptop":…,"camera":…}   pushed when the laptop or the camera screen changes
```

The band waits 3 s for a reply, then shows "No reply from phone".

## Rebuild

Needs Node >= 18 for the band app; JDK 17–21 and the Android SDK (platform 35) for the phone app.

```bash
cd demo-apps/phone-remote/band
npm install                # aiot-toolkit 2.0.5, ~355 MB; or use ../../calculator/node_modules/.bin/aiot
npm test                   # wire-format checks (plain node)
npm run release            # copies ../../../src/rpk/demo-key/*.pem to sign/, builds dist/uk.trinh.miband.remote.release.1.0.0.rpk

cd ../android
./fetch-sdk.sh             # downloads Xiaomi's demo zip, checks SHA-256, puts the SDK .aar in app/libs/ (not committed)
./make-keystore.sh         # keystore/demo-key.p12 from the same demo key the band app is signed with
./gradlew testDebugUnitTest assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

The toolkit compiles inside a temporary sibling folder `../.temp_band` and removes it when done.

### Signing key

Both halves are signed with the repo's **public demo key** (`src/rpk/demo-key`, see the README there), because
interconnect only links an app and a quick app that share a certificate. Anyone can sign with that key, so any app
built from it can talk to this band app. That is acceptable for a demo remote. For your own build, use your own key for
both: copy your `private.pem` / `certificate.pem` into `band/sign/` and run `npx aiot release` (not `npm run release`,
which copies the demo key over them), then
`KEY_DIR=/path/to/your/pems ./make-keystore.sh`. Keep the key: an update signed differently may be refused by the band
and by Android.

## Limits

- Needs **Mi Fitness** on the phone, logged in and connected to the band. Not compatible with Gadgetbridge (no Mi Fitness
  → nothing relays interconnect).
- Android only: Xiaomi's phone SDK is an Android library; the docs offer nothing for iOS.
- Shutter only works in this app's camera screen. Pressing another camera app's shutter would need an accessibility
  service tapping the screen, which is fragile across camera apps and was left out.
- Slides need a phone whose Android build includes the Bluetooth HID Device profile (Android 9+, but some makers remove
  it; the app then says so and Prev/Next skip tracks).
- Not in the MiBand Hack catalog (`public/apps/`): the band app is useless without the companion APK, and the
  interconnect link is unverified on Mi Band 9 / 10.

## Status

Band app: builds with no toolkit warnings, signature verified with `src/rpk` (`verifyRpk`), wire format checked by
`npm test`. Android app: builds, unit tests pass, APK signed with the demo certificate (same SHA-256 as the rpk's).
**Nothing has been run on a real band, phone or the Vela emulator**: the interconnect link, the Mi Fitness permission
prompt, the HID keyboard and the camera capture are all untested.
