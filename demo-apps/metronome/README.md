# Metronome (demo app for Mi Band 9 / 10)

A silent metronome for musicians, written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
The beat is a **vibration on the wrist**, so you can practise or play on stage without a click in your ears; the screen
flashes along. Demo app for MiBand Hack (`public/apps/metronome.rpk`). MIT License.

- Package: `uk.trinh.miband.metronome`, name `Metronome`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` (same as the other demos)
- Features used: `system.vibrator` (the beat), `system.brightness` (keep the screen on while running),
  `system.storage` (last tempo, time signature and accent, key `metronome`)

## How to use

- **− / +**: tap for ±1 BPM; hold for steps of 5 (snaps to multiples of 5, repeats every 220 ms after 450 ms). 30–250 BPM.
- **Tap tempo**: tap along with the music; the BPM is the average of the last 4 intervals. A pause over 2 s starts a new
  measurement, and an interval more than 1.6× off the running average restarts it from the previous tap (tempo change).
  It reacts on touch start, which has less latency than a click (which fires on release).
- **Time**: tap to cycle 2/4, 3/4, 4/4, 6/8. In 6/8 the BPM counts eighth notes (six beats per bar).
  The dots show the position in the bar; beat 1 is orange.
- **Beat 1**: tap to choose how the accent feels: **Double** (two short pulses about 110 ms apart, the default) or
  **Long** (the system's long vibration). Other beats are one short pulse.
- **Start / Stop**. Leaving the app (Back, another app, screen off) stops it.

Layout: 420 design px tall (fits the Mi Band 10's 192 × 471 and the Mi Band 9), touch targets 44–62 px tall and at least
78 px wide, all at least 14 px from the left edge so the system swipe-right-to-go-back works and is never needed.
No swipe gestures are used.

## Vibration API

[`@system.vibrator`](https://iot.mi.com/vela/quickapp/en/features/system/vibrator.html), declared in the manifest as
`{ "name": "system.vibrator" }`. On the Xiaomi Smart Band 9 / 9 Pro / 10 the docs list only
**`vibrator.vibrate({ mode: 'short' | 'long' })`** as supported. `start({ duration, interval, count })`, `stop(id)` and
`getSystemDefaultMode()` are listed for the Xiaomi Watch S5 only, so there is no duration control and no repeating
pattern on the band. The docs give no duration for `short` or `long`, which is why the default accent is a double short
pulse rather than `long`: if `long` lasts long (on phone quick apps it is commonly around a second), it would run into
the next beat at fast tempos. Try **Long** on the band and keep whichever you feel best.
The [watch quick app docs](https://watchdoc.quickapp.cn/api/system/vibrator.html) also say vibration is forbidden for
apps running in the background.

Vibrate is called first in each beat, before any UI update, since it is the part that has to be on time.

## Timing

Beats are scheduled against a reference time, not with `setInterval`: beat *k* is due at `base + k × 60000 / BPM`, and
after each beat a `setTimeout` is set for the remaining time to the next one (`src/common/metronome.js`, `advance`).
A late timer therefore delays only that one beat; lateness never accumulates (the tests run 2000 beats with timers up to
40 ms late and every beat stays within 41 ms of the grid). If the app stalls for more than half a beat, the missed beats
are skipped rather than fired in a burst. A tempo change while running starts the new interval from the last beat.

**Precision limits on the band** (not measured, no device at hand): JS timers run on the app's single JS thread, shared
with rendering, so a beat can be late by however long a render or garbage collection takes; timer granularity on Vela
is not documented. Add the latency and spin-up of the vibration motor, which the app cannot see. Expect a beat to land
somewhere in the order of tens of milliseconds late, not sample-accurate like a desktop metronome. Each beat is kept
cheap: one vibrate call, two dot class changes and one class change for the flash (cleared 120 ms later, or after half a
beat at fast tempos).

## Screen and background

- While running, the app calls `brightness.setKeepScreenOn({ keepScreenOn: true })`
  ([`@system.brightness`](https://iot.mi.com/vela/quickapp/en/features/system/brightness.html)) and turns it off on Stop.
  The brightness page has no device support table, so whether the band honours it is unconfirmed; the call is wrapped
  in try/catch.
- On `onHide` (screen off, Back, another app) the metronome stops and the settings are saved at once: vibration is not
  allowed in the background and timers are not reliable there. You have to press Start again after returning.
- Settings are also saved 800 ms after the last change, so holding + does not write to storage on every step.

## Rebuild

Needs Node >= 18. Toolchain: Xiaomi's official `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/metronome
npm test                 # logic checks + page checks (plain node, no install needed)
npm install
npm run build            # debug rpk, toolkit debug key
npm run publish-demo     # copies ../../src/rpk/demo-key/*.pem to sign/, builds
                         # dist/uk.trinh.miband.metronome.release.1.0.0.rpk, copies it + the icon to ../../public/apps/
```

To save disk you can skip `npm install` and run the Calculator's toolkit: `npm run presign && ../calculator/node_modules/.bin/aiot release`,
then copy the rpk and `src/common/logo.png` as `publish-demo` does.

**Signing key**: release builds are signed with the public demo key in `src/rpk/demo-key/` (same as the other demos).
Keep that key: the band may refuse an update signed by a different certificate. `sign/` here is only a gitignored copy.

## Tests

- `test/metronome-check.mjs`: BPM limits and ±1 / ±5 steps, signatures, tap tempo (averaging, reset, tempo change,
  limits), the beat clock (no drift with late timers, early timers, stall skipping, retempo, signature change, 6/8
  accents), the vibration pattern per beat and the saved settings (round trip, garbage ignored).
- `test/page-check.mjs`: loads the page script from `index.ux` with stubbed `@system.vibrator`, `@system.brightness`,
  `@system.storage` and a virtual clock whose timers fire late at random; checks vibrations on the grid with the accent
  on beat 1, the lit dot and flash, tap and hold on − / +, tap tempo, signature change while running, keep-screen-on,
  stop on hide with no timers left, and that the settings are saved and restored. It also checks that every imported
  system module is declared in the manifest.
- `test/metronome-rpk.test.ts` (main repo, vitest): the published rpk is signed with the demo key and matches the catalog.

## Status

Builds with no toolkit warnings; the rpk signature is verified by `src/rpk` (`verifyRpk`). **Not yet run on a real band
or the Vela emulator.** Unconfirmed on the device: how `short` and `long` vibrations feel and how long they last,
whether `setKeepScreenOn` works on the band, real beat jitter, whether `ontouchstart` / `ontouchend` reach the − / +
and Tap buttons when the finger lands on their label (the page assumes touch events bubble to the button `div`), and
the `−` (U+2212) glyph in the system font.
