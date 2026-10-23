# Parity — project context for coding agents

Parity is a personal Chrome extension (Manifest V3, plain JavaScript, no build step). **Parity 3 (2026-10-21)** is manual on purpose: a design JPEG overlay plus a live editor. The user drags real page elements into place; each gesture becomes a real CSS property change (margin, gap, padding, width, font-size…), recorded per breakpoint and exported as a concise `edits.md` / `edits.json` for a coding agent. Figma, MCP, the REST API, Jev and the pixel/structural analyzers are gone. v2 is in `_backup/parity-v2-2026-10-21.tgz`.

Owner: a digital/brand designer who builds sites with Astro + Tailwind (often v4), frequently fed by headless Umbraco. Keep the UI tasteful: dark panel, lime accent `#c8ff3d`. `README.md` is the user guide.

## Hard constraints
- No build tooling, dependencies or frameworks in the extension. Plain ES2020+, loaded unpacked.
- Must work on any site, including strict CSP: the overlay is drawn on `<canvas>`, UI lives in shadow-DOM hosts marked `data-parity`, page styles go through constructable sheets (`ParityPage.pageStyle`), edits through CSSOM (`style.setProperty`).
- **Never leave the page altered.** `unapplyAll()` restores every inline property it touched (and removes a `style` attribute it created); hosts, sheets and freeze are removed on close. `dev/e2e-edit.js` asserts an identical DOM after close.
- `shared.js` and `edits-core.js` stay pure (no DOM) and run in Node.
- Don't use `storage.onChanged` in content scripts (multi-MB images broadcast to every tab).

## Files
| File | Runs in | Role |
|---|---|---|
| `manifest.json` | — | Permissions `activeTab scripting storage unlimitedStorage debugger downloads tabs`, host `<all_urls>`. Commands `_execute_action` ⌥⇧P, `edit` ⌥⇧E. |
| `shared.js` | SW + tab | `ParityShared = { SETTINGS_KEY, DEFAULT_SETTINGS, segmentsOf }` |
| `edits-core.js` | tab + Node | `ParityEdits`: edit model (`upsert`, `describe`), Tailwind mapping (`twUtility`, `twRelated`, `twSuggest`, `prefixFor`), export (`build`, `toMarkdown`, `toJson`). |
| `page.js` | tab | `ParityPage`: `uniqueSelector`, `labelOf`, `srcOf` (Astro `data-astro-source-file/-loc`), `similarOf` (exact class list), `toHex` (canvas), `scanTheme` (Tailwind v4 `:root` vars; null when the page isn't Tailwind), `setFreeze`, `pageStyle`. |
| `editor.js` | tab | `ParityEditor`: apply engine, selection/hover, drags, keys, page layer (`parity-edit` host), Edit-tab panel (inspector, list, export). |
| `content.js` | tab | Panel shell, breakpoints, JPEG overlay (bands/cuts, move/lock, split, difference), viewport, shortcuts. Calls the editor through a small ctx. |
| `background.js` | SW | Injection, toggle, re-inject after reload (`chrome.storage.session.tabs`), viewport (CDP emulation or window resize), downloads. |
| `dev/` | Node | Tests and fixtures, not shipped. |

Injection order: `shared.js → edits-core.js → page.js → editor.js → content.js`.

## Data model (`chrome.storage.local`)
| Key | Value |
|---|---|
| `proj:<origin+pathname>` | `{ v:3, breakpoints[], activeId, overlay:{visible, opacity, mode:'normal'\|'difference'\|'split', invert, align, splitX}, viewport:{match, mode:'emulate'\|'window'}, freeze, panel:{x, y, collapsed, tab:'edit'\|'overlay'} }` |
| breakpoint | `{ id, name, width, scale, vh, offsetX, offsetY, slices?:[{y, dy}], locked?, imgId\|null, imgW, imgH, file, edits:[] }` (no `imgId` = "live", edited without a design) |
| `img:<imgId>` | design data URL |
| `parity:settings` | `{ folder, keys }` |

**Edit** (see the header of `edits-core.js`): `{ sel, exact?, n, label, src?, cls?, prop, from, to, at }`. `sel` is a unique selector, or for "all similar" a tag+classes selector with `exact` = class count (matched elements must have exactly that many classes). `from` is the computed value before the first change and stays fixed; `upsert` drops an edit that returns to `from`. Reorder: `{ kind:'order', sel: parent, prop:'order', from/to: ['#n label'], kids: [child selectors in new order] }`, applied as `order: i` on each child.

## Editor behaviour worth knowing (`editor.js`)
- **Apply engine**: `applyAll()` = `unapplyAll()` then `setProp(el, prop, to, 'important')` for every edit of the active breakpoint (none in Before mode). A subtree `childList` MutationObserver (ignoring `data-parity` nodes) re-applies 90ms after page re-renders (hot reload, client rendering) and re-finds the selection by selector.
- **Drag = candidates per axis.** `moveCands(el, axis)` ranks properties: inset for absolute/fixed (the nearer side), relative offset, parent gap (flex/grid, not first on that axis), parent padding (first), own margin, previous sibling's margin, own margin, `translate`. `sizeCands`: `max-width` when it's what limits the element, `width`, `min-width`, `flex-basis` (main axis of a flex parent). Tab cycles while dragging; the choice is remembered per element+axis (`E.via`).
- **Gain calibration**: after ≥3px of property change, the element's real displacement gives `e` (px moved per px of property, clamped 0.2–5), so the element tracks the cursor (1fr grid gap ≈ ⅓, third item ≈ 2). No movement after 8px → "no visible effect" in the badge. Move drags have a 6px dead zone per axis so vertical drags don't create stray horizontal edits.
- **Spacing handles** are small pills centred in each margin/padding/gap strip, so the body stays draggable. Padding pills only appear when they fit (≥ 60×40). Size handles are 8px edge strips plus the corner.
- **Event blocking**: in edit mode, capture-phase listeners on `window` swallow page pointer/mouse/click events unless they come from a `data-parity` host. `pointerup` is let through to our own drag/pending handlers while one is active (they stop it themselves).
- **Undo**: snapshots of a breakpoint's `edits` (JSON) before each commit; repeated nudges/bumps within 900ms coalesce.
- **Panel**: `ParityEditor.mount(el)` renders the Edit tab into a container in the content panel. It won't re-render while an inspector input has focus. `ctx.changed()` makes content re-render chips/badges.
- **Export**: `exportDoc()` sorts edits in page order, flags `missing`, and adds `scanTheme()` (cached per attach). `toMarkdown` groups breakpoint → element (heading = `src · label` or the selector) → one line per change with the Tailwind `current → suggested` classes.

## Overlay gotchas (`content.js`)
- Overlay host is `position:absolute` on `<html>`; `mix-blend-mode: difference` must sit on the host. One canvas per band; `renderOverlay()` redraws only when image/width/cuts change, `layoutOverlay()` just repositions.
- Cuts: `slices` sorted by design y; band 0 at `offsetY`, band i at `slices[i-1].dy` (absolute). `ParityShared.segmentsOf` is the only implementation.
- Overlay Move mode and edit mode exclude each other (`ctx.blocked()` = Move on).

## Tests
`node dev/edits-test.js` (core, Node only). `node dev/e2e-edit.js` (needs `npm run serve` in `dev/` and Playwright): real mouse/keyboard on `dev/edit.html` (strict CSP) covering move via parent padding, grid gap with gain, Tab cycling, undo, padding pill, resize, all-similar + font keys, measure, reorder, hide, before/after, hot re-render, inspector scrub/typing, copy export, reload, clean close, overlay + move-mode exclusion. Keep both green after any change.

## Ideas / known limits
- Text editing (double-click to change copy) is not implemented.
- Edits inside iframes / closed shadow roots are out of reach.
- `from` for an "all similar" edit is read from the selected element; if that element already had a single-element edit on the same property, `from` reflects it.
- Snap-to-design-edges (edge detection on the JPEG) would make calibration even faster.
