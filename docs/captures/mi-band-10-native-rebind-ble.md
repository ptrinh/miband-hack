# Mi Band 10: native Mac BLE AUTH after a fresh Mi Fitness re-bind

Tested October 26, 2026. The band was factory-reset on-device (no "Connect new phone" option exists in
its menu — only Reset), then re-bound officially with Mi Fitness on iPhone. A new auth key was extracted
from the refreshed companion cache and used for this probe.

**Result: the Mac cannot reach AUTH at all — connect fails at the BLE link layer with
`CBErrorDomain code 14` (`CBErrorPeerRemovedPairingInformation`), in two runs including one with the
iPhone's Bluetooth confirmed off.** This is earlier than the previous `NO_BOUND`: application AUTH 26/27
was never sent, because CoreBluetooth could not establish an encrypted link to a peer the Mac has no
bond with.

## Observations

| Time | Observation |
| --- | --- |
| 0.0 s | New key loaded from the refreshed cache (value hidden). Different from the pre-reset key (confirmed by hash), same band MAC `04:34:c3:xx:xx:e0`. |
| 0.4 s | Adapter powered, authorized; scanning |
| 0.7 s | Candidate `Mi Band 10`, RSSI −51 (−61 on the first run) |
| ~13 s | `connecting` |
| ~14 s | `RESULT: Native error during connect: CBErrorDomain code 14` |

Run 1 and run 2 (iPhone Bluetooth off, band awake and near) produced the identical error code. No
pairing record was created or deleted by the probe; no bind/reset/upload/health command was sent.

## What this establishes

The reset wiped the Mac's prior Classic/BLE pairing. After re-binding, the band holds a fresh bond with
the iPhone companion and is **not** in a mode that admits a new device. From the Mac, two walls now stand
between us and independent access, in order:

1. **BLE link bonding.** The band removed its pairing information for the Mac (`CBError 14`), and
   CoreBluetooth exposes no explicit pair/bond command to re-establish one. The band only opens a bind
   window during Mi Fitness's own flow, not for an arbitrary second peer. On macOS this is a hard stop
   reached before any application byte is exchanged.
2. **SERVER_PSK** (only relevant if bonding were solved). A fresh bind still needs the Xiaomi-cloud
   `server_sign`; see [binding-research](../binding-research.md). A valid exported key only helps the
   *reconnect* AUTH path, which this run never reaches because of wall 1.

A valid, freshly-bound key is therefore necessary but not sufficient on macOS: the missing piece is the
link-layer bond, which CoreBluetooth will not create for this already-bound band.

## The path that does work

Android's BLE stack has an explicit pair/bond operation, so the documented
[Gadgetbridge vendor-pair-then-key-import workflow](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/)
applies: official Mi Fitness bind (done) → export the current key → import into Gadgetbridge on Android,
which performs the bond and then authenticates with the stored key (APP_LOCAL-style HMAC). macOS cannot
substitute here because it lacks the explicit bond API, not because the key is wrong.

## Reproduction

```sh
bash tools/native-probe/run.sh /path/to/manifest.sqlite-wal
```

The refreshed `manifest.sqlite` companion must sit beside the `-wal`. The extractor confirmed exactly one
Mi Band 10 key and address; neither is logged. The probe self-terminates on the first AUTH result, a
transport error, disconnect, or its 80-second timer.
