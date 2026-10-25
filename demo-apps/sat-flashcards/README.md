# SAT Flashcards (demo quick app for Mi Band 9 / 10)

Learn SAT vocabulary on the band: a card shows a word, tap to flip to its definition and an example, then
**Know it** or **Again**. Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`. MIT License.

- Package: `uk.trinh.miband.sat`, name `SAT Flashcards`, version `1.0.0` (versionCode 1)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]`, features `system.storage` and `system.router`
- Pages: `pages/index` (the cards) and `pages/stats` (learned / total with a bar, seen, new, due, mastered, count per box,
  **Reset progress** (tap twice), **‹ Back** button; system swipe-back works too). Back on the card page leaves the app, like Notes.
- Word list: `src/common/words.js`, 372 common SAT words as `[word, part of speech, definition, example]`. Written for this
  app, not copied from a published list. Definitions are at most 40 characters and examples 42, so a card back fits without scrolling.

## Spaced repetition

`src/common/srs.js` is a small Leitner scheduler (pure JS, tested in plain node):
- Every seen word sits in box 0..5 with a due day. Intervals per box: 0, 1, 3, 7, 14, 30 days.
- **Know it** moves the word up one box (a word known on first sight goes straight to box 2). **Again** drops it to box 0, due
  today, and it comes back after 3 other cards.
- Next card: due words first (lowest box, then oldest), then a new word, in a fixed shuffled order so the alphabetical list is
  not learned a-to-z. When every word has been seen and nothing is due the page says "All done!".
- "Learned" = box 2 or higher. "Mastered" = box 5.
- Progress is saved with `@system.storage` (key `sat-v1`) after every answer as `word:box:dueDay;…` (a few KB). It is keyed by the
  word, so a later version can add, remove or reorder words without losing progress.

## Rebuild

Requires Node >= 18. Toolchain: `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/sat-flashcards
npm install
npm test                 # word list + scheduler checks (plain node, not part of the main vitest suite)
npm run build            # debug build, toolkit debug key
npm run publish-demo     # release build signed with ../../src/rpk/demo-key, copied to ../../public/apps/sat.rpk and sat.png
cd ../.. && npx vitest run test/sat-rpk.test.ts   # checks the published rpk, its signature and the catalog entry
```

To save disk you can skip `npm install` and run another demo's toolkit: `npm run presign && ../notes/node_modules/.bin/aiot release`.

**Signing key**: like Notes, release builds use the *public demo key* in `src/rpk/demo-key/` (copied to the gitignored `sign/`).
Keep it: the band may refuse an update signed by a different certificate.

The toolkit compiles inside a temporary sibling folder `../.temp_sat-flashcards` and removes it when done.

## Status

Builds with no toolkit warnings; the scheduler and word list are checked by `npm test`, the package and signature by
`test/sat-rpk.test.ts`. Not yet run on a real band or the Vela emulator. Still unconfirmed: text wrapping and font sizes on the
real screen, and that `storage.delete` (used by Reset) behaves as documented.
