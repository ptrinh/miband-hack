# Can the webapp bind a Mi Band 10 directly from the browser?

Initial feasibility study, followed by native macOS experiments on 2026-10-25/26.
Model under test: **miwear.watch.o66gl** (Mi Band 10), currently bound to Mi Fitness on iOS.

## Verdict: no working direct-browser bind; the cause of Mac AUTH rejection remains unresolved

1. The iPhone capture reports `BindInfoV2.verify_mode = 1 = SERVER_PSK`. The binding implementation
   discussed below does not support this mode, and no working Xiaomi signing API integration is present.
2. The browser received `NO_BOUND` despite using an auth key that verifies the successful iPhone
   exchanges. This establishes a failure from this Mac, **not proof that only the iPhone identity can
   ever authenticate**. Bond/link-security state and companion identity have not been isolated.
3. Native CoreBluetooth also has no explicit BLE pair operation. macOS can initiate pairing when a
   protected characteristic is accessed. Moving from a browser to a native BLE client therefore does
   not, by itself, guarantee a bond.

The [native experiment report](captures/mi-band-10-native-macos.md) records actual results separately
from these hypotheses. In particular, HCI packets being readable does **not** mean the radio link was
unencrypted: the iPhone capture has successful HCI Encryption Change events before AUTH 26/27.

**October 26 follow-up:** with iPhone Bluetooth confirmed off, the user accepted the band's pairing
prompt and macOS subsequently reported `paired=true` for the public-address IOBluetooth record. A fresh
native BLE session still returned `NO_BOUND (4)` for AUTH 26. This reproduces the browser failure after
observed OS pairing; BLE link encryption on the Mac was not measured, so the exact gate remains unknown.

**October 26, reset + official re-bind:** the band's menu offers only Reset (no "Connect new phone"), so
it was reset on-device and re-bound with Mi Fitness. A new auth key (different hash, same MAC) was
extracted. A native Mac BLE probe with that fresh key now fails *before* AUTH with
`CBErrorDomain code 14` (`CBErrorPeerRemovedPairingInformation`), in two runs including iPhone-off. See
[the re-bind capture](captures/mi-band-10-native-rebind-ble.md). This isolates a **second, earlier wall**:
on macOS the link-layer bond cannot be re-established (CoreBluetooth has no explicit pair command, and the
band admits new companions only during Mi Fitness's bind flow), so the SERVER_PSK wall is never even
reached from the Mac. A valid key is necessary but not sufficient; the working desktop/mobile path is
Gadgetbridge on Android, whose BLE stack can bond explicitly.

---

## 1. The full Xiaomi wear binding flow (verified against the user's own HCI capture)

Source of field names: `AstroBox-NG-Module-Pb/protos/xiaomi/wear_account.proto` (`message Account`,
subtypes = `AccountID`). The capture (LE handle 0x40, band public address (redacted)) matches it field-for-field.
The band reports itself with `oob_mode = 3 = BUTTON_CONFIRM` and `verify_mode = 1 = SERVER_PSK`.

| Subtype | AccountID | Dir | payload (field #) | Contents (lengths from capture) | Who produces it |
|--------|-----------|-----|-------------------|----------------------------------|-----------------|
| 16 | `BOND_APPLY` | phone→band | `bond_apply` (9) | `hash_user_id`[16] = MD5(user_id) | phone (local) |
| 16 | `BOND_REPLY` | band→phone | `bond_reply` (10) | `status` = 2 `BOND_SUCCESS` | band |
| 17 | `BIND_START_V2` | phone→band | `bind_start_v2` (11) | `check_dynamic_code`=0, `hash_user_id`[16] | phone (local) |
| 17 | `BIND_INFO_V2` | band→phone | `bind_info_v2` (12) | `verify_mode`=**1 SERVER_PSK**, `serial_number`[20], `mac`[17], `model`[18], `oob_mode`=3, `device_random`[16], `did`[10] | band |
| 18 | `BIND_VERIFY` | phone→band | `psk_server_verify` (13) | `server_public_key`[64], `server_sign`[32], `server_random`[16] | **Xiaomi cloud** |
| 18 | `BIND_VERIFY` | band→phone | `psk_device_verify` (14) | `device_public_key`[64], `device_sign`[32] | band |
| 19 | `BIND_CONFIRM` | phone→band | `psk_app_confirm` (15) | `app_random`[16], `app_sign`[32], `bind_key`[26] | phone (+cloud) |
| 19 | `BIND_CONFIRM` | band→phone | `psk_device_confirm` (16) | `device_random`[16], `device_sign`[32], `bind_sign`[32] | band |
| 25 | `BIND_RESULT_V2` | phone→band | `bind_result_v2` (29) | `encrypt_result_info`[30] (AES-CCM of `ResultInfo{user_id, companion_device}`) | phone |
| 25 | `BIND_RESULT_V2` | band→phone | `error_code` (3) = 0 `NO_ERROR` | — | band |
| 26 | `AUTH_VERIFY` | phone→band | `auth_app_verify` (30) | `app_random`[16] (+ optional `app_device_id`) | phone |
| 26 | `AUTH_VERIFY` | band→phone | `auth_device_verify` (31) | `device_random`[16], `device_sign`[32] | band |
| 27 | `AUTH_CONFIRM` | phone→band | `auth_app_confirm` (32) | `app_sign`, `encrypt_companion_device` | phone |
| 27 | `AUTH_CONFIRM` | band→phone | `auth_device_confirm` (33) | `confirm_result`=1, capabilities | band |

After subtype 27 all traffic is encrypted (`op2`). Note the phone-side HTTPS to Xiaomi is **not** in the
HCI log; the "Xiaomi cloud" rows above are the values that enter the BLE link but have no local origin.

### SERVER_PSK vs APP_LOCAL

- **`APP_LOCAL` (VerifyMode=2)**: pure local P-256 ECDH + HKDF, no server. Implemented in
  `AstroBox-NG-Module-Core/src/device/xiaomi/components/bind.rs` (`Exchange`): app and device exchange
  public keys, `shared = ECDH`, `HMAC-SHA256(shared, random)` as the signatures,
  `HKDF-SHA256(salt = app_random‖device_random, ikm = shared, info = "miwear-bind")` → 64-byte key block.
  **No cloud secret is needed.** This is the only mode AstroBox implements.
- **`SERVER_PSK` (VerifyMode=1)** — what Mi Band 10 uses: the band's `device_random` is sent to Xiaomi
  cloud, which returns `ServerVerify{server_public_key, server_sign, server_random}`. `server_sign` is a
  signature produced by **Xiaomi's server private key**; the band verifies it against a public key baked
  into firmware. AstroBox explicitly bails here:
  `ensure!(info.verify_mode == AppLocal, "Device requires server PSK binding, not local binding")`
  (`bind.rs:172`). The `qemu-miwear` emulator team reached the same wall and documented it
  (`qemu-miwear/emu/PROGRESS.md`, entry ㊳ 2026-10-09): this firmware ships `verify=0/SERVER_PSK`, the
  server signature is checked by firmware routine `sub_C7DAAC8`, and it is **"离线无法伪造"** (cannot be
  forged offline). Their chosen workaround is to pre-seed the band's NV as already-bound and use AUTH,
  not to bind.

### How the auth key is generated / registered

In both modes the HKDF block yields the long-lived auth key that the app stores and uploads to the cloud.
In `APP_LOCAL` (bind.rs:195) the AstroBox auth key = `hex(keys[40..56])` (16 bytes). In the user's Mi
Fitness record this is `detail.encrypt_key` / `detail.token` / `encryptKey` (all 32 hex = 16 bytes,
identical to each other — see below). Auth at reconnect uses it via
`HMAC-SHA256`-based KDF with info `"miwear-auth"` (ported in `src/core/auth.ts` `computeAuthStep3Hmac`).

---

## 2. Can a third party with the user's own Mi Fitness session do the server step?

- **The signing is server-side, not in the app.** `server_sign` comes back over BLE already signed; the
  app merely relays it. So no signing secret is extractable from the app, and there is no evidence of a
  per-device certificate or local attestation key that would help.
- **The specific cloud bind endpoint is undocumented and not reproduced anywhere I found.** AstroBox's
  Account module (`AstroBox-NG-Module-Account/src/xiaomi.rs`) only calls
  `hlth.io.mi.com/healthapp/device/latest_ver` and `/healthapp/device/bledevice_info` — **no bind
  endpoint**, because AstroBox never binds; it connects to already-bound devices. Public reverse-eng
  work (Gadgetbridge Huami/Xiaomi pairing, mifit/Mi-Fitness-Sync, Mi-Fitness-Private-Server, habr RC4
  write-up) covers QR login, request signing and **health-data read** only — none implements the wear
  bind/PSK signing.
- **In principle** possessing the user's `miothealth` session *might* let us call whatever endpoint Mi
  Fitness calls to obtain `ServerVerify`, since the signing lives at Xiaomi, not in the app. But the
  endpoint, its request shape, and whether it gates on app attestation are all unknown, and even if it
  worked it could replace the existing companion binding. Browser/OS bonding behavior would still need
  to be verified. This is
  the only theoretical opening and it is high-effort, uncertain, and risky — not a basis to proceed.
- **Does AstroBox bind from a PC in practice?** No. Its code binds only `APP_LOCAL` (emulator / board-to-
  board). For real retail firmware it documents the SERVER_PSK wall and uses an **imported authkey** to
  AUTH against a band already bound by a phone. It is not a first-bind tool for retail bands.

---

## 3. Does AUTH require the current companion identity? — unresolved

The following observations are verified:

- The iPhone bind connection (handle `0x40`) completes subtypes 16–25 and then 26/27.
- The iPhone reconnects (`0x51`, `0x5c`) authenticate with 26/27 without repeating account binding.
- The browser on the Mac received `Account.error_code = 4 (NO_BOUND)` for the tested variants.
- Offline verification using the current cache's `encryptKey` validates both device and app HMACs
  in all three successful captured exchanges. `detail.encrypt_key` and `detail.token` are the same key.
- On the iPhone, HCI Encryption Change reports status 0 and encryption enabled before AUTH on all
  three connections. See the [native experiment report](captures/mi-band-10-native-macos.md).
- After on-band pairing approval and a `paired=true` OS record, a new native Mac BLE connection also
  returned NO_BOUND for AUTH 26. The band did not return a device nonce/HMAC. Its key check was therefore
  not reached; the source of the earlier browser failure is not limited to Web Bluetooth.

The earlier conclusion that peer identity was the **only** difference was too strong. The experiments
have not held bond state, radio-link encryption, and device state constant. `NO_BOUND` is an observed
application error; its name alone does not identify which firmware condition caused it.

Also, plaintext protobuf visible in an HCI log does not establish an unencrypted BLE radio link. HCI
is the host/controller boundary, and the controller can handle link encryption below that boundary.
The captured encryption events are direct evidence of this distinction in these sessions.

### macOS pairing limitation applies to native BLE too

[CoreBluetooth backend documentation](https://bleak.readthedocs.io/en/stable/backends/macos.html#pairing)
explains that macOS has no explicit BLE pairing API; accessing a characteristic requiring authentication
can trigger OS pairing. Calling a native BLE library does not inherently force or prove a bond. The
same OS behavior also makes the blanket claim "a browser cannot hold a bond" unsupported here.

Bluetooth Classic pairing is a separate path, exposed through IOBluetooth. A successful Classic bond
would still need verification before drawing conclusions about BLE bonding or AUTH. The experiment
attempted this path and checked the resulting OS state; see the report.

---

## 4. Risks to the user's band if a bind were attempted

- **Unbinds the iPhone.** A successful new bind reassigns the band's single companion slot and the Xiaomi
  cloud device record; the iPhone's Mi Fitness would show the band as removed/needing re-add.
- **On-band data loss.** Re-binding to a new account/companion typically resets companion-scoped data on
  the band (steps/sleep/etc. not yet synced); not recoverable from the band afterwards.
- **Instability already observed.** With a half-finished/foreign connection the band has frozen and
  rebooted once, and now refuses the Mac's GATT connect. Repeated attempts risk more of this.
- **Re-binding to Mi Fitness later: yes, normally possible** via factory-reset on the band + normal
  pairing. Xiaomi bands have **no hard activation / find-device lock** like Apple Watch; account binding
  is clearable by on-band factory reset. So the band is not at risk of permanent account-lock bricking —
  the realistic damage is lost data + having to re-pair + transient instability.

---

## 5. Next experiment and interpretation

The [app-installation plan](app-install-plan.md) prioritizes AstroBox's documented Connect new phone
workflow before an Android transfer or cloud-bind research. The new
[actual SPP/RFCOMM test](captures/mi-band-10-native-spp.md) found SPP on channel 5, opened it and negotiated
successfully, but AUTH 26 still returned NO_BOUND. This is now verified over both native BLE and SPP;
the band's Connect new phone state has not yet been controlled.

The user authorized native Mac bonding and AUTH with the existing key. The
[native experiment report](captures/mi-band-10-native-macos.md) documents the initial failed Classic
pair request and the later successful on-band approval/OS pairing observation. Even a fresh native BLE
connection after approval received NO_BOUND. A helper that merely gets the Mac paired is therefore not
a demonstrated solution for this band.

Use these decision rules:

- **AUTH succeeds:** a native connection with this key works in the tested state. Determine what state
  changed and whether it persists before building a browser helper.
- **AUTH returns NO_BOUND, with bond state unverified:** reproduces the symptom; does not distinguish
  missing bond/link encryption from an identity-specific gate.
- **AUTH returns NO_BOUND after verified bonding and link encryption:** stronger evidence that bonding
  alone is insufficient, but transport, firmware state and companion metadata still need consideration.
- **Connection/discovery/pairing fails before AUTH:** the key has not been tested on that connection.

A controlled retry needs the iPhone's Bluetooth disabled in Settings, no other Mac client holding the
band, and a responsive nearby band. Record any pairing prompt and its outcome. The current probe stops
before account binding and has no reset/unbind command.

Rebinding through Android or reverse engineering Xiaomi's server binding endpoint remain separate
experiments. The current evidence does not establish that either is necessary or sufficient. They can
replace companion state or lose unsynced data, so they are not an automatic continuation of this test.

---

### Evidence index (verified vs inferred)

- **Verified from the user's HCI capture:** full subtype/field table incl. `verify_mode=SERVER_PSK`,
  `oob_mode=BUTTON_CONFIRM`; reconnect = auth-26/27-only (no re-bind); authkey (`encrypt_key`) verifies
  the captured auth; band identity fields equal the Mi Fitness record.
- **Verified from source:** `wear_account.proto` field map; `bind.rs` APP_LOCAL crypto + the
  SERVER_PSK bail; Account module has no bind endpoint; `src/core/auth.ts` KDF; `qemu-miwear` PROGRESS.md
  SERVER_PSK-is-unforgeable finding.
- **Inferred (not directly captured):** the exact Xiaomi cloud bind endpoint and its request shape; whether
  a native OS bond would satisfy the auth gate; whether the gate is specific to the iPhone identity; phone-side HTTPS
  contents.
