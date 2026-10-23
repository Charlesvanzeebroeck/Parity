/*
 * Parity — edit model, Tailwind mapping and export. Pure (no DOM): runs in tabs and in Node tests.
 *
 * An edit is one CSS property changed by hand on one element (or on every element of a "similar" set):
 *   { sel, exact?, n, label, src?, cls?, prop, from, to, at }
 *   sel    unique selector, or the class selector of a similar set (exact = class count to match exactly)
 *   n      matched elements when recorded; label = short tag.class; src = "src/x.astro:12" (Astro dev)
 *   cls    the element's class attribute when first edited (for Tailwind "current → new")
 *   from   computed value before any Parity edit; to = value now applied (canonical strings, px rounded)
 * Reorder edits: { kind:'order', sel (parent), prop:'order', from:[labels], to:[labels], kids:[child selectors in new order] }
 */
(function (root) {
  'use strict';
  if (root.ParityEdits) return;

  // ---------- values ----------

  const r2 = (v) => Math.round(v * 100) / 100;
  const trim = (v) => String(r2(v)).replace(/^(-?)0\./, '$1.').replace(/^\./, '0.').replace(/^-\./, '-0.');
  const pxOf = (v) => {
    if (typeof v === 'number') return v;
    const m = /^(-?[\d.]+)px$/.exec(String(v || '').trim());
    return m ? parseFloat(m[1]) : null;
  };
  const key = (v) => (Array.isArray(v) ? v.join('|') : String(v));
  const sameTarget = (a, b) => a.sel === b.sel && (a.exact || 0) === (b.exact || 0) && a.prop === b.prop;

  // Insert or update an edit. Keeps the original `from`; drops the edit when it is back at `from`.
  function upsert(list, e) {
    const out = list.slice();
    const i = out.findIndex((x) => sameTarget(x, e));
    if (i >= 0) {
      const m = { ...out[i], ...e, from: out[i].from, at: e.at || Date.now() };
      if (key(m.from) === key(m.to)) out.splice(i, 1);
      else out[i] = m;
    } else if (key(e.from) !== key(e.to)) out.push({ ...e, at: e.at || Date.now() });
    return out;
  }

  // "20 → 24px", "normal → 28px", "#111 → #222", "hidden"
  function describe(e) {
    if (e.kind === 'order') {
      // "#2 div.card" labels: when every child has the same label, the positions alone say it
      const lab = (x) => x.replace(/^#\d+\s*/, '');
      const one = [...e.from, ...e.to].every((x) => lab(x) === lab(e.from[0]));
      const num = (x) => x.split(' ')[0];
      return one ? `children order ${e.from.map(num).join(', ')} → ${e.to.map(num).join(', ')} (${lab(e.from[0])} ×${e.from.length})` : `children order ${e.from.join(', ')} → ${e.to.join(', ')}`;
    }
    if (e.prop === 'display' && e.to === 'none') return 'hidden';
    const a = pxOf(e.from), b = pxOf(e.to);
    if (a != null && b != null) return `${e.prop} ${trim(a)} → ${trim(b)}px`;
    return `${e.prop} ${e.from} → ${e.to}`;
  }

  // ---------- Tailwind ----------

  const DEF = {
    text: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 },
    radius4: { xs: 2, sm: 4, md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24, '4xl': 32 },
    radius3: { sm: 2, '': 4, md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24 },
    screens: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 },
    v3space: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96],
    weight: { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' },
  };
  const NOT_COLOR = '(?!(xs|sm|base|lg|[2-9]?xl|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\\[\\d)\\b)';
  const TW = {
    'padding-top': { u: 'pt', k: 'space', rel: /^(p|py|pt)-/ },
    'padding-right': { u: 'pr', k: 'space', rel: /^(p|px|pr|pe)-/ },
    'padding-bottom': { u: 'pb', k: 'space', rel: /^(p|py|pb)-/ },
    'padding-left': { u: 'pl', k: 'space', rel: /^(p|px|pl|ps)-/ },
    'margin-top': { u: 'mt', k: 'space', neg: 1, rel: /^-?(m|my|mt)-/ },
    'margin-right': { u: 'mr', k: 'space', neg: 1, rel: /^-?(m|mx|mr|me)-/ },
    'margin-bottom': { u: 'mb', k: 'space', neg: 1, rel: /^-?(m|my|mb)-/ },
    'margin-left': { u: 'ml', k: 'space', neg: 1, rel: /^-?(m|mx|ml|ms)-/ },
    'row-gap': { u: 'gap-y', k: 'space', rel: /^gap-(?!x-)/ },
    'column-gap': { u: 'gap-x', k: 'space', rel: /^gap-(?!y-)/ },
    width: { u: 'w', k: 'space', rel: /^(w|size)-/ },
    height: { u: 'h', k: 'space', rel: /^(h|size)-/ },
    'min-width': { u: 'min-w', k: 'space', rel: /^min-w-/ },
    'max-width': { u: 'max-w', k: 'container', rel: /^max-w-/ },
    'min-height': { u: 'min-h', k: 'space', rel: /^min-h-/ },
    'max-height': { u: 'max-h', k: 'space', rel: /^max-h-/ },
    top: { u: 'top', k: 'space', neg: 1, rel: /^-?(inset|inset-y|top)-/ },
    bottom: { u: 'bottom', k: 'space', neg: 1, rel: /^-?(inset|inset-y|bottom)-/ },
    left: { u: 'left', k: 'space', neg: 1, rel: /^-?(inset|inset-x|left|start)-/ },
    right: { u: 'right', k: 'space', neg: 1, rel: /^-?(inset|inset-x|right|end)-/ },
    'flex-basis': { u: 'basis', k: 'space', rel: /^basis-/ },
    flex: { u: 'flex', k: 'flex', rel: /^(flex-(1|auto|initial|none|\[)|grow|shrink)/ },
    'font-size': { u: 'text', k: 'text', rel: null },
    'line-height': { u: 'leading', k: 'leading', rel: /^leading-/ },
    'letter-spacing': { u: 'tracking', k: 'raw', rel: /^tracking-/ },
    'border-radius': { u: 'rounded', k: 'radius', rel: /^rounded(-|$)/ },
    'font-weight': { u: 'font', k: 'weight', rel: /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d)/ },
    color: { u: 'text', k: 'color', rel: new RegExp('^text-' + NOT_COLOR) },
    'background-color': { u: 'bg', k: 'color', rel: /^bg-(?!(cover|contain|center|top|bottom|left|right|fixed|local|scroll|repeat|no-repeat|clip|origin|blend|none|gradient|linear|radial|conic|auto|size|position)\b)/ },
    opacity: { u: 'opacity', k: 'pct', rel: /^opacity-/ },
    order: { u: 'order', k: 'int', rel: /^-?order-/ },
    display: { k: 'display', rel: /^(hidden|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|flow-root|table)$/ },
    translate: { k: 'translate', rel: /^-?translate-/ },
  };

  const themeOf = (t) => ({ v4: false, spacing: 4, text: {}, radius: {}, colors: {}, containers: {}, screens: {}, ...(t || {}) });

  function spaceTok(px, T) {
    if (px === 0) return '0';
    if (px === 1) return 'px';
    const n = px / (T.spacing || 4);
    if (T.v4 ? Math.abs(n * 2 - Math.round(n * 2)) < 1e-6 : DEF.v3space.includes(r2(n))) return trim(n);
    return null;
  }
  const arb = (v) => '[' + String(v).replace(/\s+/g, '_') + ']';
  const near = (map, px, tol) => {
    for (const [name, v] of Object.entries(map || {})) if (Math.abs(v - px) <= (tol || 0.25)) return name;
    return null;
  };

  // utility class (without variant) for prop = value, or null when Tailwind has no sensible form
  function twUtility(prop, value, theme) {
    const d = TW[prop];
    if (!d) return null;
    const T = themeOf(theme);
    const px = pxOf(value);
    switch (d.k) {
      case 'space':
      case 'container': {
        if (px == null) return value === 'auto' ? `${d.u}-auto` : value === 'none' ? `${d.u}-none` : null;
        if (d.k === 'container') { const c = near(T.containers, px); if (c) return `${d.u}-${c}`; }
        if (px < 0 && !d.neg) return `${d.u}-${arb(trim(px) + 'px')}`;
        const t = spaceTok(Math.abs(px), T);
        return (px < 0 ? '-' : '') + `${d.u}-${t != null ? t : arb(trim(Math.abs(px)) + 'px')}`;
      }
      case 'text': {
        if (px == null) return null;
        const name = near(Object.keys(T.text).length ? T.text : DEF.text, px);
        return `text-${name || arb(trim(px) + 'px')}`;
      }
      case 'leading': {
        if (px == null) return value === 'normal' ? 'leading-normal' : null;
        if (T.v4) { const t = spaceTok(px, T); if (t) return `leading-${t}`; }
        else if (px % 4 === 0 && px >= 12 && px <= 40) return `leading-${px / 4}`;
        return `leading-${arb(trim(px) + 'px')}`;
      }
      case 'radius': {
        if (px == null) return null;
        if (px >= 999) return 'rounded-full';
        if (px === 0) return 'rounded-none';
        const name = near(Object.keys(T.radius).length ? T.radius : T.v4 ? DEF.radius4 : DEF.radius3, px);
        return name == null ? `rounded-${arb(trim(px) + 'px')}` : name ? `rounded-${name}` : 'rounded';
      }
      case 'color': {
        const hex = String(value).toLowerCase();
        const name = T.colors[hex];
        return `${d.u}-${name || arb(hex)}`;
      }
      case 'weight': return `font-${DEF.weight[value] || arb(value)}`;
      case 'pct': {
        const n = Math.round(parseFloat(value) * 100);
        return T.v4 || n % 5 === 0 ? `opacity-${n}` : `opacity-${arb(trim(parseFloat(value)))}`;
      }
      case 'int': { const n = parseInt(value, 10); return n < 0 ? `-order-${-n}` : `order-${n}`; }
      case 'display': return value === 'none' ? 'hidden' : value;
      case 'flex': return value === '0 0 auto' || value === 'none' ? 'flex-none' : `flex-${arb(value)}`;
      case 'translate': {
        const [x, y] = String(value).split(/\s+/).map(pxOf);
        const one = (axis, v) => {
          if (!v) return '';
          const t = spaceTok(Math.abs(v), T);
          return (v < 0 ? '-' : '') + `translate-${axis}-${t != null ? t : arb(trim(Math.abs(v)) + 'px')}`;
        };
        return [one('x', x || 0), one('y', y || 0)].filter(Boolean).join(' ') || 'translate-none';
      }
      default: return `${d.u}-${arb(value)}`;
    }
  }

  // classes on the element that set the same property (base or responsive variants only)
  function twRelated(prop, cls, theme) {
    const d = TW[prop];
    if (!d || !cls) return [];
    const T = themeOf(theme);
    const screens = new Set(Object.keys({ ...DEF.screens, ...T.screens }));
    let rel = d.rel;
    if (prop === 'font-size') {
      const names = Object.keys(Object.keys(T.text).length ? T.text : DEF.text).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      rel = new RegExp(`^text-(${names.join('|')}|\\[(length:)?[\\d.]+(px|rem|em)\\])$`);
    }
    const out = [];
    for (const c of String(cls).split(/\s+/)) {
      if (!c) continue;
      const parts = c.split(':');
      const base = parts.pop().replace(/^!/, '');
      if (!parts.every((v) => screens.has(v) || /^(max|min)-/.test(v))) continue;
      if (rel.test(base)) out.push(c);
    }
    return out.slice(0, 3);
  }

  // Responsive prefix for edits made at `width`. Mobile-first: the smallest design (< 640px) is the
  // base; a wider design gets the largest screen between the next smaller design and its own width
  // (lg for desktop widths when lg is in that range).
  function prefixFor(width, widths, theme) {
    const T = themeOf(theme);
    const screens = Object.entries({ ...DEF.screens, ...T.screens }).sort((a, b) => a[1] - b[1]);
    const smaller = widths.filter((w) => w < width).sort((a, b) => b - a)[0];
    if (smaller == null && width < 640) return '';
    const prev = smaller != null ? smaller : width >= 1024 ? 1023 : width >= 768 ? 767 : 639;
    const inRange = screens.filter(([, px]) => px > prev && px <= width);
    const lg = inRange.find(([n]) => n === 'lg');
    if (width >= 1024 && lg) return 'lg'; // desktop designs conventionally start at lg
    if (inRange.length) return inRange[inRange.length - 1][0];
    const below = screens.filter(([, px]) => px <= width).pop();
    return below ? below[0] : '';
  }

  function twSuggest(e, prefix, theme) {
    if (e.kind === 'order') return null;
    const u = twUtility(e.prop, e.to, theme);
    if (!u) return null;
    const p = prefix ? prefix + ':' : '';
    const sug = u.split(' ').map((x) => p + x).join(' ');
    const cur = twRelated(e.prop, e.cls, theme);
    return { current: cur, suggested: sug };
  }

  // ---------- export ----------

  // doc: { url, title, at (ISO), tailwind: theme|null, bps: [{ width, name, file, edits[], missing?: Set of edit idx }] }
  function groupByElement(edits) {
    const groups = new Map();
    for (const e of edits) {
      const k = e.sel + '#' + (e.exact || 0);
      if (!groups.has(k)) groups.set(k, { sel: e.sel, exact: e.exact || 0, n: e.n || 1, label: e.label, src: e.src, edits: [] });
      const g = groups.get(k);
      g.edits.push(e);
      g.n = Math.max(g.n, e.n || 1);
      if (!g.src && e.src) g.src = e.src;
    }
    return [...groups.values()];
  }

  function build(doc) {
    const widths = doc.bps.map((b) => b.width);
    const tw = doc.tailwind || null;
    return doc.bps.filter((b) => b.edits && b.edits.length).map((b) => {
      const prefix = tw ? prefixFor(b.width, widths, tw) : null;
      const screenPx = tw && prefix ? ({ ...DEF.screens, ...(tw.screens || {}) })[prefix] : null;
      return {
        width: b.width, name: b.name, design: b.file || null, prefix, screenPx,
        elements: groupByElement(b.edits).map((g) => ({
          selector: g.sel, exact: g.exact || undefined, count: g.n, label: g.label, source: g.src || null,
          changes: g.edits.map((e) => {
            const s = tw ? twSuggest(e, prefix, tw) : null;
            return {
              prop: e.prop, from: e.from, to: e.to, text: describe(e),
              kids: e.kind === 'order' ? e.kids : undefined,
              missing: !!e.missing || undefined,
              tailwind: s || undefined,
            };
          }),
        })),
      };
    });
  }

  function toJson(doc) {
    return {
      schema: 'parity.edits/1',
      page: { url: doc.url, title: doc.title || '' },
      exported: doc.at,
      tailwind: doc.tailwind ? { v4: !!doc.tailwind.v4 } : null,
      breakpoints: build(doc),
    };
  }

  function toMarkdown(doc) {
    const bps = build(doc);
    const total = bps.reduce((n, b) => n + b.elements.reduce((m, g) => m + g.changes.length, 0), 0);
    let where = doc.url;
    try { const u = new URL(doc.url); where = u.host + u.pathname; } catch (e) { /* keep */ }
    const L = [];
    L.push(`# Parity edits · ${where}`);
    L.push(`${total} change${total === 1 ? '' : 's'} · ${bps.map((b) => b.width + 'px').join(', ') || '—'} · ${String(doc.at || '').slice(0, 16).replace('T', ' ')}`);
    L.push('');
    L.push('Calibrated by hand in the browser against the design JPEG. Each line: property, current → target (computed CSS at that viewport width).');
    L.push(doc.tailwind
      ? 'Apply in source. Tailwind classes are suggestions; mobile-first, so an unprefixed class also reaches wider screens.'
      : 'Apply in source at the breakpoint shown.');
    L.push('Element headings: source file:line (Astro dev) when known, then the DOM selector.');
    for (const b of bps) {
      L.push('');
      L.push(`## ${b.width}px${b.name ? ' · ' + b.name : ''}${b.prefix != null ? ` · ${b.prefix ? '`' + b.prefix + ':`' + (b.screenPx ? ` (≥${b.screenPx}px)` : '') : 'base (no prefix)'}` : ''}`);
      for (const g of b.elements) {
        L.push('');
        const many = g.count > 1 ? ` ×${g.count}` : '';
        const all = g.exact ? ' (every element with exactly these classes)' : '';
        L.push(g.source ? `### ${g.source} · \`${g.label}\`${many}` : `### \`${g.selector}\`${many}${all}`);
        if (g.source) L.push(`Selector \`${g.selector}\`${all}`);
        for (const c of g.changes) {
          let line = `- ${c.text}`;
          if (c.tailwind) line += c.tailwind.current.length ? ` · \`${c.tailwind.current.join(' ')}\` → \`${c.tailwind.suggested}\`` : ` · add \`${c.tailwind.suggested}\``;
          if (c.missing) line += ' · (element not found on the page at export)';
          L.push(line);
        }
      }
    }
    return L.join('\n') + '\n';
  }

  const api = { upsert, describe, pxOf, trim, twUtility, twRelated, twSuggest, prefixFor, build, toMarkdown, toJson, TW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ParityEdits = api;
})(typeof self !== 'undefined' ? self : globalThis);
