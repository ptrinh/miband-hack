# Can the webapp bind a Mi Band 10 directly from the browser?

Research-only feasibility study. No band was contacted, no login was performed.
Model under test: **miwear.watch.o66gl** (Mi Band 10), currently bound to Mi Fitness on iOS.

## Verdict: NOT FEASIBLE (direct browser bind), and the authkey path is also blocked on this firmware

Two independent walls, each sufficient on its own:

1. **Mi Band 10 binds with `SERVER_PSK`, which needs a Xiaomi-cloud signature that a third party cannot forge.** Confirmed directly from the iPhone HCI capture (not inferred): the band's `BindInfoV2.verify_mode = 1 = SERVER_PSK`.
2. **The band only answers auth to its current bound companion.** The authkey the webapp already has is correct (verified cryptographically below), yet the band replies `NO_BOUND` to the Mac. The only difference from the accepted iPhone reconnect is peer identity. Becoming the companion = binding = wall #1.

Web Bluetooth on macOS/Chrome additionally cannot drive the bonding this requires.

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
  worked it would unbind the iPhone and still leave wall #3 (the browser can't hold the bond). This is
  the only theoretical opening and it is high-effort, uncertain, and risky — not a basis to proceed.
- **Does AstroBox bind from a PC in practice?** No. Its code binds only `APP_LOCAL` (emulator / board-to-
  board). For real retail firmware it documents the SERVER_PSK wall and uses an **imported authkey** to
  AUTH against a band already bound by a phone. It is not a first-bind tool for retail bands.

---

## 3. Does the band require the bound peer's identity at auth time? — YES (this is the real blocker)

This is proven by the user's own capture, three connections side by side:

- **Bind connection (0x40):** full 16→25 bind, then 26/27 auth, then encrypted.
- **Reconnect connections (0x51, 0x5c):** `SESSION_CONFIG → auth 26 → 26 → auth 27 → 27 → encrypted`.
  **No re-bind.** This is byte-for-byte the shape the webapp already sends.
- **The webapp from the Mac:** same `SESSION_CONFIG` + auth 26 → band replies `Account{error_code=4
  NO_BOUND}`, across all 9 variants the caller tried.

Offline cross-checks I ran against the user's Mi Fitness `registerList` (values compared by equality only,
never printed):

- The auth 26/27 exchange captured in the bind connection **verifies correctly** with
  `detail.encrypt_key` (and equivalently `detail.token` / `encryptKey`, which are byte-identical) using
  the `miwear-auth` KDF — i.e. **the webapp has the correct authkey.** It does *not* verify with
  `beaconkey` or `irq_key`.
- Band-sent identity fields in `BindInfoV2` equal the record exactly: `serial_number == detail.sn`,
  `model`, `did`. So the capture is unquestionably this band + this account.

Conclusion: the only thing separating the accepted iPhone reconnect from the rejected Mac is **peer
identity**. The iPhone is the band's recognized bound companion (its BLE bond / `peripheral_id`); the Mac
is not, so `AUTH_VERIFY` returns `NO_BOUND` *before* the key matters. Corroborating: on first Mac connect
the band showed `pair_request.setupwizard` (OS-level pairing attempt), and after the band was re-bound to
the iPhone the Mac's GATT connect now hangs and the band once froze/rebooted — the band actively refuses
the non-companion peer. Auth gating is at the app/binding layer (the auth frames themselves are plaintext,
so it is not merely a BLE-encryption requirement) — the band checks that the caller is its bound companion.

**Web Bluetooth cannot satisfy this.** On macOS/iOS pairing/bonding is implicit and cannot be initiated,
controlled, or persisted from script (W3C Web Bluetooth position; macOS does implicit bonding only on an
"insufficient authentication" error). There is no API to present the app-level bind or to become the
band's recognized companion. So even if SERVER_PSK were solved, the browser still could not hold the bond.

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

## 5. Most realistic path to make the webapp work with this Mi Band 10

Given both walls, a pure-browser solution for *this* band is not achievable. In rough order of effort/risk:

1. **Settle wall #3 empirically with a native-BLE client before anything else (cheap, decisive).**
   Build/borrow a native-BLE client (AstroBox desktop, or a small `btleplug`/CoreBluetooth script) on a
   Mac that can create an OS-level bond, and try AUTH with the exported `encrypt_key`. Two outcomes:
   - If AUTH **succeeds** once the host is OS-bonded, the band's gate is "must be on a bonded link," and
     the webapp's only real problem is Web Bluetooth's lack of bonding control. Fallback then =
     **Web Serial / a native helper** that owns the bond, with the ported protocol on top (the repo
     already supports Web Serial / SPP V2 framing).
   - If AUTH still returns `NO_BOUND`, the gate is "must be *the* companion," and only a real bind helps
     → go to options 2/3.
2. **Re-bind on Android, then use the authkey (lower risk than browser bind).** Bind the band fresh with
   Mi Fitness on an Android phone, export the new `encrypt_key`, and connect from there / from a native
   host that can be the bonded peer. Still subject to the companion gate on BLE, but Android's BLE stack
   gives bonding control the browser lacks.
3. **Server-PSK via the user's own cloud session (research spike, high risk/effort, uncertain).** Only if
   1–2 fail and the user accepts unbinding the iPhone: reverse the actual Mi Fitness wear-bind HTTPS call
   (the one that returns `ServerVerify`) from a fresh capture that includes TLS-decrypted phone traffic,
   and drive it with the user's `miothealth` session. Even if the signature is obtainable, the bound peer
   must still be a host that can hold the bond (not the browser). Do not attempt against the live band
   without a throwaway test band.

**Bottom line for the webapp as it stands:** it already does the correct thing (AUTH with the real
authkey); Mi Band 10's firmware simply won't accept AUTH from a peer that is not its bound companion, and
the browser cannot become that companion. Recommend option 1 as the next concrete step — it is cheap and
tells you whether a native-bond helper is enough or whether a full re-bind is unavoidable.

---

### Evidence index (verified vs inferred)

- **Verified from the user's HCI capture:** full subtype/field table incl. `verify_mode=SERVER_PSK`,
  `oob_mode=BUTTON_CONFIRM`; reconnect = auth-26/27-only (no re-bind); authkey (`encrypt_key`) verifies
  the captured auth; band identity fields equal the Mi Fitness record.
- **Verified from source:** `wear_account.proto` field map; `bind.rs` APP_LOCAL crypto + the
  SERVER_PSK bail; Account module has no bind endpoint; `src/core/auth.ts` KDF; `qemu-miwear` PROGRESS.md
  SERVER_PSK-is-unforgeable finding.
- **Inferred (not directly captured):** the exact Xiaomi cloud bind endpoint and its request shape; that
  a native OS bond would satisfy the auth gate (option 1 is the experiment to confirm); phone-side HTTPS
  contents.
