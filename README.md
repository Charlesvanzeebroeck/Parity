# Parity — design overlay & diff for Chrome

Overlay Figma JPEG exports on the live page per breakpoint, like PerfectPixel, and also **analyze** the page. Parity compares a full-page capture against the design, finds which elements are offset or mis-sized, and writes a structured JSON file that a coding agent can act on.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
3. Pin the extension. Toggle the panel with the toolbar icon or **⌥⇧P** (Alt+Shift+P).
4. For `file://` pages, open the extension's details and enable **Allow access to file URLs**.

## Workflow

1. **Export from Figma**: select each breakpoint frame and export it as a JPG. Any scale works (1x, 2x or 3x). A name like `home-1440.jpg` helps, but the width is also inferred from the pixel size (2880 → 1440 @2x, 1125 → 375 @3x…).
2. **Drop the files on the panel**, or paste them. You get one chip per breakpoint. Dropping a file with the same width replaces that breakpoint's image.
3. **Switch breakpoints** with the chips or keys **1–9**. With *Match viewport* on, the tab is resized to that width at the same time:
   - **Exact (emulated)** is pixel-exact at any width, including 375, and hides scrollbars. It uses Chrome's debugger API, so Chrome shows a "started debugging this browser" bar. Launch Chrome with `--silent-debugger-extension-api` to hide that bar.
   - **Resize window** resizes the real window. It can't go below Chrome's minimum window width of about 500px.
4. **Compare**: use *Overlay* (opacity), *Difference* (identical pixels turn black) or *Split* (drag the lime handle). *Invert*, *Center* and **⌥+arrows** let you nudge the overlay (add ⇧ for 10px steps). The offset is saved per breakpoint and also used by the analysis.
5. **Analyze** (**⌥⇧A**, or **All** for every breakpoint). This opens a report tab with the side-by-side / overlay / difference viewer and a list of root-cause issues. The JSON is saved automatically to `~/Downloads/parity/latest.json`, plus one file per page and width.
6. Turn on **Show issues on page** to see the site box (cyan) and the design box (dashed pink) for each issue on the live page. The boxes follow the element after a hot reload, so you can watch a fix land.

### Copy class names
Click the cursor icon in the panel header, or press **C**, to enter pick mode. Hover an element to see its tag, size and full class list.
- **Click** copies the class list (for example `grid grid-cols-3 gap-6 lg:gap-8`).
- **⇧ click** copies a unique CSS selector. Elements without classes copy their selector automatically.
- **↑ / ↓** moves to the parent or back to the child before you click, which is useful for wrapper divs.
- **Esc** exits.

While picking, clicks don't reach the page, so links and buttons won't fire. In the report, each issue also has **selector** and **classes** copy buttons.

### Section by section
Debug one section at a time, without the drift from everything above it:
1. In the panel's **Scope** row, click **Pick section** and click the section on the page. Use **↑** to go to the parent first if you hovered something inside it.
2. Optionally add a **section JPEG**: the Figma export of just that section frame. Without one, Parity finds the section inside the full-page JPEG.
3. **Analyze section**. Only elements inside the section are analyzed. The section's top is aligned to the design, and the report says how many px of drift from above were removed. The viewer shows the two section crops side by side.
4. **Align overlay to this section** (on by default) puts the section JPEG exactly on the live section, or shifts the full design so the section tops line up.

Section reports are stored apart from the whole-page report, with their own fix-check history and file `Downloads/parity/<page>/<width>-<section>.json`. Click × in the Scope row to go back to the whole page.

### Scope: ignore, content-tolerant, Figma
- **Ignore**: in pick mode, **⌥ click** an element (for example the header or hero) to exclude it from analysis. ⌥ click it again to include it. The list per page is in ⚙.
- **Content-tolerant** (⚙ → This page): for pages showing live CMS content instead of the mockup's copy. Text is located by its lines (cap top / baseline) and boxes by their edges. Different copy, wraps or images no longer create size, colour or not-found noise; position, spacing and type are still compared.
- **Figma (optional)**: paste a personal access token in ⚙. Then paste the frame link (right-click the frame → *Copy link*) in the breakpoint's ✎ form. Issues get the Figma node's exact values (font size, line height, auto-layout spacing, padding) and say whether they're bound to a variable or raw.

### What the report adds for agents
- **Type-scale grouping**: text sharing one computed style and scaled by the same factor becomes a single issue, e.g. `text-heading-2: 64 → 56px (7 elements, 0.875×)`.
- **Typography**: cap top and baseline for site and design (works with `text-box-trim` / cap-trim).
- **Project breakpoints**: read from `--breakpoint-*` and `@media` rules, plus which prefix to edit at this width (e.g. `lg:` at 1440 when xl is 1600).
- **Source**: the Astro `data-astro-source-file:loc` (dev mode) and the CMS block (`<section>` / `data-block*` / `data-content-type`) for each issue.
- **Vertical ledger**: one row per full-width band (site vs design top/bottom, own Δ, cumulative Δ), showing where vertical drift starts.
- **Stable ids and a fix check**: an id means the same problem across runs. Each run lists the issues resolved, new and changed since the previous capture.

### Motion
During capture Parity always does the following, so animated sites are compared in their settled state:
- emulates `prefers-reduced-motion: reduce`
- scrolls through the page to trigger lazy images and reveal-on-scroll effects
- jumps CSS animations and transitions to their end state, and pauses infinite ones

**Freeze motion** in the panel does the same for live browsing. Animations driven by JavaScript (GSAP, Lenis…) can't be stopped from outside. Disable them on the demo page if they move the layout.

### 100vh heroes
The Figma frame has no viewport, but your CSS does. Set **Viewport height** on a breakpoint (✎) to the height of the design's first screen. Otherwise `100vh` sections resolve to your window height. The report detects this case and tells you when it's the cause.

## How the analysis works

- The capture is taken at exactly the breakpoint width with DPR 1, full page (CDP `captureBeyondViewport`). At the same moment the DOM is walked for boxes, text boxes, computed styles, selectors and `data-*` attributes.
- Each element's *visible* extent (text, media, backgrounds, borders) is located in the design with coarse-to-fine normalized cross-correlation on a band-passed pyramid. Gradients and flat fills don't confuse it, and the search is guided by the parent's match. Elements whose content was scaled (for example a bigger font) are rescued with a scaled search.
- Each edge is then measured on its own. Boxes are measured on their boundary only, and text on its glyph extents. This gives `expected − actual` for x, y, w and h.
- **Root causes**: shifts inherited from a parent or from earlier siblings are subtracted. Consequences are also dropped when:
  - a wrapper's height follows its children
  - a child is centered in a parent that grew
  - a `1fr` column shrank because the gap grew

  Matching sibling offsets are grouped into one `gap-x/gap-y` or `padding-x/padding-y` issue on the parent, for example `column-gap 24px → 32px`.
- Text and background colors are sampled and compared, and flagged when clearly different.
- Every issue gets concrete suggestions (`margin-top 16px → 28px`), the related Tailwind classes found on the element or its parent, and the Tailwind responsive prefixes active at that width.

It assumes, as you said, that the demo page has **the same content** as the design. Different copy or images will show up as `not-found`.

## JSON for coding agents

`~/Downloads/parity/latest.json` (schema `parity.report/1`):

```jsonc
{
  "url": "http://localhost:4321/demo",
  "conventions": { "delta": "expected (Figma design) minus actual (live page)…" },
  "howToFix": ["Work top-to-bottom…", "Only change styles that apply at the breakpoint…"],
  "breakpoints": [{
    "name": "Desktop",
    "viewport": { "width": 1440, "height": 900 },
    "tailwindActivePrefixes": ["(base)", "sm", "md", "lg", "xl"],
    "page": { "actualHeight": 1961, "designHeight": 1987, "heightDelta": 26 },
    "stats": { "exactPct": 72.4, "issues": 6, "bySeverity": { "high": 1, "medium": 4, "low": 1 } },
    "issues": [{
      "id": 4,
      "severity": "medium",
      "kind": ["gap-x"],
      "summary": "<div> …: space between its children is 8px too small (horizontal)",
      "element": { "selector": "#services > div.grid", "classes": "grid grid-cols-3 gap-6", "attrs": { "data-astro-cid-x7": "" } },
      "delta": { "gap-x": 8 },
      "suggestions": ["column-gap 24px → 32px"],
      "tailwind": ["gap-6"],
      "computed": { "display": "grid", "gap": [24, 24], "pd": [0, 0, 0, 0] },
      "children": ["div.card:nth-of-type(2)", "div.card:nth-of-type(3)"]
    }]
  }]
}
```

The report tab also has **Copy agent prompt**, a ready-to-paste message with the issues and fixes.

Suggested line for your `CLAUDE.md` / `AGENTS.md`:

> For visual fixes against Figma, read `~/Downloads/parity/latest.json` (Parity report). Fix issues top-to-bottom per breakpoint, only with styles that apply at that breakpoint's width, then ask me to re-run Parity to verify.

## Settings (⚙ in the panel)
- **Tolerance** in px (default 2)
- **Download folder** (default `parity`)
- **Auto-save JSON**
- **Also save an annotated PNG** (design vs site with numbered boxes, handy for multimodal agents)
- **Single-key shortcuts**

## Files
`manifest.json` · `background.js` (viewport emulation, capture) · `collect.js` (DOM walk, motion freeze) · `content.js` (panel, overlay, issue layer) · `analyzer-core.js` (matching and root-cause logic, pure JS) · `analyzer-worker.js` · `report.*`

## Limits
- Pages taller than 30,000px are analyzed down to 30,000px only.
- `position: fixed` elements are compared where they sit at scroll 0.
- Elements with no visible edges, such as a white card on an off-white page, can't be measured for size. Their children still are.
- Colors are sampled from a JPEG, so snap them to your tokens.
