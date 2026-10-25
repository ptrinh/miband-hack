# Flashcards: custom decks (demo quick app for Mi Band 9 / 10)

Study your own flashcard decks on the band: IELTS words, HSK Chinese, Japanese, formulas, capitals, anything. The
decks are written in the web app (miband.trinh.uk, "Edit decks" under Flashcards in the catalog) and are **not compiled
into the app**: like Notes, the browser swaps the deck files inside the `.rpk` and re-signs it (`src/rpk/flashcards.ts`
on top of the shared `src/rpk/custom.ts`). MIT License.

- Package: `uk.trinh.miband.flashcards`, name `Flashcards`, version `1.0.0` (versionCode 1; every re-pack from the web
  app gets a newer version code, `customVersionCode()`)
- `designWidth: 192`, `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]`, features `system.file`, `system.storage`,
  `system.router`
- Pages:
  - `pages/index`: deck list (name, card count or "learned / total"), tap a deck to study it. "No decks yet" when empty.
  - `pages/study`: Cards mode (tap to flip, **Know it** / **Again**) or Quiz mode (four choices). Back = system swipe back
    to the deck list. Tap the learned count at the top right for the stats page.
  - `pages/stats`: deck name, **Cards / Quiz** switch, learned / total with a bar, seen, new, due, mastered, per box,
    quiz answers, accuracy, best streak, **Reset this deck** (tap twice), **‹ Back**.
- Only taps are used (a swipe right is the system Back), and every page keeps a 14 px left padding so nothing to tap
  sits in the 12 px left edge strip.

## Data format

Written by `src/decks/model.ts` (`bandFiles()`), read by `src/common/decks.js` with `@system.file` `readText`:

- `/common/decks.json`: `{"v":1,"decks":[{"id":"…","name":"…","n":8,"file":"/common/deck0.json"}]}`
- `/common/deck<N>.json`: `{"v":1,"id":"…","name":"…","cards":["id\tfront\tback\tnote", …]}`. One string per card,
  as in SAT Flashcards' `words.js` (far fewer objects for the band's JS engine); the web app turns tabs and line breaks
  in the text into spaces, so a tab only separates fields.

Only the open deck is read into memory. The template rpk ships the English sample deck (`src/common/decks.json`,
`src/common/deck0.json`, generated with `bandFiles()`; `test/flashcards-rpk.test.ts` checks they match).

**Progress survives edits**: a card's id is a hash (FNV-1a) of its cleaned front and back, computed by the web app.
Progress is saved per deck id (`fc-p-<deckId>`, `cardId:box:dueDay;…`), so after editing and re-installing a deck,
unchanged cards keep their box (even if moved or given a new note); changed or new cards start as new; removed ones are
ignored. Quiz totals are per deck (`fc-q-<deckId>`), the mode is shared (`fc-mode`), and the deck list's learned counts
are cached in `fc-sum`.

## Shared with SAT Flashcards

- `src/common/srs.js`: **copied unchanged** (Leitner boxes 0..5, intervals 0/1/3/7/14/30 days, "Again" returns after 3
  cards). New cards come in the order the user wrote them (no shuffle).
- `src/common/quiz.js`: adapted. Same question shape, scoring and storage format (score code unchanged). Questions are
  front → back or back → front at random. Distractors come from the same deck; a card whose front **or** back equals the
  answer's is never offered as wrong (synonyms, homographs), choice texts never repeat, and choices of the same script
  (CJK or not) and similar length are preferred. The quiz needs at least 4 cards: below that the stats page greys
  out Quiz with "Quiz needs 4 or more cards", and the study page stays in Cards mode.
- `src/common/deck.js`: same idea as SAT's (`keysOf`, `entryAt`), tab-separated, plus `textWidth` (CJK / kana /
  Hangul / full-width count 2) and `sizeClass`, which picks a smaller font for longer text (front 32 → 16 px, back
  22 → 14 px, quiz choices 21 → 13 px with a 3-line ellipsis). The back of a card is a `<list>`, so long text scrolls.
- Pages: study and stats are SAT's pages with per-deck storage keys.

## Limits (enforced in the web app editor with messages)

| Limit | Value | Why |
|---|---|---|
| Front / back / note | 60 / 120 / 120 characters | readable at 14-22 px on 192 x 471 design px; a quiz choice is a quarter of the screen |
| Cards per deck | 500 | one deck is parsed into memory, the scheduler loops over it on every tap |
| Cards in total | 2,000 | all decks travel in the rpk on each install |
| Decks | 30 | |
| Deck file / all decks | 96 KB / 512 KB (UTF-8) | CJK text is 3 bytes a character; SAT's 1,355 words are a 99 KB page script |

The template `.rpk` is 28 KB. Packing 2,000 short cards adds about 60-100 KB.

## Rebuild

Requires Node >= 18. Toolchain: `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/flashcards
npm test                 # deck format, sizing, scheduler with card ids, quiz (plain node)
npm install              # or reuse another demo's toolkit, see below
npm run publish-demo     # release build signed with ../../src/rpk/demo-key → ../../public/apps/flashcards.rpk and .png
cd ../.. && npx vitest run test/flashcards-rpk.test.ts test/decks.test.ts
```

To save disk, skip `npm install` and run another demo's toolkit:
`npm run presign && node ../calculator/node_modules/aiot-toolkit/lib/bin.js release`.
Release builds use the *public demo key* in `src/rpk/demo-key/` (the key the browser re-signs with). The toolkit compiles
in `../.temp_flashcards` and removes it when done.

## Status

Builds with no toolkit warnings; logic checked by `npm test` here, the editor model (CSV/TSV/JSON import, validation,
ids) by `test/decks.test.ts`, the template and re-packed packages by `test/flashcards-rpk.test.ts`. **Not yet run on a
real band or the Vela emulator.** Unconfirmed:

- that `readText` reads the files the browser adds (`/common/deck1.json` …) on Mi Band firmware (same assumption as Notes);
- CJK and Vietnamese rendering: the band's system font (MiSans) covers Chinese and Latin with Vietnamese diacritics on
  Chinese-market firmware, but glyph coverage for Japanese kana, Korean and rare characters, and fallback on global
  firmware, are unverified; the previews use the Mac's fonts;
- `lines` / `text-overflow` on `<text>`, `onclick` on a `<list>`, and how long text wraps on the real screen;
- memory and speed with a 500-card deck, and `storage.delete` (Reset).
