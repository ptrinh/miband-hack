# Mi Band 10: native macOS bonding and AUTH experiment

Tested 2026-10-25/26, Singapore time. This follows option 1 in
[binding-research.md](../binding-research.md), using the band already bound to the user's iPhone and
the existing Mi Fitness cache key. No Xiaomi account bind/reset/unbind was attempted.

## Result

**After the user approved pairing on the band, macOS reported `paired=true`, but a fresh native BLE
connection still received `NO_BOUND (4)` for AUTH_VERIFY.** Native access and OS pairing were not
sufficient in this tested configuration. The failure happens before the device returns its nonce/HMAC,
so the live attempt does not test the key cryptographically.

The `paired` observation is the IOBluetooth record for the band's public address. CoreBluetooth does
not expose the BLE bond state, and no Mac HCI capture was taken to verify link encryption on the
failing session. This is stronger evidence than the initial connection failures, but does not uniquely
prove an iPhone-identity restriction or establish that Android rebinding is necessary.

## Follow-up with iPhone Bluetooth confirmed off (October 26, approximately 01:30–01:33 SGT)

The user confirmed iPhone Bluetooth was off. The corrected native probe then reached AUTH:

1. BLE connected at 13.6 s; FE95 discovery, the 0050 read and 005E subscription succeeded.
2. The band answered session setup. The Mac sent AUTH_VERIFY (26) at 15.2 s and received a transport ACK.
3. At 26.8 s, the band sent Account subtype 16 followed by AUTH_VERIFY with `error_code=4 NO_BOUND`.
   The current protobuf decoder does not expose the subtype-16 body, so its status is not inferred.
4. The user reported a pairing prompt and confirmed they had pressed accept on the band.
5. Before the next connection, a read-only OS query reported `paired=true, connected=false` for the
   known public address. This was a change from the earlier `paired=false` state.
6. A **new BLE connection after that approval** completed GATT setup, sent AUTH_VERIFY at 14.2 s,
   and received its ACK plus `NO_BOUND (4)` at 14.3 s. No new pairing approval was needed to reach this
   response. No device nonce/HMAC or AUTH_CONFIRM exchange followed.
7. The OS still reported `paired=true` afterward. The native helper cancelled its peripheral connection
   and exited. An additional `blueutil --disconnect` returned success, but a 10-second wait for OS
   disconnection timed out (exit 75); the final query still reported `paired=true, connected=true`.
   The remaining connection's owner/state is unresolved. No pairing record was removed, no other app
   was closed, and the Mac's Bluetooth adapter was not reset.

This controls the ordering concern in the first run: the second AUTH request was sent in a new session
after user approval and after the OS pairing record was observed. It also reproduces the browser's
NO_BOUND symptom without Web Bluetooth. It does not determine whether the remaining gate is BLE link
security, account/companion state, identity, or another firmware condition.

## Earlier attempts (before confirmation of phone state)

| Test | Observation | What it establishes |
| --- | --- | --- |
| First CoreBluetooth attempt | One band at RSSI -41; connected at 13.9 s; disconnected at 44.3 s before service discovery completed | Native BLE connection is possible, but this attempt never sent AUTH |
| Classic state and inquiry | Cached target `paired=false`, `connected=false`; no matching target in a 10-second Classic inquiry | No Classic pairing was reported; lack of inquiry visibility does not rule out a direct connection |
| Direct OS Classic pairing | `blueutil --pair` returned `0x1f (Unspecified Error)`; afterward `paired=false`, `connected=true` | Pairing failed even though a connection remained open |
| BLE while that Classic connection remained | FE95 exposed 0050 (`read`), 005E and 005F (`writeWithoutResponse+notify`); read of 0050 returned 3 bytes; notifications enabled | GATT was usable in this attempt; no bond was proven |
| Local probe error on that connection | Initial probe required write-with-response; it stopped before transmitting the session frame | A tool bug, not a band authentication rejection; corrected to use the advertised write mode |
| First scan after that correction | No matching advertisement in the scan window | No connection or AUTH attempt |
| BLE after closing the leftover Classic link | RSSI -43; connected at 13.3 s; service discovery did not complete; disconnected at 43.4 s with no NSError | Still no AUTH sent |
| Explicit Classic-connect comparison plus corrected BLE | Classic connect did not succeed within 15 s, OS still `paired=false, connected=false`; BLE connected, then disconnected during service discovery with `CBErrorDomain` code 6 | The earlier usable-GATT state was not reproduced; still no AUTH sent |

The Classic connection created by the pairing experiment was explicitly closed. The final comparison
also issued a disconnect for its attempted Classic connection. Every BLE probe cancelled its own
peripheral connection before exiting. No pairing record was deleted.

For these earlier runs, the iPhone's Bluetooth state and any pairing prompt or reboot had not yet been
confirmed. The later follow-up above records the user's confirmation and the observed pairing change.

## Offline cross-check of the supplied iPhone capture

Only `logs/Bluetooth/bluetoothd-hci-latest.pklg` was extracted from the supplied sysdiagnose archive.
The requested activity window was approximately 22:15–22:23 Singapore time on October 25. The existing
decoder's clock labels are offset from that user-reported window, so the table below uses elapsed time
within each connection rather than claiming a corrected absolute timestamp. The later reconnect is
included as an additional key check.

The band's public address from the cache matched the target HCI connections (value never printed).
The current cache key verified both the device and app HMACs on all three complete exchanges; the
band's AUTH_CONFIRM result was 1 each time.

| HCI connection handle | Encryption enabled after connect | AUTH_VERIFY sent after connect | HMAC checks / result |
| --- | --- | --- | --- |
| `0x40` (binding connection) | 6.536 s | 9.326 s | Both valid; confirm_result=1 |
| `0x51` (reconnect) | 0.563 s | 1.115 s | Both valid; confirm_result=1 |
| `0x5c` (later reconnect) | 0.569 s | 1.095 s | Both valid; confirm_result=1 |

All three HCI Encryption Change events report status 0 and encryption enabled. Thus the fact that
protobuf AUTH messages are readable in the HCI capture does not rule out BLE link encryption as a
requirement. The capture establishes that the successful iPhone sessions used it; it does not prove
which security/identity condition produces NO_BOUND on the Mac.

## Reproduction and limitations

Source and instructions: [tools/native-probe](../../tools/native-probe/README.md). The driver reuses
the project's AUTH, protobuf and SPP V2 functions. It limits outgoing application commands to subtypes
26 and 27, uses fresh nonces, and logs metadata rather than keys, addresses or packet payloads.

The Swift helper compiled successfully. Offline smoke tests passed for successful AUTH, NO_BOUND,
wrong-key rejection and fragmented transport, using independent Node-crypto verification in FakeBand.
The fixed without-response writer has now sent AUTH on the real band and received transport ACKs and
valid NO_BOUND responses in two runs. Successful live authentication has not been observed.

Native BLE is not an explicit bonding mechanism on macOS: the
[CoreBluetooth backend documentation](https://bleak.readthedocs.io/en/stable/backends/macos.html#pairing)
describes OS-triggered pairing on access to protected characteristics. The Classic attempt uses
[blueutil's IOBluetooth pairing implementation](https://github.com/toy/blueutil/blob/main/blueutil.m), a
different transport. Classic `paired=false` must not be presented as proof of the BLE bond state.

Repeating the same native AUTH is unlikely to add information. A more discriminating next experiment
would measure the Mac session's BLE link encryption or compare another supported transport while
preserving the existing account binding. Android rebinding remains a separate experiment, not a proven
fix. A helper that merely establishes OS pairing has not solved this configuration.
