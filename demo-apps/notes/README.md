# Notes (read-only quick app for Mi Band 9 / 10)

Shows a list of notes and the text of each note. The notes are **not compiled into the app**: they live in
`/common/notes.json` inside the `.rpk`, and the web app swaps that file and re-signs the package in the browser
(`src/rpk/`, `buildNotesRpk()`). MIT License.

- Package: `uk.trinh.miband.notes`, name `Notes`, version `1.0.0` (versionCode 1)
- `minPlatformVersion: 1000`, `deviceTypeList: ["watch"]`, `designWidth: 192`, features `system.file` and `system.router`
- Pages: `pages/index` (list of titles, "No notes" when empty) and `pages/detail` (title + body, scrollable, **‹ Back** button;
  system swipe-back works too). Read-only, nothing is written on the band.
- Data format (`src/common/notes.json`, UTF-8): `{"notes":[{"title":"…","body":"…"}]}`. Line breaks in `body` are shown
  as separate paragraphs. Entries with neither title nor body are skipped.

## How the notes are read

`src/common/notes.js` calls `@system.file` `readText({ uri: '/common/notes.json' })`. The Vela docs say `readText` accepts
app resource paths (example `'/Common/demo.txt'`). The file is **not** `import`ed, because an import would inline it into
the compiled page JS. The toolkit copies `.json` files from `src/` into the package unchanged, so `common/notes.json` stays
a separate entry in the rpk.

## Rebuild

Requires Node >= 18. Toolchain: `aiot-toolkit` 2.0.5 (CLI `aiot`).

```bash
cd demo-apps/notes
npm install
npm run build            # debug build, toolkit debug key
npm run release          # copies ../../src/rpk/demo-key/*.pem to sign/, then builds dist/uk.trinh.miband.notes.release.1.0.0.rpk
npm run publish-demo     # release + copy to ../../public/apps/notes.rpk and notes.png
cd ../.. && npx vitest run test/rpk-sign.test.ts   # verifies the new template against src/rpk
```

To save disk you can skip `npm install` and run the Calculator's toolkit: `npm run presign && ../calculator/node_modules/.bin/aiot release`.

**Signing key**: release builds are signed with the *public demo key* in `src/rpk/demo-key/` (committed on purpose, see
the README there), the same key the browser uses to re-sign. Keep that key: the band may refuse an update signed by a different
certificate. `sign/` here is only a gitignored copy.

The toolkit compiles inside a temporary sibling folder `../.temp_notes` and removes it when done.

## Status

Builds with no toolkit warnings, and the package structure and signatures are verified by `test/rpk-sign.test.ts`. Not yet run on a
real band or the Vela emulator. Still unconfirmed: that `readText` really reads `/common/notes.json` on Mi Band firmware, and how
`lines`/`text-overflow` render.
