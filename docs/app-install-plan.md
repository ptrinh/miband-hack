# Plan: reach a verified app installation on this Mi Band 10

Prepared 2026-10-26, after the [native BLE experiment](captures/mi-band-10-native-macos.md).
Step 1 has now been executed; subsequent steps remain proposed.

**Step 1 result:** the band exposes SPP on RFCOMM channel 5. Native SPP opened and negotiated, then
AUTH 26 returned NO_BOUND (4). See the [SPP experiment](captures/mi-band-10-native-spp.md).

**Step 2 outcome:** the band's menu has no "Connect new phone" entry — only Reset. The band was reset
and re-bound with Mi Fitness; a fresh key was extracted. A native Mac BLE probe with the new key then
failed at the link layer with `CBError 14` (`CBErrorPeerRemovedPairingInformation`), twice, iPhone-off
included — AUTH was never reached. See [the re-bind capture](captures/mi-band-10-native-rebind-ble.md).
This surfaces a second wall below SERVER_PSK: macOS CoreBluetooth cannot re-establish the link-layer bond
for an already-bound band. Conclusion: independent desktop access on **macOS** is blocked at bonding; the
viable route is Gadgetbridge on **Android** (explicit bond) with the exported key — step 3.

## Objective and known limits

Finish when a compatible small RPK is installed, appears in the band's app list, and opens on the band.
If continued iPhone use is required, also verify reconnection to Mi Fitness and whether the app remains.
Neither authentication success nor an upload acknowledgement alone proves the objective.

The current key verifies three captured iPhone AUTH exchanges. A fresh native Mac BLE connection after
on-band pairing approval still receives NO_BOUND before a device challenge. The public-address OS
record is paired, but Mac-side BLE link encryption was not captured. A subsequent real SPP/RFCOMM AUTH
attempt also received NO_BOUND. The band's Connect new phone mode was not confirmed during these tests.

## 1. Test actual SPP/RFCOMM on the already-paired Mac

- Read the band's SDP records and look for the SPP UUID `00001101-0000-1000-8000-00805f9b34fb`.
- If exposed, open its RFCOMM channel using the native Mac API. Use the existing key and the project's
  SPP negotiation/authentication path, with the companion profile appropriate to that transport.
- Record transport, version negotiation, AUTH response and any security error separately. A Classic
  connection or pairing operation by itself is not an SPP authentication test.
- If AUTH succeeds, query device information and app list before considering installation. If the
  service is absent or AUTH fails, keep the exact result and proceed to step 2; do not repeat BLE variants.

This requires no intentional account transfer. There is a
[published Mi Band 10 implementation using SPP](https://github.com/TatumRobotics/astrobox_miband_watch),
but its Android-origin setup does not establish that our current iPhone-origin binding will work.

## 2. Follow the documented AstroBox connection flow

First sync pending band data in Mi Fitness and retain the current key privately. Use AstroBox as an
independent client. Its [connection guide](https://abox.run/docs/usage/connection) explicitly requires
entering the band's **Connect new phone** mode before connecting with a manually supplied AuthKey.
That state was not controlled in the previous experiment.

Start with AstroBox on the Mac and the existing key, keeping the iPhone disconnected during the attempt.
If it still fails, a separate trial on the original iPhone with AstroBox is useful: the host identity is
then the one already known to work with Mi Fitness. This is a hypothesis to test, not a guarantee that
another app inherits Mi Fitness's authentication state. Close competing clients and enable iPhone
Bluetooth only for the iPhone trial. AstroBox documents an
[iOS release](https://abox.run/docs/usage/install#ios-ipados-设备).

Entering Connect new phone changes connection state and can require reconnecting Mi Fitness afterward.
Read the on-band prompt before proceeding. Xiaomi
[documents same-account phone transfer](https://www.mi.com/global/support/faq/details/KA-579104/)
separately from reset; a different account requires reset. Do not treat this as proof that every
third-party workflow preserves all data, keys or installed apps.

Success gate: AUTH succeeds and the client can read the device/app list. If AstroBox succeeds while
our client fails, compare the transport and packet sequence before implementing further changes.

## 3. If necessary, let Mi Fitness perform an official Android binding

Use an available Android phone with the same Xiaomi account and appropriate account region. Sync data
first, then use the official transfer/pairing flow. Avoid choosing Unpair or Reset as a shortcut:
Xiaomi's FAQ says Mi Fitness unpairing resets the band and lists data removed by reset.

Obtain the key again after the transfer; do not assume the old key remains valid. Establish a working
AstroBox session on Android first, then attempt app installation there. Separately test Mac access with
that current key if desktop access is still desired. Moving back to the iPhone and retaining installed
apps are further checks, not promised outcomes.

[Gadgetbridge documents the vendor-pairing then key-import workflow](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).
This supports using Mi Fitness to perform server-dependent binding; it does not prove that moving this
band to Android will resolve every firmware or app-installation restriction.

## Installation gate after any successful connection

Confirm exact model/firmware and client-reported app support. Select a small RPK compatible with that
device, install it, query the app list again, and open it on the band. AstroBox documents
[local resource installation and compatibility checks](https://abox.run/docs/usage/resource).

If authentication works but installation fails, investigate the returned installation status, manifest,
signature, package compatibility and firmware capabilities. Do not classify that as another bind failure.

## 4. Research server binding only if the supported paths fail

If a fully independent desktop bind remains a requirement, instrument an authorized Mi Fitness
pairing session on Android and correlate its app/cloud calls with HCI subtypes 16–25. Locate the
SERVER_PSK exchange and determine its request fields and session requirements before writing a client.
An old captured response must not be assumed replayable against fresh device randomness.

This is an open research task, with no reliable effort estimate or guarantee. Prefer a spare band for
fresh-binding experiments. It is not a prerequisite to trying the documented existing-key workflows.

## Execution boundary

Completed technical step: SDP discovery and an actual SPP AUTH attempt on the Mac. Steps that
enter Connect new phone, transfer the companion, reset/unpair, or install an app should be explicit
choices when executing this plan. The completed SPP probe has not performed any of those actions.
