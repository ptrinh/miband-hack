# Demo app screenshots

The images shown when you tap a demo app on the site (`public/apps/screens/*.png`) are **previews rendered from each
app's own layout and styles, not photos of a real band.** We have no Mi Band 10 at hand and no Vela emulator, so each
screen is rebuilt in a browser and captured with headless Chrome.

```bash
node tools/screenshots/render.mjs              # all screens
node tools/screenshots/render.mjs snake-1      # one screen
```

Needs Node 22+ and Google Chrome (`CHROME=/path/to/chrome` if it is not in `/Applications`). No npm dependencies.
Re-run it after changing an app's `.ux` styles, then check the images.

## How it works

- `screens/<name>.html` is the markup of one app page in a fixed, realistic state: the `.ux` `<template>` with its
  `{{bindings}}` filled in, using the same `<text>`, `<list>` and `<list-item>` tags. Its first line names the page, e.g.
  `<!-- ux: demo-apps/calculator/src/pages/index/index.ux -->`. The `<style>` block of that file is copied in unchanged.
  Screens can import an app's own engine (Drawing uses `sketch.js` to lay out the stroke dots).
- `vela.css` copies Vela's layout defaults: every element is a flex container, `flex-direction` defaults to **row**
  (Vela quick app docs, general styles), `position: absolute` is relative to the parent, `<text>` defaults to 30px.
- The frame is a simplified Mi Band 10: a 1.72" AMOLED, 212 x 520 px (Xiaomi spec page). With `designWidth: 192` the
  band scales design px by 212 / 192, so the screen is 192 x 471 design px. The bezel and the 40px screen corner radius
  are approximations.
- `render.mjs` serves the pages locally, drives Chrome over the DevTools protocol, captures the `#device` element at 2x
  (420 x 978, transparent outside the bezel) and re-compresses the PNG losslessly (`png.mjs`). It prints a warning, and
  exits with code 1, when an element sticks out of the screen or its text overflows its box.
- `public/apps/catalog.json` lists each app's images under `screenshots` with `alt` text in en / zh / vi.
  `test/catalog-screens.test.ts` checks that the files exist and that every rendered PNG is listed.

## Known differences from the band

- Fonts: the band uses Xiaomi's system font (MiSans). The render uses the system font of the machine (SF Pro on macOS),
  so widths and line breaks can be slightly off.
- Line height is not documented for Vela; `vela.css` uses 1.15.
- Vela-only style properties (`lines`, `text-overflow` on `<text>`) are ignored by the browser.
