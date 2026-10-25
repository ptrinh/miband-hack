# Checklist (quick app for Mi Band 9 / 10)

Shopping, to-do and packing lists on the band: tap an item to tick it off. The lists are written in the web app and
are **not compiled into the app**: like Notes, they live in `/common/lists.json` inside the `.rpk`, and the web app swaps
that file and re-signs the package in the browser (`src/rpk/checklist.ts`, `buildChecklistRpk()`). Tick state is kept on
the band. MIT License.

- Package: `uk.trinh.miband.checklist`, name `Checklist`, version `1.0.0` (versionCode 1; re-packed builds get a newer
  versionCode from the web app)
- `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]`, `designWidth: 192`, features `system.file`, `system.storage`,
  `system.router`

## Pages

- `pages/index`: every list with its progress (`3/8`, a bar, green when complete). Tap a list to open it.
- `pages/list`: **‹ Back** button and the count at the top, the list title, then the items. Tap an item (the whole
  56 px row) to tick or untick it: a filled green circle, dimmed, struck-through text. Long items wrap; long lists scroll
  (`<list>`). **Uncheck all** appears once something is ticked and needs a second tap within 3 s (it turns red and says
  **Tap again**; ticking an item cancels it). The system swipe-back gesture works too: nothing on the pages listens to
  swipes, and the page content starts 12 px from the left edge.

Ticked items stay where they are (they do not move to the bottom), so the rows never shift under your finger.

## Data

`src/common/lists.json` (UTF-8, the bundled sample; the web app replaces it):

```json
{"lists":[{"id":"shop1","title":"Shopping","items":[{"id":"s1","text":"Milk"}]}]}
```

Ids are `[a-z0-9]{1,16}` and unique across the file; the web app generates random 8-character ids and keeps them when
you edit, reorder or export. Lists and items with invalid or duplicate ids, blank items, and lists with neither title nor
items are skipped (`normalize()` in `src/common/model.js`). Limits set by the web app editor: 30 lists, 100 items per
list, 40 characters per title, 100 per item, 100 KB for the file.

Ticks are stored with `@system.storage` under the key `checklist-ticks` as `listId:itemId,itemId;listId2:itemId`
(`src/common/model.js`, `parseTicks` / `serializeTicks`). Because they are keyed by ids, re-installing the app with edited
lists keeps the ticks of items that still exist (even if reworded or moved), and new items start unticked. The home page
drops the ticks of removed lists and items each time it is shown, so the value does not grow.

## Code

- `src/common/model.js`: pure functions (normalize, ticks parse/serialize/prune, toggle, uncheck all, progress), no
  platform APIs.
- `src/common/data.js`: reads `/common/lists.json` with `@system.file` `readText` (not `import`ed, so it stays a separate
  file the web app can swap; same approach as Notes) and loads/saves ticks with `@system.storage`.

## Tests

```bash
npm test
```

- `test/model-check.mjs`: normalize, tick round trip, pruning after an edit, many items.
- `test/page-check.mjs`: loads both page scripts from the `.ux` files with stubbed `@system.file`, `@system.storage`,
  `@system.router` and timers, and walks through: list of lists with progress, open, tick / untick, Back and the
  updated progress, Uncheck all (timeout, cancelled by a tick, confirmed), re-install with edited lists, a missing list,
  an unreadable file.
- `../../test/checklist.test.ts` (main `npm test`): the web app side (import normalization, cleaning, ids, limits), that
  the band's `model.js` reads what the web app writes and keeps ticks across an edit, the catalog entry, and that the
  published rpk and a re-packed one verify and are signed with the demo key.

## Rebuild

Requires Node >= 18. Toolchain: `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/checklist
npm install
npm run build            # debug build, toolkit debug key
npm run publish-demo     # copies ../../src/rpk/demo-key/*.pem to sign/, builds
                         # dist/uk.trinh.miband.checklist.release.1.0.0.rpk, copies it + the icon to ../../public/apps/
cd ../.. && npx vitest run test/checklist.test.ts
```

To save disk you can skip `npm install` and run the Calculator's toolkit: `npm run presign && ../calculator/node_modules/.bin/aiot release`.

**Signing key**: release builds are signed with the public demo key in `src/rpk/demo-key/` (same as Notes; see the README
there), the same key the browser uses to re-sign. Keep that key: the band may refuse an update signed by a different
certificate. `sign/` here is only a gitignored copy.

The toolkit compiles inside a temporary sibling folder `../.temp_checklist` and removes it when done.

## Status

Builds with no toolkit warnings; the rpk signature is verified by `src/rpk` (`verifyRpk`), and re-packing in the browser
was checked in headless Chrome (WebCrypto). **Not yet run on a real band or the Vela emulator.** Unconfirmed on the device:
that `readText` reads `/common/lists.json` (same open question as Notes), that `@system.storage` keeps the ticks across an
app update, that mutating `rows[i].done` re-renders only that row, how `text-decoration: line-through`, `lines` and the
3 px circle border render, and the touch feel of the rows.
