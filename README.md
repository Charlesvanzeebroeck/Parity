# Parity — calibrate a live page against its design (Chrome)

Parity 3 has no AI, no Figma link and no automatic diff. You get two reliable things: the **design JPEG** laid over the page, and **your mouse**. Drag the real page elements until they line up with the design. Parity records every gesture as the CSS property that actually controls it, then exports a short `edits.md` that a coding agent (or you) applies in source.

## Install (unpacked)
1. Keep this folder somewhere permanent (Chrome loads it in place).
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick this folder.
3. Pin it. **⌥⇧P** toggles the panel, **⌥⇧E** toggles edit mode.
4. For `file://` pages: extension details → **Allow access to file URLs**.

## Workflow
1. **Add the design.** Drop, choose or paste JPEG/PNG exports, one per breakpoint. The width comes from the file name (`home-1440.jpg`) or the pixel size (2880 → 1440 @2x). No mockup? Use **edit at N px without a design**.
2. **Line up the overlay** (Design overlay tab): opacity, *Overlay / Difference / Split*, *Invert*, *Center*, *Match width*, *Freeze motion*. **⌥ arrows** nudge the design (⇧ = 10px). **M** lets you drag the design vertically and cut it into bands (for pages longer than the mockup). **L** locks it. **Difference** is the best mode for calibrating: whatever lines up turns black.
3. **Edit** (**E**, or the cursor icon). Click an element, then:

| Gesture | Changes |
|---|---|
| **Drag the element** | The property that positions it: parent `gap` (flex/grid, not first), parent `padding` (first child), the previous sibling's `margin-bottom`, its own `margin`, `top/left/bottom/right` (absolute/fixed). It picks the most likely one. **⇥ while dragging** switches to the next (badge shows the list). The element always follows the cursor, even when 1px of gap moves it ⅓px (`1fr` grid) or 2px (third item). |
| **Right / bottom edge, corner** | `width` / `height`. `max-width` when it's what limits the element. **⇥** → `min-width`, `flex-basis`. |
| **Orange pills** (outside) | `margin` of that side |
| **Green pills** (inside) | `padding` of that side |
| **Pink pills** (between children) | `row-gap` / `column-gap` |
| **⌘ drag** | Reorders items of a flex/grid row (`order`) |
| **⇧** while dragging | Snaps the value to the 4px grid |

Keys (with a selection): **arrows** nudge 1px (⇧ 10), **[ ]** font-size ∓1, **⇧[ ]** line-height, **⌫** hide (`display:none`), **R** reset the element, **↵ / ⇧↵** child / parent, **⇥ / ⇧⇥** next / previous sibling, **A** apply to *all similar* (every element with exactly the same classes, e.g. the 3 card titles), **⌥ hold** measure the distance to the hovered element (or the parent), **B** before/after, **⌘Z / ⇧⌘Z** undo/redo, **Esc** deselect → leave edit mode.

The **inspector** (Edit tab) shows the selection: source file:line (Astro dev), size, a box model (margin/padding), gap, position, type (size, line height, tracking, weight, colour), fill, radius, opacity. Drag a field to scrub it (⇧ = 4px grid), click to type, ↑↓ to step, × to go back to the original. The ◉ eyedropper picks colours from the screen, design overlay included.

4. **Export.** **Copy edits.md** (paste into Claude Code) or **Download**, which writes `Downloads/parity/<page>/edits.md` + `edits.json`. Every breakpoint with edits is included.

```
## 1440px · Desktop · `lg:` (≥1024px)

### src/components/Hero.astro:2 · `section.hero`
Selector `section.hero:nth-of-type(1)`
- padding-top 80 → 100px · add `lg:pt-25`

### `h3.card-title` ×3 (every element with exactly these classes)
- font-size 22 → 24px · `text-[22px]` → `lg:text-2xl`
```

Tailwind suggestions come from the page's own theme (v4 `--spacing`, `--text-*`, `--radius-*`, `--color-*`, `--container-*`), with the default scale as fallback. The prefix is mobile-first: the smallest design (< 640px) is the base, and wider designs get the screen between it and their own width (`lg` for desktop widths).

## Good to know
- Edits are stored **per breakpoint and page**, applied as inline `!important` styles, and **re-applied after reloads and hot updates**. Close the panel and the page is exactly as before.
- The list in the Edit tab shows every change for the active breakpoint. Click a row to select the element, × to revert it. Struck-through rows can't be found on the page right now.
- *Match width* uses Chrome's debugger API (exact width). Chrome then shows a "started debugging" bar; start Chrome with `--silent-debugger-extension-api` to hide it. Settings → *Resize window* is the alternative.
- Elements inside iframes, and pages behind closed shadow roots, can't be edited.
- The previous versions are in `_backup/`.
