# Parity — project context for coding agents

Parity is a personal Chrome extension (Manifest V3, plain JavaScript, no build step). It is a better PerfectPixel: it overlays Figma JPEG exports on a live page, one per breakpoint, and it **automatically detects mismatches**. It then writes a structured JSON report for coding agents, saying which HTML element is offset or mis-sized and how to fix it.

Owner: a digital/brand designer who builds sites with Astro and Tailwind, often fed by a headless Umbraco CMS. The pages being debugged are **demo pages with exactly the same content as the Figma JPEG**, with **minimal animation**. Keep the UI tasteful: dark panel, lime accent `#c8ff3d`.

## Hard constraints
- No build tooling, no dependencies, no frameworks in the extension itself. Plain ES2020+, loaded unpacked.
- Must work on any site, including ones with a strict CSP. That is why:
  - the overlay is drawn into a `<canvas>` (decoded via `createImageBitmap`), not an `<img src=blob:>`
  - all UI lives in shadow DOM hosts marked `data-parity`
- Never leave the debugged page altered. Freeze styles, the pick-mode cursor style and the hosts are all removed on close.
- `analyzer-core.js` must stay pure: no DOM, and it runs both in a Web Worker and in Node for tests.

## Files
| File | Runs in | Role |
|---|---|---|
| `manifest.json` | — | MV3. Permissions: `activeTab scripting storage unlimitedStorage debugger downloads tabs`, host `<all_urls>`. Commands: `_execute_action` (⌥⇧P) and `analyze` (⌥⇧A). |
| `background.js` | service worker | Injects scripts, toggles the panel, re-injects after reload (state in `chrome.storage.session` → `tabs`), viewport control (CDP emulation or window resize), full-page capture, opens the report tab. |
| `collect.js` | content (isolated world) | `globalThis.ParityCollect = { collect, prepare, setFreeze, uniqueSelector }`: DOM walk and capture preparation. Injected **before** `content.js`. |
| `content.js` | content | Floating panel, overlay canvas, split handle, on-page issue layer, keyboard shortcuts, paste/drop of JPEGs, **pick mode** (click to copy classes). |
| `analyzer-core.js` | worker + Node | `ParityCore.analyze()`: image matching and root-cause logic. Exports `module.exports` in Node and `self.ParityCore` in the worker. |
| `analyzer-worker.js` | Web Worker | Decodes capture segments and the design JPEG with `OffscreenCanvas`, then calls `analyze`. |
| `report.html/.css/.js` | extension page | Runs the worker, renders the viewer (side-by-side / overlay / difference), issue list, agent JSON/prompt export, auto-download. |
| `icons/` | — | 16/32/48/128 PNGs. |
| `dev/` | Node | Test harness. Not used by the extension. |

## Data model (`chrome.storage.local`)
- `proj:<origin+pathname>` → `{ v, breakpoints[], activeId, overlay:{visible, opacity, mode:'normal'|'difference'|'split', invert, align:'left'|'center', splitX}, viewport:{match, mode:'emulate'|'window'}, freeze, showIssues, contentMode:'same'|'tolerant', ignore:[selectors], scope:{selector, label}|null, scopeAlign, panel:{x, y, collapsed} }`
- Breakpoint: `{ id, name, width (CSS px), scale (export @Nx), vh (null = window height), offsetX, offsetY, imgId, imgW, imgH, file, figmaUrl?, sections?: { [selector]: {imgId, imgW, imgH, file} } }`
- **Section scope keys**: `cap`, `rep` and `crop` keys get a suffix `@<fnv1a(selector) base36>` when a scope is active (`scopeKey()`, duplicated in background/content/report). The report URL carries it as `&s=`. `crop:<key>:<bpId>@…` → `{ site, design }` aligned crop images (data URLs) for the viewer.
- `img:<imgId>` → design data URL
- `cap:<key>:<bpId>` → `{ id, capturedAt, url, title, tabId, key, bp, width, vh, docHeight, truncated, nodes[], breakpoints (stylesheet scan), shots:[{y, h, data(png dataURL)}] }`
- `rep:<key>:<bpId>` → analyzed report: `{ capId, …, page, stats, contentMode, ignored, projectBreakpoints, ledger, issues, figma?, diff, previous }`. It's stale when `rep.capId !== cap.id`; the report page re-analyzes on load. `previous` keeps a compact copy of the last run's issues for the fix-check diff.
- `parity:settings` → `{ tolerance:2, autoSave:true, saveImages:false, folder:'parity', keys:true, figmaToken:'' }`
- Don't use `storage.onChanged` in content scripts: it broadcasts multi-MB values to every tab. Notify tabs with messages instead (`parity:report-ready`).

## Messages
- content → SW:
  - `parity:viewport {width, vh, mode}`
  - `parity:viewport-release`
  - `parity:analyze {key, bps[], viewport:{match, bp}}`
  - `parity:open-report {key, bpIds}`
  - `parity:closed`
  - `parity:download`
- SW → content:
  - `parity:toggle`
  - `parity:open`
  - `parity:measure`
  - `parity:prepare-capture` → `{ok, nodes, width, docHeight, vh, truncated}`
  - `parity:capture-done`
  - `parity:progress {label}`
  - `parity:analyze-shortcut`
  - `parity:detached`
- report → SW: `parity:analyze` with an explicit `tabId` (Re-analyze).
- report → content: `parity:report-ready {key, bpId}`.
- Report URL: `report.html?k=<key>&b=<bpId,bpId>&t=<tabId>`. An existing report tab for the same key is reused.

## Capture pipeline (`background.js` → `captureBreakpoint`)
1. `chrome.debugger.attach` (CDP 1.3). Chrome shows a "debugging" infobar; the `--silent-debugger-extension-api` flag hides it.
2. CDP calls:
   - `Emulation.setDeviceMetricsOverride {width: bp.width, height: bp.vh || tab height, deviceScaleFactor: 1, scale: 1}`
   - `setScrollbarsHidden`
   - `setEmulatedMedia prefers-reduced-motion: reduce`
3. Content `prepare()`:
   - freeze CSS (animations and transitions set to 0s, i.e. their end state; WAAPI animations `finish()`, infinite ones `pause()`)
   - `loading=lazy` → eager
   - scroll through the page, back to top
   - wait for fonts and images, then 2 rAF
4. Then `collect()`.
5. `Page.captureScreenshot {captureBeyondViewport: true, clip, scale 1}` in 4000px segments, max 30,000px. Verified: this keeps `100vh` at the emulated height.
6. Restore the interactive viewport, then open the report.

Interactive emulation uses `deviceScaleFactor: 0` and `scale = min(1, tabWidth / bpWidth)` to fit wide breakpoints. Window mode resizes `chrome.windows` with a correction pass. Chrome's minimum window width is about 500px, so narrower widths fall back to emulation.

## DOM node shape (`collect.js`)
`{ i, p (parent index or -1), d, tag, box, ink, tink, tm, bv, media, id, cls, text, label, attrs, sel, st, src, blk, ig }`
- `tm` (text nodes): first-line `capTop`, `baseline`, `lastBaseline`, `capH`, `capRatio`, `lines`, `x0/x1`, `lineBox`. Derived from Range line fragments plus canvas font metrics (`measureText('H')` / font ascent).
- `src`: `data-astro-source-file` (trimmed to `src/…`) and `-loc` when the element carries them (Astro dev mode). `blk`: set on `<section>` and on elements with `data-block*` / `data-content-type` / `data-component` / `data-umb*` attributes. `ig`: element matched an ignore selector; its subtree is not walked.
- `collect()` also returns `breakpoints = scanBreakpoints()`: `--breakpoint-*` custom properties (Tailwind v4 theme), the `@media (min-width / width >=)` widths with counts, and the max-width queries.
- `box` is the border box in document px.
- `ink` is the **visible** extent: own box only if it has a visible bg/border/shadow (`bv`) or is media or a pseudo-element, unioned with the text rects (`tink`, from Range client rects) and the children's ink, clipped by overflow.
- `body`/`html` never count as `bv`. `display:contents` is passed through. SVG children are skipped.
- `st` is a computed-style subset:
  - `m`, `pd`, `bw` arrays (top, right, bottom, left)
  - `w`, `h`, `fs`, `lh`, `fw`, `ff`, `ls`, `color`, `bg`, `maxW`, `minH`
  - for flex/grid: `gap:[row, col]`, `fd`, `jc`, `ai`, `gtc`
  - `top`/`left` when positioned
  - `br`, `ta`, `transform`
- `sel` is a unique selector: `#id` or a tag + up-to-2 classes + `:nth-of-type` chain. It ignores `astro-*`/`svelte-*`/`css-*`-style classes.

## Section scope (`ParityCore.analyzeScoped`)
- Capture: content `prepareCapture({scope})` returns `scopeBox`, and `cap.scope = {selector, label, box}`. `cap.bp.sectionImgId` is set when a section JPEG exists for this breakpoint.
- Worker: with a section JPEG, the design canvas is the image drawn at `box.x` with `box.w` width, its top at row 16. Otherwise the full design is used.
- `analyzeScoped`:
  - finds the root node by selector and box, and keeps its subtree
  - crops the site to `[box.y−16, box.bottom+16]`
  - locates the section in the design by matching the root's **visible content** band (its box edge if `bv`) with a global vertical search. With a section JPEG, the offset is exact (`16 − box.y`) and the match is only a sanity check.
  - crops the design (the section's height plus slack), remaps the node coordinates, runs `analyze`, then shifts every y back by `+y0`. Expected boxes are therefore "where it should be with the section top aligned".
  - returns `scope {selector, source, site, designTop, offsetRemoved, locateScore, crop}`
- Panel:
  - *Scope* row: Pick section uses pick mode with `purpose: 'scope'`; ×, *+ section JPEG* / remove, *Align overlay to this section*
  - the overlay draws the section JPEG on the live section box, or shifts the full design by `liveSectionTop − rep.scope.designTop`
  - the Analyze button becomes *Analyze section*
- Test: `SCOPE='#services' node run-test.js` (add `SECTIONJPG=1` to use an element screenshot as the section JPEG). Expected: only the section's 3 issues, with the header drift removed. `node e2e-scope.js` runs the full flow.

## Analyzer (`analyzer-core.js`) — how a match becomes an issue
1. Both images are converted to gray → [1 2 1] blur → 4-level pyramid → **band-pass** (minus a 13px box blur), so gradients and flat fills don't drive matches.
2. `matchRect`:
   - zero-mean NCC on grid-sampled template points (L0 900, coarse 500)
   - coarse level chosen by element size and search window; top-3 local maxima refined down the pyramid
   - acceptance score = max of the finest two levels
   - small distance penalty `lam`; an `ambiguous` flag when the top two peaks are within 0.015
   - `allowScale` for leaf-ish elements ≤ 240px tall tries scales 0.84–1.22 (font-size changes)
3. Search windows:
   - children search ±24px around the matched ancestor's offset, retrying at ±96 × (120 + height difference) when the score is below 0.72
   - roots search ±64 × (300 + height difference) around the last full-width root's dy
   - page-covering or tall transparent containers are skipped (`_pass`)
4. `measureEdges`: top, bottom, left and right bands, matched one by one.
   - Boxes (`bv`) use thin boundary bands (≤ 8px inside, 6px outside); text and content use ≤ 32px bands.
   - A band is rejected if score < 0.6, std < 4, it's ambiguous, or the jump is implausible.
   - Full-bleed elements are pinned to dx = dw = 0, and elements at y ≈ 0 to top = 0.
   - Box-only fallback: if the content differs but the box edges match, it's still matched.
5. `delta = {x: L, y: T, w: R − L, h: B − T}` = **design − site**.
6. Transparent wrappers with matched kids get a `derived` delta, the union of the kids' expected boxes. They never get size issues of their own.
7. Relations, among matched siblings sorted by y then x:
   - vertical predecessor `vp`, horizontal predecessor `hp`
   - `gapY = rel.y − (vp.rel.y + vp.dh)`, `gapX` likewise
   - Explained away (gap set to 0):
     - centered or end-aligned children whose own size changed (first in row only)
     - first children of a parent whose size changed (centered in parent)
     - heights that follow their children's bottom
     - widths that follow the parent, or the content for inline/flex/grid
8. Grouping: siblings with the same gap (±1.5px) become one `gap-x`/`gap-y` issue on the parent (with `pred`), or one `padding-x`/`padding-y` issue (first children). Track size changes equal to `gap·(n−1)/n` are dropped as fluid-track consequences.
9. Color check (score ≥ 0.8):
   - background median for `bv` elements, flagged if ΔRGB > 20
   - text ink color for text elements, flagged if ΔRGB > 45
10. `not-found` issues: unmatched subtrees with no matched descendants.
11. Severity by own magnitude: > 12px high, > 4px medium, else low. Tolerance defaults to 2px.
12. `suggest()` produces before → after strings from computed styles and related Tailwind classes (`twMatch` families), plus a **100vh hint** when an element's height equals the capture viewport height.
13. **Text** (`finalize`/`textScale`/`measureTypo`/`lineProfile`):
    - `textScale`: NCC of the first line's template at scales 0.80–1.26, refined in 0.005 steps. When the whole match was weak, it also tries left/center/right anchoring around the parent offset. This gives the precise font-size ratio.
    - A single-line text at scale 1 is pinned to w = h = 0. When the scale ≠ 1, x, y, w and h follow the scaled mapping.
    - `measureTypo` measures cap top and baseline from an ink row profile, in both images.
    - Weak text matches (< 0.66) are spurious. They are rescued by the first-line match (same copy, different wrap, with the block height from following the lines down) or by the scaled match. Otherwise they become not-found.
14. **Type scale**: matched text is grouped by computed `fs|ff|fw|lh`. When ≥ 2 members and ≥ 60% agree on the median scale (±3%), one `type-scale` issue is emitted: the shared `text-*/font-*/leading-*` classes, `fontSize {site, design, ratio}` and `members`. Member size issues are removed and marked `groupedInto`. Singletons get an exact `font-size A → B` suggestion and kind `type-size`.
15. **Repeated look-alike siblings** (same tag + classes, size within 10–15%): if their displacements disagree with the group median, or their reading order breaks, outliers are re-matched around the median (and their subtree re-matched). If the order is still broken, they are flagged `orderAmbiguous` and excluded from gap grouping.
16. Unmatched transparent wrappers that have matched kids get a synthetic, derived box, so a grid of identical cards still owns its gap issue.
17. **Content-tolerant mode** (`meta.contentMode === 'tolerant'`):
    - unmatched text is located by its line profile and block extent; unmatched boxes and media by their box edges
    - `contentDiffers` nodes have no size, wrap or colour issues; position, box edges and type are kept
    - not-found issues become low severity
18. **Not-found summary**: 3 or more not-found issues in the same block become one issue with `members`.
19. **Stable ids**: `id = fnv1a(selector + '|' + sorted kinds)` in base36, plus a `rank`. `ledger` lists the top-level full-width bands: site/design top and bottom, `ownTopDelta`, `heightDelta`, `cumulativeBottomDelta`, `issueIds`.

Issue object (internal): `{ id, severity, kind[], summary, element{selector, tag, id, classes, text, label, attrs, aliases}, actual, expected, elementBox, delta, ownShift{x, y, relativeTo}, notes, alignment, confidence, computed, parent, previousSibling, suggestions[], tailwind[], children?, color?, groupedInto?, _i }`.

## Agent JSON (`report.js` → `agentJson`, schema `parity.report/1`)
- Written to `Downloads/<folder>/latest.json` (all analyzed breakpoints) and `Downloads/<folder>/<page-slug>/<width>.json`, plus an optional `-annotated.png`, with `conflictAction: overwrite`.
- Top level: `{ schema, generatedAt, url, title, conventions, howToFix[], breakpoints[] }`.
- Each breakpoint: `{ name, viewport{width, height}, breakpoints{source, prefixes, active, editPrefix, appliesFrom, appliesTo, rule}, tailwindActivePrefixes, editPrefix, contentMode, ignoredSelectors, design{…}, figma?, page{…}, truncated?, stats, diffFromPrevious{resolved[], added[], changed[], unchanged}, ledger[], issues[] }`.
- `resolveBreakpoints`: `editPrefix` is the largest project prefix whose breakpoint is ≤ the frame width.
- `diffReports`: matches issues by id and compares only their own cause (ownShift, w/h, gap, padding, fontSize; ±1px), not their absolute position.
- Issue extras: `source{file, loc}`, `block{selector, attrs}`, `astroCid`, `box` (CSS border box), `deltaFrame`, `typography{site, design, delta{capTop, baseline}, fontSize}`, `contentDiffers`, `status` (new/changed/unchanged), `figma{nodeId, name, type, textStyle, values, boundVariables, match}`.
- `cleanIssue` strips `_*`, `elementBox`, `rank` and empty fields.
- **Figma (optional)**: requires `settings.figmaToken` and `bp.figmaUrl` (a link containing `node-id`).
  - `GET /v1/files/:key/nodes?ids=` returns the frame tree. `/variables/local` gives variable names, but needs Enterprise; without it, variable ids are kept.
  - Nodes are flattened into frame-relative CSS px. Issues are mapped to TEXT nodes by characters, or by IoU (auto-layout frames preferred for gap/padding issues).
  - The mapping adds exact values to `suggestions`; for type-scale issues `fontSize.design` becomes the Figma value.
- "Copy agent prompt" is a text version of the first 40 issues per breakpoint.

## UI (content.js)
- Panel sections: breakpoints (chips, detail/edit form: name, width, scale, viewport height, offset, Figma frame link), overlay (eye, opacity, Overlay/Difference/Split, Invert, Center), viewport (Match + Exact/Window, Freeze motion), Analyze / All, last report summary, Show issues on page with a clickable list, settings (⚙: tolerance, folder, auto-save, PNG, keys, Figma token; this page: content-tolerant toggle, ignore list).
- Width guessing: a number in the filename that equals width/scale wins; otherwise a list of common widths at 1–3x; otherwise above 2200px is treated as @2x. Dropping a file with the same width replaces that image.
- Overlay host is `position:absolute` on `<html>`, with `mix-blend-mode: difference` on the **host** (blending only works at that level). Canvas backing is capped at about 24M pixels.
- Issue layer: site box in cyan, design box dashed pink, labels `#id ↕+12 w+8`. It follows the live element via `selector` and `elementBox`, so boxes move after a hot reload.
- Pick mode (cursor icon or **C**): lime hover box plus a tooltip with tag, size and classes.
  - Click copies the `class` attribute; ⇧ click or no classes copies the `uniqueSelector`.
  - ⌥ click toggles the element's selector in `proj.ignore`. Ignored regions are drawn hatched violet while picking or while issues are shown.
  - ↑/↓ moves to the parent or child, locked until the pointer moves 8px.
  - Esc exits.
  - Page clicks are blocked (capture-phase listeners) while picking.
- Keys (when not typing): `1–9` breakpoint, `H` hide, `D` difference, `S` split, `I` invert, `−/=` opacity, `⌥ arrows` nudge (⇧ for 10px), `C` pick.

## Testing (`dev/`)
- Install: `npm i -D playwright sharp`, or set `NODE_PATH` to global modules. Uses Playwright's bundled Chromium (`channel: 'chromium'` for extensions in headless).
- `node run-test.js`:
  - renders `demo.html`, builds a "design" JPEG at 2x with the `VARIANT` CSS applied, captures the original at 1x, collects nodes and runs `analyze` in Node
  - env vars: `W` (width), `VARIANT` (CSS injected into the design), `PAGE` (`big.html` = stress test)
- Expected baseline at 1440 with the default variant, which has 6 injected changes:
  - header +8 height (padding-y 4)
  - lead +12–13
  - button +8/+4
  - grid gap +8 (`column-gap 24px → 32px`)
  - h3 font-size about 24
  - CTA h2 color

  With `VARIANT=" "` the result must be 0 issues (100% exact) at 1440 and at 375.
- More `run-test.js` scenarios with their expected results:
  - `PAGE=big.html VARIANT=".section h2{font-size:35px}"` → exactly 1 issue (type-scale 40 → 35, 9 members).
  - `PAGE=repeat.html VARIANT=".grid{row-gap:56px; column-gap:40px}"` → 2 issues (gap-x +16, gap-y +32 on `div.grid`).
  - `PAGE=repeat.html VARIANT=".grid{margin-top:260px}"` → 1 issue (+212, margins collapse with the lead's 48).
  - `MODE=tolerant` with `VARJS` changing copy → only the real margin issue. `VARJS` runs JS on the design page; `MODE` sets the content mode.
- `npm run serve`, `npm run fixtures`, then:
  - `node e2e.js`: full extension flow (inject panel via SW `togglePanel`, upload 2 JPEGs, Analyze all, report, downloads)
  - `node e2e2.js`: viewport height, ⌥ click ignore of the footer, project breakpoints (`demo.html` declares sm/lg/xl), source/block attributes, ledger, re-analyze after a fix → diff shows 1 resolved, 0 changed
  - `node e2e-figma.js`: mocked Figma API → gap issue gets `itemSpacing 32 (bound to space/8)`, type-scale gets 24px from text style "H3 / Card"
  - `node pick.js`: pick mode and clipboard
- Performance: about 13ms per element (1,500 elements ≈ 15–20s in the worker). Hot spots are `search` and `boxBlur`.

## Known limits / ideas
- Not yet validated against real Figma exports. Figma text rendering differs from Chrome, so tolerance or score thresholds may need tuning on the first real page.
- Elements with invisible edges (white on off-white) can't be measured for size, only their content.
- `position:fixed` elements are compared at scroll 0. JS-driven animations (GSAP, Lenis) can't be frozen.
- Figma REST mapping is tested against a mocked API only. Real files may need better node matching (instances, hidden layers, text auto-resize boxes).
- Ideas:
  - an auto-suggested viewport height
  - a per-issue crop PNG for multimodal agents
  - mapping `data-astro-cid-*` to component names via the build manifest
