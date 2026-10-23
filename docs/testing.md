# Testing (`dev/`)

Node-only harness, not part of the extension.

## Setup
`cd dev && npm i` (Playwright). It uses Playwright's bundled Chromium with `channel: 'chromium'`, so the unpacked extension loads headless.

## Core: `node dev/edits-test.js`
Edit model (`upsert` keeps the first `from`, drops no-ops), `describe`, Tailwind v4/v3 mapping, related classes (responsive variants only), responsive prefix, markdown + JSON export.

## End to end: `npm run serve` (in `dev/`), then `node dev/e2e-edit.js`
Fixture `dev/edit.html`: header, hero with an absolute badge, a 3-card grid, a paragraph stack, a strict CSP meta, Tailwind-v4-style `:root` vars and Astro source attributes. The script drives the real mouse and keyboard and asserts the resulting CSS, the stored edits and the exported markdown. It finishes by checking that closing the panel leaves the DOM identical, and that a JPEG overlay, Difference mode and Move mode still work. `SHOTS=1` saves `dev/shot-edit-*.png`.

If a step fails after a UI change, run with `SHOTS=1` and look at the screenshots first: most failures are a click landing on a handle that moved.
