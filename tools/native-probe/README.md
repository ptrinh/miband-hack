# Native macOS Mi Band 10 AUTH probe

Experimental CoreBluetooth transport for the existing TypeScript authentication code.
See [binding research](../../docs/binding-research.md) and the
[real-device results](../../docs/captures/mi-band-10-native-macos.md).

## Native SPP/RFCOMM probe

```sh
bash tools/native-probe/run-spp.sh /path/to/manifest.sqlite-wal
bash tools/native-probe/run-spp.sh --offline-test
```

This separate probe uses IOBluetooth to query SDP, locate UUID 0x1101 and open its advertised RFCOMM
channel. It reuses `StreamLink`'s SPP version negotiation and the default SPP companion profile. After a
positive AUTH result it makes only device-info and app-list queries, then disconnects. It never uploads
an app or sends bind/reset commands. Its own channel is closed on exit; an underlying connection that
was already open is preserved. Compilation requires Xcode command line tools. No blueutil dependency.

On the real band, channel 5 opened and negotiation succeeded, but AUTH returned NO_BOUND. See the
[SPP report](../../docs/captures/mi-band-10-native-spp.md). The offline test verifies successful AUTH and
encrypted reads, NO_BOUND, wrong-key rejection and no-SPP handling using FakeBand.

## Native BLE probe

Requirements: macOS, Xcode command line tools, Node, Python 3, and this repository's installed npm
dependencies. The optional `--classic-first` mode also needs `blueutil` at `/opt/homebrew/bin/blueutil`.

```sh
bash tools/native-probe/run.sh /path/to/manifest.sqlite-wal
```

The companion `manifest.sqlite` must be in the same directory. The extractor copies both into a private
temporary directory and reads the current registerList cache through SQLite, rather than guessing a key
from stale WAL strings. Exactly one Mi Band 10 key and public address must be found. Neither is logged.
Key material is passed to the driver through a private child-process pipe. The source cache is unchanged.

Before a live test, disable Bluetooth in iPhone Settings, close other Mac clients for the band, and keep
the band nearby and awake. Allow macOS Bluetooth access if prompted. Record any pairing prompt on the
band. No account binding, reset, unbind, app installation or health-data requests are sent.

The probe scans for one band whose advertised name contains `band 10`, discovers FE95, reads readable
FE95 characteristics, subscribes to 005E, then writes the captured iOS session profile and AUTH 26/27 to
005F. It supports writes with and without response and observes CoreBluetooth flow control. Reading a
protected characteristic may prompt macOS pairing, but **CoreBluetooth does not expose an explicit
pair command or bond status**. `ready` and a GATT write are not proof of bonding.

```sh
# Experimental comparison: open a Classic connection first; this does NOT request pairing.
bash tools/native-probe/run.sh /path/to/manifest.sqlite-wal --classic-first
```

The Classic mode records `paired` and `connected` separately and closes the connection it opened when
the helper exits. A pre-existing Classic connection is left in place. The original Classic pairing
attempt was a separate `blueutil --pair` experiment; it is not automatically retried by this tool.

The build is temporary and removed on exit. The BLE probe ends after its first AUTH result, an error,
disconnect, or its 80-second timer. It does not retry or send bind commands. Exit 0 requires a positive
AUTH_CONFIRM result and a clean helper exit; other results return nonzero. A local transport error or
discovery failure means the key was not tested on that connection. A NO_BOUND response with unknown
bond state cannot establish an identity-specific gate.

## Offline verification

```sh
bash tools/native-probe/run.sh --offline-test
```

The smoke test uses a synthetic SQLite WAL and the repository's FakeBand, whose HMAC and AES-CCM
verification use Node crypto independently. It checks successful AUTH, NO_BOUND, wrong-key rejection,
fragmented input/output, and that the driver sends only AUTH 26/27. It requires no Bluetooth permission.
On real hardware, the corrected writer reached AUTH_VERIFY and received NO_BOUND, including on a fresh
connection after on-band approval and an OS `paired=true` observation. Full successful AUTH remains
unverified; see the report for the distinction between that OS record and BLE link security.

## Mi Band 8 (BLE V1) from the terminal

```sh
MIBAND_AUTH_KEY=<32 hex> bash tools/native-probe/run-v1.sh [--match "band 8"] [--install file.rpk|file.bin]
```

`NativeBLEV1.swift` is a plain FE95 GATT client (notify and write by UUID); `v1-test.ts` puts Web Bluetooth
stand-ins over it and runs the web app's own `BleV1Link` and `XiaomiDevice`: auth, device info, app and
watchface lists, and an optional install. Close the band's tab in Chrome first. On a Mi Band 8 (firmware
2.3.14, 2026-10-26) auth, info and the watchface list work; app (.rpk) commands get no answer.
