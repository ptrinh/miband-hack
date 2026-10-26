# Capture: Mi Band 10 with Mi Fitness on iOS

Bluetooth HCI capture of Mi Fitness on an iPhone binding and syncing a Mi Band 10, plus what the band
answered when this webapp tried to connect from a Mac. Captured 2026-10-25.

All key material, nonces, signatures, serial numbers and Bluetooth addresses are left out. Only message
layouts (field numbers and byte lengths), non-secret frames and observations are recorded here. To decode
your own capture, see [How to capture](#how-to-capture).

## Setup

| | |
|---|---|
| Band | Xiaomi Smart Band 10, model `miwear.watch.o66gl`, account region `sg` |
| Phone | iPhone 13 mini, iOS 27.0.1, Mi Fitness (App Store) |
| Computer | macOS, Chrome 155, Web Bluetooth |
| Transport | BLE, SPP V2 framing over the Xiaomi service (writes to one characteristic, notifications on another) |

## Findings

1. **Mi Fitness on iOS sends a longer session config** than Gadgetbridge and this webapp did: it adds
   TLV 7 (OS version), 5 (device type 1 = iOS) and 6 (device name), and uses other window and timeout
   values. See [Session config](#session-config).
2. **Auth step 1 from iOS carries only the 16-byte nonce.** It is the same as ours, and the band answered it
   with its watch nonce.
3. **From the Mac, the band refused auth step 1 with `error_code = 4` (NO_BOUND)**: `0801101a1a021804`
   (Command type 1, subtype 26, Account { 3: 4 }). This happened every time. We tried 9 variants of step 1:
   with and without `app_device_id` (Mi Fitness `phone_id`, the UUID part of it, both cases),
   `check_dynamic_code`, a session config with device type 1, and finally the exact iOS session config.
   It also happened after accepting the band's own BLE pairing prompt
   (`pair_request.setupwizard / accept_ble_request.system`, shown untranslated by the firmware).
   Error code names come from AstroBox-NG-Module-Pb `protos/xiaomi/wear_account.proto`.
4. **The band talks to its bound iPhone over its public address** (on a link bonded at the OS level). To the
   Mac it advertised a random address.
5. **After the band was re-bound to the iPhone, the Mac's GATT connect stopped completing.** The band was
   advertising (RSSI −38), but the connection never came up. During one such attempt the band froze, its
   screen went black and it rebooted by itself. We stopped testing after that.
6. **The auth key and phone identity sit in Mi Fitness's iOS cache:** `MHWCahe/<uid>/VirtualDevice_registerList/manifest.sqlite-wal`
   (`manifest.sqlite` itself is one empty page), in the `registerList_<region>` row.
   - The key is `encryptKey` (= `detail.encrypt_key` = `detail.token`).
   - The phone identity is `detail.phone_id` (= `virtualAppID`, format `UUID_10digits_12chars`).

   Re-binding the band changes both.

Conclusion: the tested browser AUTH variants failed with NO_BOUND, while the iPhone authenticated
with the same key. This does not yet distinguish an identity-specific gate from bond/link-security
requirements. Rechecking the HCI capture found encryption enabled before each successful AUTH exchange.

Native macOS also cannot explicitly initiate BLE pairing through CoreBluetooth; protected GATT access
may trigger OS pairing. A native client is therefore an experiment, not a guarantee of a new bond.

In the October 26 follow-up, the user accepted the band's pairing prompt and macOS reported
`paired=true` for the public-address IOBluetooth record. A fresh native BLE session still received
NO_BOUND for AUTH 26. BLE link encryption on that Mac session was not captured, so this does not yet
identify the exact firmware gate.

Updated analysis: [binding-research.md](../binding-research.md).
Native test results: [mi-band-10-native-macos.md](mi-band-10-native-macos.md).

## Session config

Frame type 2 (SESSION_CONFIG). Each payload is an opcode byte followed by TLVs: a 1-byte type, a 2-byte
little-endian length, then the value.

Mi Fitness iOS, phone → band (`opcode 1`):

```
01 | 01 0300 010000            1 version 1.0.0
   | 07 0300 1b0001            7 OS version 27.0.1
   | 02 0200 ffff              2 max frame 65535
   | 05 0100 01                5 device type 1 (iOS)
   | 06 0e00 6950686f6e65203133206d696e69   6 device name "iPhone 13 mini"
   | 03 0200 1000              3 window 16
   | 04 0200 983a              4 timeout 15000 ms
```

This webapp's default before this capture (Gadgetbridge's): `01 | 01 0300 010000 | 02 0200 00fc | 03 0200 2000 | 04 0200 1027`.
The iOS form is available for testing as `?session=ios&name=…&os=…` and is tested byte for byte in `test/core.test.ts`.

Band → phone (`opcode 2`), the same answer to every config we sent:

```
02 | 01 0300 004102 | 02 0200 0080 | 03 0200 0300 | 04 0200 803e
     version          max frame 32768  window 3      timeout 16000 ms
```

## Binding flow

This is from the iPhone, on the connection where Mi Fitness bound the band (about 8 seconds). Every message
is a plain (unencrypted) protobuf `Command` with type 1 (Account) on channel 1. The table gives the subtype
and the Account field that carries the payload. Inside it, `[n]` is a byte field of n bytes, and a number
in parentheses is a varint value.

| # | Direction | Subtype | Account field and layout | Notes |
|---|---|---|---|---|
| 1 | phone → band | 16 | `9 { 1:[16] }` | 16 random bytes |
| 2 | band → phone | 16 | `10 { 1:(2) }` | |
| 3 | phone → band | 17 | `11 { 1:(0), 2:[16] }` | |
| 4 | band → phone | 17 | `12 { 1:(1), 2:[20], 3:[17], 4:[18], 5:(3), 6:[16], 7:[10] }` | 2: serial number, 3: MAC as a string, 4: model string |
| 5 | phone → band | 18 | `13 { 1:[64], 2:[32], 3:[16] }` | 64 bytes: likely a public key or signature |
| 6 | band → phone | 18 | `14 { 1:[64], 2:[32] }` | |
| 7 | phone → band | 19 | `15 { 1:[16], 2:[32], 3:[26] }` | 3: a 26-character ASCII string |
| 8 | band → phone | 19 | `16 { 1:[16], 2:[32], 3:[32] }` | |
| 9 | phone → band | 25 | `29 { 1:[30] }` | |
| 10 | band → phone | 25 | `3:(0)` | error_code 0 = OK |
| 11 | phone → band | 26 | `30 { 1:[16] }` | auth step 1: AppVerify, nonce only |
| 12 | band → phone | 26 | `31 { 1:[16], 2:[32] }` | DeviceVerify: watch nonce + HMAC |
| 13 | phone → band | 27 | `32 { 1:[32], 2:[36] }` | AppConfirm |
| 14 | band → phone | 27 | `33 { 1:(1), 2:(…), 3:(128) }` | DeviceConfirm; encrypted traffic follows |

Subtype names, mapped against AstroBox-NG-Module-Pb `wear_account.proto`:
- 16 BOND_APPLY
- 17 BIND_START_V2 / BIND_INFO_V2 (the band reports `verify_mode = 1` SERVER_PSK and `oob_mode = 3` BUTTON_CONFIRM)
- 18 BIND_VERIFY: the phone relays the Xiaomi-server-signed `ServerVerify`
- 19 BIND_CONFIRM
- 25 BIND_RESULT_V2

Only the subtype 18 values come from Xiaomi's cloud. See [binding-research.md](../binding-research.md).

On the earlier connection (about 13 seconds before), the phone sent step 1 and the link dropped.

## How to capture

1. **Install the profile.** On the iPhone or iPad, install Apple's Bluetooth logging profile from
   developer.apple.com/bug-reporting/profiles-and-logs (Bluetooth for iOS), then restart the device.
2. **Reproduce.** Pair, sync or connect with Mi Fitness, and note the time.
3. **Trigger a sysdiagnose.** Press Side + Volume Up + Volume Down for about one second. About 10 minutes
   later it shows up under Settings → Privacy & Security → Analytics & Improvements. On iOS 27 that is
   *View Analytics Logs* → `sysdiagnose_…`. AirDrop it to a computer.
4. **Extract only the HCI log.** The sysdiagnose holds much more personal data, so take out just this file:
   `tar -xzf sysdiagnose_….tar.gz --include='*/logs/Bluetooth/bluetoothd-hci-latest.pklg'`
5. **Decode.** `python3 -I tools/bt-capture/decode_pklg.py bluetoothd-hci-latest.pklg` lists the BLE
   connections. Add a handle, for example `… 0x40`, to decode one of them. Byte values are never printed.
   `--show-strings` adds short strings, which can include serial numbers, so review that output before
   sharing it.

Note: timestamps in the decoder's output use the computer's local time zone, and they can be offset from
the phone's clock. In this capture they were 16 hours off.

Delete the sysdiagnose and remove the profile when done.
