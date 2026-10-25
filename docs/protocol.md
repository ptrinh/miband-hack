# Xiaomi Wear (Vela) protocol — porting notes

Source: Gadgetbridge (`app/src/main/java/.../service/devices/xiaomi/`, protos in `GBProtobufGenerator/src/main/proto/xiaomi*.proto`), read on 25/10/2026. Java class names in parentheses.

## 1. Transport per device generation

| Device | `getConnectionType()` in Gadgetbridge | In the webapp |
|---|---|---|
| Mi Band 8 | BLE (default) → BLE V1 | Web Bluetooth |
| Mi Band 9 Active | BLE → BLE V2 | Web Bluetooth |
| Mi Band 9 / 9 Pro / 10 / 10 Pro | `BT_CLASSIC` → SPP | Web Serial (RFCOMM, UUID `00001101-…`) |

## 2. SPP

Once connected, send a **V1 version request packet** (`badcfe 00 c0 0300 00 00 00 ef`). If the band replies with `payload[0] >= 2`, switch to V2; otherwise use V1. No reply within 5 seconds also means V1 (`XiaomiSppSupport.handleVersionPacket`).

### SPP V1 (`XiaomiSppPacketV1`)
```
ba dc fe | ch(1) | flags(1: 0x80 flag, 0x40 needsResponse) | len(2 LE = payload+3) | opcode | serial | dataType | payload | ef
```
- Send channels: version 0, proto TX 2, fitness 3, mass/data 5.
- `dataType`: 0 plain, 1 encrypted (AES-CCM), 2 auth.
- Proto channel when encrypted: `u16 counter` + CCM(counter). Data channel: CCM(counter 0), no counter prefix.

### SPP V2 (`XiaomiSppPacketV2`, `XiaomiSppProtocolV2`)
```
a5 a5 | type(low 4 bits) | seq | len(2 LE) | crc16/ARC(payload, 2 LE) | payload
```
- type: 0 NACK, 1 ACK, 2 SESSION_CONFIG, 3 DATA.
- Session config (op 1 = start request): TLV with version 1.0.0, max frame `0xfc00`, TX window 32, timeout 10000 ms. Once the band replies with its session config, authentication starts.
- DATA payload: `channel(1) | opcode(1) | body`. Channel 1 = proto/auth, 2 = data (upload), 5 = activity. Opcode 1 plain, 2 encrypted.
- V2 encryption: **AES-128-CTR with IV = key**, counter restarted for every packet (really, this is not a mistake).
- Cumulative ACKs, 8-bit wrapping seq. NACK(n) means the band is waiting for packet n. Retransmit after 10 seconds without an ack; disconnect after 3 in a row.
- Gadgetbridge pushes upload parts continuously without waiting for acks. The webapp respects the TX window the band reports (at most 32 frames in flight).

## 3. BLE

### BLE V2 (`XiaomiBleProtocolV2`)
Uses exactly the SPP V2 framing, over characteristic `0x005e` (notify, band→host) / `0x005f` (write), service `0xfe95`. Send the session config right away, no version request.

### BLE V1 (`XiaomiCharacteristicV1`)
Service `0xfe95`: `0051` command read, `0052` command write, `0053` activity, `0055` data upload.
- Control packets start with `00 00`, byte 2 is the type:
  - `0` chunked start `[00 00 00 enc u16 n]` → the receiver replies `00 00 01 01`
  - `1` chunked ack: subtype 0 done, 1 start sending chunks, 2 nack, 5 request chunk resend `[u16…]`
  - `2` single command `[00 00 02 enc(1=encrypted, 2=plain) (u16 counter) payload]` → ack `00 00 03 00`
  - `3` ack for a single command, byte 3 = 0 means OK
- Data chunks: `u16 index (starting at 1) | data`, size ≤ write size − 2.
- V1 encryption: AES-CCM, 4-byte tag, 12-byte nonce = `nonce4 | 00000000 | u32 counter LE`. Uploads use counter 0 (`incrementNonce=false`). The command counter starts at 1 after authentication.
- Web Bluetooth cannot request an MTU, so writes default to 180 bytes (macOS usually negotiates an MTU of about 185).

## 4. Authentication (`XiaomiAuthService`)
1. Host → band: `Command{type 1, subtype 26, auth.appVerify.nonce = 16 random bytes}`
2. Band → host: `deviceVerify{nonce, hmac}`
3. `hk = HMAC-SHA256(key = phoneNonce‖watchNonce, msg = authKey)`, then expand HKDF-expand style:
   `T(i) = HMAC(hk, T(i-1) ‖ "miwear-auth" ‖ i)`, taking 64 bytes in total.
   `decKey = [0:16]`, `encKey = [16:32]`, `decNonce = [32:36]`, `encNonce = [36:40]`.
4. Check `HMAC(decKey, watchNonce‖phoneNonce) == hmac`. A mismatch means a wrong auth key.
5. Host → band: `subtype 27, appConfirm{encryptedNonces = HMAC(encKey, phoneNonce‖watchNonce), encryptedDeviceInfo = CCM(encKey, CompanionDevice, counter 0)}`
6. When the band replies with subtype 27 it's done; from then on the proto channel is encrypted.

### 4.1 Refusals and bands paired from iOS
Xiaomi's own field names come from the fuller schema in [AstroBox-NG-Module-Pb](https://github.com/AstralSightStudios/AstroBox-NG-Module-Pb) (`protos/xiaomi/wear_account.proto`); Gadgetbridge's names differ.
- `Account` is a oneof. Field 3 is `error_code` (`Account.ErrorCode`): 0 NO_ERROR, 1 HAVE_BOUND, 2 INFO_MISSING, 3 INVALID_PARAM, **4 NO_BOUND**, 5 SERVER_ERROR, 6 CANCEL, 7 VERIFY_ERROR, 8 STATE_NOT_MATCH, 9 USER_CHANGED, 10 CONNECTION_REACH_LIMIT, 100 UNKNOWN. Subtypes (`AccountID`): 0 BIND_STATUS, 1 BIND_START, 16 BOND_APPLY, 17–19/25 bind V2, **26 AUTH_VERIFY**, **27 AUTH_CONFIRM**, 28/29 pass token, 30 login status changed.
- `AppVerify` = `{1 app_random, 2 app_device_id (string), 3 check_dynamic_code (bool)}`. `CompanionDevice.device_type`: 0 ANDROID, 1 IOS, 2 VELA, 15 OTHER (Gadgetbridge's `unknown1`). AstroBox-NG sends device_type IOS over BLE.
- A Mi Band 10 paired with Mi Fitness on an iPad answered step 1 with `0801101a1a021804` = `error_code NO_BOUND`, both without and (apparently) with `app_device_id = detail.phone_id`. Gadgetbridge sends `app_device_id` for the Wear OS Xiaomi Watch 5 (#6614); AstroBox-NG-Module-Core accepts an optional `app_device_id` (≤ 64 bytes) for AUTH.
- The firmware keeps the bound companion's type (Android/iOS) and Bluetooth address and lets only that companion pair without asking (qemu-miwear `emu/mksensornor.py` notes, Mi Band 10 Pro firmware).
- The session config can carry TLV 5 (device type), 6 (device name), 7 (OS version) (`layer1cmd.rs` in AstroBox-NG-Module-Core, which does not send them). Whether a band reads TLV 5 is unverified.

The webapp therefore tries several step-1 shapes in one connection (`planAuthAttempts` in `core/auth.ts`, a fresh nonce each): full Device ID, nonce only, the UUID part of the Device ID (upper/lower case), Device ID + `check_dynamic_code`, then the same after restarting the session with TLV 5 = 1. After the first NO_BOUND it asks BIND_STATUS once (read-only) and logs the answer. The connection log shows each attempt's shape (lengths and flags; never the id itself) and the band's reply. "Before you connect" has a selector to pin one variant; `?auth=<variant>` and `?companion=ios|android` set them from the URL.

## 5. Installing
- **App**: `20/1 rpk.rpkInfo{id = package, unknown2 = versionCode, size}` → band replies `20/1 rpkInstallStart.cmd` (0 = OK) → DataUpload type **64** → band sends `20/2` when installation finishes.
- **Watchface**: `4/4 watchfaceInstallStart{id, size}` → `installStatus` (0 OK, 2 already present) → DataUpload type **16** → `4/1 watchfaceId` to set it as the watchface.
- **DataUpload** (`XiaomiDataUploadService`): `22/0 dataUploadRequest{type, md5, size}` → `dataUploadAck{errno, resumePosition, chunkSize (default 2048)}`.
  Payload = `00 | type | md5(16) | u32 size | bytes[resume:] | crc32(of everything before)`, split into parts `u16 total | u16 index(1-based) | data`, each part ≤ chunkSize.
- Lists: `20/0` apps, `4/0` watchfaces. Delete: `20/3 rpkDel{id, sha}`, `4/2 watchfaceId`.
- Device info: `2/2` deviceInfo, `2/1` battery.

## 6. Risks / unverified
- **Web Serial + Bluetooth Classic**: Chrome ≥ 117 supports RFCOMM ports on desktop, but the device must already be paired at the OS level. Not yet tested whether Mi Band 9/10 allows pairing directly with a PC (outside Mi Fitness) and exposes the SPP service. This is the most important assumption to verify on a real device. AstroBox-NG says it has done SPP on Windows/macOS/Linux with native code, so it is feasible at the OS level.
- BLE write size with Mi Band 8 when no MTU can be requested.
- The band may disconnect if it doesn't receive a time sync or other init commands. Gadgetbridge sends `setCurrentTime` after authentication; the webapp doesn't yet.
