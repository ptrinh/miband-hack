# Random (demo app for Mi Band 9 / 10)

Random number generator, dice and coin, written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
Demo app for MiBand Hack (`public/apps/random.rpk`). MIT License.

- Package: `uk.trinh.miband.random`, name `Random`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` (same as the other demos)
- Features used: `system.storage` (settings and the no-repeat pool, key `random-state`) and `system.vibrator`
  (one short buzz when a result lands)

## How to use

Three tabs at the top: **123** (number), **Dice**, **Coin**. Tap **Roll** / **Flip** (or the result area itself): the result
cycles through random values for 0.5 s (10 frames of 50 ms), then lands with a short vibration.

- **Number**: a whole number from MIN to MAX, both included (1–100 by default, any range within 0–9999).
  Tap − / + to change by 1; hold to step to the next multiple of 10 every 180 ms (after 450 ms). Raising MIN above MAX
  pushes MAX along, and the other way round.
- **No repeats** (number mode): draws without replacement, for raffles or taking turns. Shows "12 of 30 left";
  when every number has been drawn it says "All 30 drawn" and the button becomes **Start over**. **Reset** starts a
  fresh pool at any time; changing MIN or MAX also starts a fresh pool.
- **Dice**: 1 die, or 2 dice with the sum ("3 + 5 = 8"). Faces are drawn with pips.
- **Coin**: heads (H, gold) or tails (T, silver), with a heads / tails tally for this session.

Mode, range, dice count, the No repeats switch and the numbers drawn so far are saved on the band and restored on the
next launch. The coin tally and the last results are not saved.

Layout: everything sits in a 164 px wide column centred on the screen (14 px side margins, so no button is in the
12 px left-edge strip used by the system Back swipe) and 412 design px tall, which fits the Mi Band 10
(about 192 x 471 design px) and the Mi Band 9. The Roll button stays in the same place in every mode. The app uses no
swipes, so swipe-right stays the system Back gesture.

## Randomness

- **Source: `Math.random()`.** Vela's `crypto` module has no random-bytes call, and its device table lists it as not
  supported on Mi Band 9 / 10 anyway ([Vela docs: crypto](https://iot.mi.com/vela/quickapp/en/features/security/crypto.html)).
  This is fine for games and raffles among friends, not for anything where someone gains by predicting the result.
- **No modulo bias.** `randInt(lo, hi)` in `src/common/random.js` takes 32 bits per draw (`floor(Math.random() * 2^32)`)
  and rejects values at or above the largest multiple of the range size below 2^32, then takes the remainder. Every value
  in the range is then hit by exactly the same number of inputs. A redraw happens with probability below 1 / 2^18 for
  ranges up to 10000.
- **No repeats** stores only the numbers drawn so far. Each draw picks a uniform index k among the numbers left and
  maps it to the k-th number not yet drawn, so every remaining number is equally likely, and a 0–9999 pool costs nothing
  until it is used.

## Vibration

`import vibrator from '@system.vibrator'`, `vibrator.vibrate({ mode: 'short' })`, feature `system.vibrator` in the
manifest. The Vela docs list `vibrate` as supported on Xiaomi Band 9 / 9 Pro and Band 10; `start` / `stop` (custom
patterns) are only supported on the Watch S5
([Vela docs: vibrator](https://iot.mi.com/vela/quickapp/en/features/system/vibrator.html)). The call is wrapped in
`try` so a band without it still rolls.

## Rebuild

Needs Node >= 18. Toolchain: Xiaomi's official `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/random
npm test                 # engine checks + page checks (plain node, no install needed)
npm install
npm run build            # debug rpk, toolkit debug key
npm run publish-demo     # copies ../../src/rpk/demo-key/*.pem to sign/, builds
                         # dist/uk.trinh.miband.random.release.1.0.0.rpk, copies it + the icon to ../../public/apps/
```

To save disk you can skip `npm install` and run the Calculator's toolkit: `npm run presign && ../calculator/node_modules/.bin/aiot release`,
then copy the rpk and icon as `publish-demo` does.

**Signing key**: release builds are signed with the public demo key in `src/rpk/demo-key/` (same as the other demos; see the
README there). Keep that key: the band may refuse an update signed by a different certificate. `sign/` here is only a gitignored copy.

The toolkit compiles inside a temporary sibling folder `../.temp_random` and removes it when done.

## Tests

- `test/random-check.mjs`: exact bounds (including the edge inputs of the 32-bit mapping and a draw from the rejected
  tail), a bias check that plain modulo would fail, chi-square uniformity for 1–10, 1–100 and dice (seeded generator and
  `Math.random`), two-dice sum distribution, coin balance, pip layout, the − / + steps and clamping, draws without
  replacement (every number exactly once, then exhausted; uniform among those left), and parsing of saved settings
  (corrupt or out-of-range values fall back to defaults).
- `test/page-check.mjs`: loads the page script from `index.ux` with stubbed `@system.storage`, `@system.vibrator` and
  timers, and drives the handlers: 10 frames / 500 ms per roll and exactly one short buzz, taps ignored while rolling,
  tap and hold on − / + (one save per press, hold stops on release, on hide, or by itself), No repeats until "All 5
  drawn" and Start over, Reset, dice and coin, and that settings and the pool are restored on the next launch.
- `../../test/random-rpk.test.ts` (root `npm test`): the published rpk is valid, signed with the demo key, and declares
  `system.storage` and `system.vibrator`.

## Status

Builds with no toolkit warnings; the rpk signature is verified by `src/rpk` (`verifyRpk`). Not yet run on a real band or
the Vela emulator. Unconfirmed on the device: that `ontouchstart` / `ontouchend` on the − / + buttons arrive as expected
(and `touchend` arrives when the finger slides off the button; a hold stops by itself after 120 steps otherwise), the
feel of the vibration, `lines: 1` and `border-style` on the band, text widths with the band's font (MiSans), the quality
of the band's `Math.random()`, and how quickly `storage.set` writes after each draw.
