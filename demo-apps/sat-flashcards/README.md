# SAT Flashcards (demo quick app for Mi Band 9 / 10)

Learn SAT vocabulary on the band, in two modes that share one review schedule:
- **Cards**: a card shows a word, tap to flip to its definition and an example, then **Know it** or **Again**.
- **Quiz**: pick the right answer out of four, then see the word's definition and example.

Xiaomi Vela JS quick app (`.ux`), packaged as `.rpk`. MIT License.

- Package: `uk.trinh.miband.sat`, name `SAT Flashcards`, version `1.1.0` (versionCode 2)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]`, features `system.storage` and `system.router`
- Pages: `pages/index` (cards or quiz) and `pages/stats` (**Cards / Quiz** mode switch, learned / total with a bar, seen,
  new, due, mastered, count per box, quiz answers, quiz accuracy, best streak, **Reset progress** (tap twice), **‹ Back**
  button; system swipe-back works too). Tap the learned count at the top right of the card page to get there. Back on the
  card page leaves the app, like Notes. No gesture other than taps is used (a swipe right is the system Back).
- Word list: `src/common/words.js`, 1355 common SAT words, each one string `"word|part of speech|definition|example"`.
  Written for this app, not copied from a published list. Definitions are at most 40 characters and examples 42, so a
  card back fits without scrolling. Version 1.0.0 had 372 words; all of them are still there under the same spelling, so
  saved progress carries over (only the order in which new words are introduced changed).

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

## Quiz

`src/common/quiz.js` (pure JS, tested in plain node):
- The next word comes from the same scheduler as the cards (due words first, then new ones). Each question is, at random,
  **word → definition** (the word is shown, pick its definition) or **definition → word**.
- The three wrong choices are other words of the **same part of speech**, so the grammar of a definition gives nothing
  away. A candidate is skipped when it is too close to the answer or to another choice: the definitions share a key word
  (five-letter stems, minus words like "the" or "very"), one word appears in the other's definition, or the words start
  alike ("compel" / "compelling"). Near-synonyms in the list are therefore given a shared key word in their definitions
  ("careful with money" / "careful with money; saving"). Candidates are probed at random, so a question costs a few
  string splits, not a pass over the whole list. The answer's position is shuffled.
- Tapping a choice colours it at once: the right answer green, a wrong pick red, the rest dimmed. After 0.7 s the
  answer card follows (word, part of speech, definition, example, "Correct!" with the streak or "Not quite"), then
  **Next ›** (or tap the card).
- Grading goes through the Leitner scheduler: right = **Know it**, wrong = **Again**. Quiz and cards share progress.
- The header shows the session score as a percentage (it has to share the line with the learned count). All-time totals
  (answers, right answers, best streak) are saved under `sat-quiz` as `answered:correct:best:streak`; the stats page shows
  them as quiz answers, accuracy and best streak. **Reset progress** clears them too.
- The mode is saved under `sat-mode` and picked on the stats page (tapping a mode goes straight back to the card page).
- No vibration: the manifest only declares `system.storage` and `system.router`, so feedback is colour only.

## Size and memory on the band

The words are bundled into `pages/index/index.js` (webpack puts every import into the page's script; a quick app has no
way to load more JS from the package later, and reading a data file would need `@system.file`, untested here, so the
list is not split into chunks). To keep it light:
- One string per word instead of an array of four strings: with the extracted words about 2,700 strings in memory
  instead of about 6,800 for the same list, and the source parses as a flat list of literals.
- At startup the page extracts only the words (`keysOf`, used by the scheduler); an entry is split into its fields only
  when it is shown or probed as a quiz choice.
- `.rpk` 1.0.0 (372 words) was 32,660 bytes with a 36 KB `pages/index/index.js`; 1.1.0 (1355 words, quiz) is about 56 KB
  with a 99 KB `pages/index/index.js` (37 KB compressed). The stats page does not import the list.
- Each tap still runs the scheduler over all 1355 words (two loops of property lookups: about 0.02 ms in node on a Mac;
  the band is far slower but this should stay in the low milliseconds). Not measured on the band.

## Rebuild

Requires Node >= 18. Toolchain: `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/sat-flashcards
npm install
npm test                 # word list, scheduler and quiz checks (plain node, not part of the main vitest suite)
npm run build            # debug build, toolkit debug key
npm run publish-demo     # release build signed with ../../src/rpk/demo-key, copied to ../../public/apps/sat.rpk and sat.png
cd ../.. && npx vitest run test/sat-rpk.test.ts   # checks the published rpk, its signature and the catalog entry
```

To save disk you can skip `npm install` and run another demo's toolkit: `npm run presign && ../notes/node_modules/.bin/aiot release`.

**Signing key**: like Notes, release builds use the *public demo key* in `src/rpk/demo-key/` (copied to the gitignored `sign/`).
Keep it: the band may refuse an update signed by a different certificate.

The toolkit compiles inside a temporary sibling folder `../.temp_sat-flashcards` and removes it when done.

## Status

Builds with no toolkit warnings; the scheduler, quiz and word list are checked by `npm test`, the package and signature by
`test/sat-rpk.test.ts`. Not yet run on a real band or the Vela emulator. Still unconfirmed: text wrapping and font sizes on the
real screen, that `storage.delete` (used by Reset) behaves as documented, that the `for` loop of quiz choices re-renders when
the choices are recoloured, the startup time and memory use with 1355 words, and that `border-width` on the answer card
renders as in the preview.
