# Mi Band 10: actual native SPP/RFCOMM authentication

Tested October 26, 2026 (Singapore), following step 1 of the
[app-installation plan](../app-install-plan.md).

**Result: SPP connects and negotiates successfully, but AUTH_VERIFY returns NO_BOUND (4).**
This is an application-level refusal on a working SPP session, not a failure to find the service or
open RFCOMM. The band still did not return a device challenge, so the live key/HMAC check was not reached.

## Observations

| Time since probe start | Observation |
| --- | --- |
| 0.3 s | Public-address OS record: paired=true, connected=true |
| 0.3 s | SDP query callback succeeded; six service records, SPP UUID 0x1101 present |
| 0.3 s | SPP record supplied RFCOMM channel 5 |
| 1.0 s | RFCOMM opened successfully; MTU 666 |
| 1.1 s | V1 version request answered with version bytes `030041`; project negotiated its SPP V2 framing path |
| 1.1 s | Default SPP session config accepted; band reported window 3 and max frame 32768 |
| 1.1 s | Sent Account AUTH_VERIFY (26), nonce only, using a fresh random nonce |
| 1.2 s | Received transport ACK and Account error_code=4 NO_BOUND for subtype 26 |
| 1.7 s | Helper exited after closing its RFCOMM channel; OS record remained paired=true, connected=true |

The helper did not close the pre-existing underlying device connection, which was already connected
when this test began. No pairing record was deleted. No account bind, transfer, reset, app upload,
time update or health-data operation was sent.

The probe reused `StreamLink`'s SPP version negotiation, framing and AUTH encryption implementation.
It used the default SPP session config and Android companion profile. The latter is only sent in AUTH
27, which this run never reached. This differs from the earlier BLE probe's captured iOS session config.

Combined with the [BLE result after pairing approval](mi-band-10-native-macos.md), this establishes that
the current NO_BOUND symptom occurs over both native transports. It does not establish which firmware
state causes it. Connect new phone mode was not confirmed during this run; that remains the next
controlled change in the documented AstroBox workflow.

## Reproduction

```sh
bash tools/native-probe/run-spp.sh /path/to/manifest.sqlite-wal
```

The companion manifest.sqlite is required. The private extractor passes the address and key through
child-process pipes; neither appears in logs or command arguments. SDP is queried before opening the
service-provided channel; no hard-coded channel or cached-only fallback is used by the probe.

The helper closes its own RFCOMM channel on exit and requests underlying connection close only when
the device was not already connected before this test. It logs the resulting OS state without claiming
that a close request guarantees immediate disconnection.

```sh
bash tools/native-probe/run-spp.sh --offline-test
```

Offline checks passed for successful version negotiation, AUTH, encrypted device information and app
list queries; NO_BOUND; incorrect key; and absent SPP service. FakeBand verifies HMAC/AES-CCM using
independent Node crypto. It also checks the exact allowed application commands (AUTH 26/27 and the two
read-only queries) across fragmented transport data. Native Objective-C transport compilation passed.
