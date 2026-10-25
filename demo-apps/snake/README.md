# Snake (demo mini game for Mi Band 9 / 10)

Classic Snake written as a Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`.
Demo app for MiBand Hack (`public/apps/snake.rpk`). MIT License.

- Package: `uk.trinh.miband.snake`, name `Snake`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]` (same as the other demos)
- Feature used: `system.storage` (best score, key `snake-best`)

## How to play

- **Swipe** up / down / left / right to steer, or **tap the left / right half** of the screen to turn left / right
  (relative to the snake's heading). Both work at any time; turns typed faster than the snake moves are queued (up to 2).
- Eat the red food to grow and score. Each food makes the next tick 6 ms shorter (280 ms down to a floor of 130 ms).
- Hitting a wall or the snake's own body ends the game; tap to play again. Filling the whole board is a win.
- **Back** (system swipe from the left edge) pauses; Back again while paused leaves the app. The game also pauses when
  the app is hidden (screen off, another app). Tap to resume.

The field is 15 x 32 cells of 12 design px (180 x 384), with the score bar above it: 426 design px in all, which also
fits the Mi Band 10 (its screen scales to about 192 x 471 design px).

## How it renders (no `<canvas>`)

Like the Drawing demo, no `<canvas>` (Vela documents no 2D context): each body cell is a small absolutely positioned `div`.
To keep the band's work per tick small, the page never re-renders the body:
- `src/common/snake.js` (pure JS, no platform APIs) reports per step only the new head cell and the freed tail cell.
- The page keeps a queue of which `div` holds which body cell. On a normal move the tail's `div` is moved to the new head
  (two style changes); when the snake grows one `div` is appended. Plus the head marker and, after eating, the food.
- The full list is rebuilt only when a new game starts.

Back gesture: a touch that starts in the 12 px strip at the left edge is ignored by the game, so the system swipe-right-to-go-back
works from there. `onBackPress` swallows a back that fires during or within 400 ms of a steering swipe.

## Rebuild

Needs Node >= 18. Toolchain: Xiaomi's official `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/snake
npm test                 # engine checks + page checks (plain node, no install needed)
npm install
npm run build            # debug rpk, toolkit debug key
npm run publish-demo     # copies ../../src/rpk/demo-key/*.pem to sign/, builds
                         # dist/uk.trinh.miband.snake.release.1.0.0.rpk, copies it + the icon to ../../public/apps/
```

To save disk you can skip `npm install` and run the Calculator's toolkit: `npm run presign && ../calculator/node_modules/.bin/aiot release`.

**Signing key**: release builds are signed with the public demo key in `src/rpk/demo-key/` (same as Notes; see the README
there). Keep that key: the band may refuse an update signed by a different certificate. `sign/` here is only a gitignored copy.

The toolkit compiles inside a temporary sibling folder `../.temp_snake` and removes it when done.

## Tests

- `test/snake-check.mjs`: movement, turn rules (no reversal, queue cap, relative turns), wall and self collision,
  entering the cell the tail leaves, growth, food never on the snake, win on a full board, speed curve.
- `test/page-check.mjs`: loads the page script from `index.ux` with a stubbed `@system.storage` and timers, plays
  random games through the touch handlers, and checks after every tick that the moved `div`s match the engine's body;
  also pause on Back / hide, the left-edge rule and that the best score is saved and restored.

## Status

Builds with no toolkit warnings; the rpk signature is verified by `src/rpk` (`verifyRpk`). Not yet run on a real band or
the Vela emulator. Unconfirmed on the device: that mutating one item of the `segs` array moves only that `div`, touch
coordinates / swipe feel, `rgba()` overlay colour, and whether the screen timeout interrupts long games (the app pauses on hide).
