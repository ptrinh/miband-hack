# Counter (demo tally counter for Mi Band 9 / 10)

A tally counter (reps, laps, visitors, prayer beads…) written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
Demo app for MiBand Hack (`public/apps/counter.rpk`). MIT License.

- Package: `uk.trinh.miband.counter`, name `Counter`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` (same as the other demos)
- Features used: `system.storage` (all counters, key `counter-v1`) and `system.vibrator`

## How to use

- **Tap anywhere on the big number** to count +1. Most of the screen is one tap area, so you can count without looking.
  Each step gives a short buzz.
- **−1** undoes a step (never below 0).
- **Reset** asks "Sure?" (red); tap it again within 3 s to set the count to 0. Counting, Back or waiting cancels it.
  Reset keeps the counter's goal and name.
- **Goal** (the target button, top right): pick Off, 10, 21, 33, 50, 99, 100, 108, 500 or 1000. When the count lands on the
  goal, and on every multiple of it (33, 66, 99… for prayer beads), the band gives a long buzz; from the goal on the number
  turns green with a tick (`✓ 33 ×2` after two rounds). Below the goal it shows `of 33`.
- **Counters** (the name button, top left): four counters, each with its own count and goal. Tap one to switch.
  **Rename** cycles the current counter through preset names: Counter n, Reps, Laps, Visitors, Beads, Rounds, People, Score.
  Back or **Done** closes the list.
- Everything is saved on the band after every change.

Touch rules: a touch only counts when it barely moves (less than 16 design px), so a swipe never counts, and touches that
start in the 12 px strip at the left edge are ignored, which leaves the system Back swipe alone. On the main screen Back
leaves the app (unless a reset is armed, then it only cancels that). The counts are already saved, so nothing is lost.

## Vibration

`@system.vibrator`, declared in the manifest as `{ "name": "system.vibrator" }`. Docs:
<https://iot.mi.com/vela/quickapp/en/features/system/vibrator.html>. The docs' support table lists only
`vibrator.vibrate({ mode: 'short' | 'long' })` for Xiaomi Band 9 / 9 Pro and Band 10; `start`, `stop` and
`getSystemDefaultMode` are Watch S5 only, so the app uses `vibrate` alone (short per step, long at the goal). The call
is wrapped in `try`/`catch`, so a band that refuses it still counts.

## Layout

Fits 192 x 471 design px (Mi Band 10, 212 x 520 px) and the taller Mi Band 9 (the tap area is `flex: 1` and absorbs
the difference). Content starts 18 px from the left edge and keeps 14–20 px off the rounded corners. The big number
shrinks with its digit count (104 px for 1–2 digits down to 44 px for 6; the maximum is 999 999). The goal button's
target is drawn with two circles, so it does not depend on an icon glyph in the band's font.

## Code

- `src/common/counter.js`: pure state (no platform APIs): slots, +1 / −1 / reset, goal events, preset names, digit
  size class, tap-vs-swipe rule, and a `deserialize` that never throws and drops bad fields one by one.
- `src/pages/index/index.ux`: the one page (main screen, Counters list and Goal picker as views of it), storage,
  vibration and touch handling. Taps that arrive before storage has answered are ignored, so they cannot be
  overwritten by the load.

## Rebuild

Needs Node >= 18. Toolchain: Xiaomi's official `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/counter
npm test                 # state checks + page checks (plain node, no install needed)
npm install
npm run build            # debug rpk, toolkit debug key
npm run publish-demo     # copies ../../src/rpk/demo-key/*.pem to sign/, builds
                         # dist/uk.trinh.miband.counter.release.1.0.0.rpk, copies it + the icon to ../../public/apps/
```

To save disk you can skip `npm install` and run the Calculator's toolkit:
`npm run presign && ../calculator/node_modules/.bin/aiot release`, then copy the rpk and icon as `publish-demo` does.

**Signing key**: release builds are signed with the public demo key in `src/rpk/demo-key/` (same as the other demos).
Keep that key: the band may refuse an update signed by a different certificate. `sign/` here is only a gitignored copy.

## Tests

- `test/counter-check.mjs`: counting, the floor at 0 and the maximum, goal buzz at every multiple, tick text, reset,
  independent slots, rename cycle, size classes, save/load round trip, corrupt or hostile storage, tap vs swipe vs
  left edge.
- `test/page-check.mjs`: loads the page script from `index.ux` with stubbed `@system.storage`, `@system.vibrator` and
  timers (touches in Mi Band 10 device px), and checks counts, buzzes, saves, the armed reset (timeout, Back, a count
  in between), the goal picker, the Counters list, Back handling, reload from storage, taps before the load, and a
  vibrator that throws. It also checks that the imported `@system.*` modules match the manifest's features and that
  every handler named in the template exists.
- The main suite (`test/counter-rpk.test.ts`) verifies the shipped rpk: signature, demo certificate, manifest.

## Status

Builds with no toolkit warnings; the rpk signature is verified by `src/rpk` (`verifyRpk`). Not yet run on a real band
or the Vela emulator. Unconfirmed on the device: how `vibrate` short / long feel (and whether rapid taps queue or drop
buzzes), whether storage writes on every tap keep up with fast counting, touch coordinates and the tap/swipe threshold,
the `✓` and `−` glyphs in the band's font, `border-style` on the goal target, and `lines` / `text-overflow` on long names.
