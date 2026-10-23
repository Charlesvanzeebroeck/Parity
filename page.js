/*
 * Parity — page helpers for the content scripts: selectors, labels, Astro source lookup,
 * similar elements, colour normalisation, Tailwind theme scan, motion freeze, page styles.
 * Exposes globalThis.ParityPage.
 */
(function () {
  if (globalThis.ParityPage) return;

  const NOISY_CLASS = /^(astro-|svelte-|css-|sc-|jsx-|emotion-|_)/;
  const safeClass = (c) => /^[A-Za-z_-][\w-]*$/.test(c) && !NOISY_CLASS.test(c);
  const isOurs = (el) => !!(el && el.closest && el.closest('[data-parity]'));

  function uniqueSelector(el) {
    const okId = (id) => id && /^[A-Za-z][\w-]*$/.test(id);
    if (okId(el.id) && document.querySelectorAll('#' + el.id).length === 1) return '#' + el.id;
    const parts = [];
    let cur = el;
    let guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 12) {
      if (okId(cur.id) && cur !== el && document.querySelectorAll('#' + cur.id).length === 1) {
        parts.unshift('#' + cur.id);
        break;
      }
      let seg = cur.tagName.toLowerCase();
      if (cur.tagName === 'BODY') { parts.unshift('body'); break; }
      const cls = [...cur.classList].filter(safeClass).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* keep climbing */ }
      cur = parent;
    }
    return parts.join(' > ');
  }

  function labelOf(el) {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return tag + '#' + el.id;
    const cls = [...el.classList].filter(safeClass).slice(0, 2);
    return tag + (cls.length ? '.' + cls.join('.') : '');
  }

  // Astro dev adds data-astro-source-file / -loc to every element it renders.
  function srcOf(el) {
    for (let n = el, up = 0; n && n.nodeType === 1 && up < 6; n = n.parentElement, up++) {
      const f = n.getAttribute('data-astro-source-file');
      if (!f) continue;
      const i = f.lastIndexOf('/src/');
      const file = i >= 0 ? f.slice(i + 1) : f.split('/').slice(-3).join('/');
      const line = (n.getAttribute('data-astro-source-loc') || '').split(':')[0];
      return file + (line ? ':' + line : '') + (up ? ' (parent)' : '');
    }
    return null;
  }

  // Elements with exactly the same class list (≥ 2 on the page) — "apply to all similar".
  function similarOf(el) {
    const cls = [...el.classList];
    if (!cls.length) return null;
    const sel = el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
    let els = [];
    try { els = [...document.querySelectorAll(sel)].filter((x) => x.classList.length === cls.length && !isOurs(x)); } catch (e) { return null; }
    return els.length > 1 ? { sel, exact: cls.length, n: els.length, els } : null;
  }

  // any CSS colour (rgb, oklch, named…) → #rrggbb / #rrggbbaa / 'transparent'
  let cctx = null;
  function toHex(color) {
    if (!color) return '';
    if (!cctx) { const c = document.createElement('canvas'); c.width = c.height = 1; cctx = c.getContext('2d', { willReadFrequently: true }); }
    cctx.clearRect(0, 0, 1, 1);
    cctx.fillStyle = '#000';
    cctx.fillStyle = color;
    cctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return 'transparent';
    const h = (v) => v.toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b) + (a < 255 ? h(a) : '');
  }

  // ---- Tailwind theme (v4 exposes it as :root custom properties; v3 falls back to defaults) ----
  function rootVars() {
    const names = new Set();
    const visit = (rules) => {
      for (const r of rules) {
        if (r.style && r.selectorText && /(^|,)\s*(:root|:host|html)\b/.test(r.selectorText)) {
          for (let k = 0; k < r.style.length; k++) if (r.style[k].startsWith('--')) names.add(r.style[k]);
        }
        if (r.cssRules) try { visit(r.cssRules); } catch (e) { /* ignore */ }
      }
    };
    for (const sh of document.styleSheets) { try { visit(sh.cssRules); } catch (e) { /* cross-origin */ } }
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    let n = 0;
    for (const name of names) {
      if (n++ > 3000) break;
      const v = cs.getPropertyValue(name).trim();
      if (v) out[name] = v;
    }
    return out;
  }

  function scanTheme() {
    const vars = rootVars();
    const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const toPx = (v) => {
      const m = /^(-?[\d.]+)(px|rem|em)$/.exec(String(v).trim());
      return m ? Math.round(parseFloat(m[1]) * (m[2] === 'px' ? 1 : rootFs) * 100) / 100 : null;
    };
    const v4 = '--spacing' in vars;
    const v3 = !!getComputedStyle(document.body).getPropertyValue('--tw-ring-offset-width');
    let utility = 0;
    const UTIL = /^(?:[\w-]+:)*-?(p|px|py|pt|pb|m|mx|my|mt|mb|gap|w|h|text|bg|rounded|flex|grid|items|justify)(-|$)/;
    for (const el of document.querySelectorAll('[class]')) {
      if (utility > 25) break;
      for (const c of el.classList) if (UTIL.test(c)) { utility++; break; }
    }
    if (!v4 && !v3 && utility <= 25) return null;
    const pick = (prefix) => {
      const o = {};
      for (const [k, v] of Object.entries(vars)) {
        if (!k.startsWith(prefix)) continue;
        const name = k.slice(prefix.length);
        if (name.includes('--')) continue; // --text-xl--line-height
        const px = toPx(v);
        if (px != null) o[name] = px;
      }
      return o;
    };
    const colors = {};
    let n = 0;
    for (const [k, v] of Object.entries(vars)) {
      if (!k.startsWith('--color-') || n++ > 600) continue;
      const hex = toHex(v);
      if (hex && hex !== 'transparent' && !colors[hex]) colors[hex] = k.slice(8);
    }
    return { v4, spacing: toPx(vars['--spacing']) || 4, text: pick('--text-'), radius: pick('--radius-'), containers: pick('--container-'), screens: pick('--breakpoint-'), colors };
  }

  // ---- motion freeze ----
  const FREEZE_CSS = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}html,body{scroll-behavior:auto!important}';
  function setFreeze(on) {
    pageStyle('freeze', on ? FREEZE_CSS : null);
    if (!on) return;
    try {
      for (const a of document.getAnimations()) {
        try {
          const end = a.effect && a.effect.getComputedTiming().endTime;
          if (end === Infinity) a.pause(); else a.finish();
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  // Page-level styles from Parity (cursor, freeze). Constructable sheets are not blocked by a
  // strict CSP; a <style data-parity> is the fallback. css = null removes it.
  const sheets = new Map();
  function pageStyle(id, css) {
    const old = sheets.get(id);
    if (old) {
      if (old.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== old.sheet);
      if (old.el) old.el.remove();
      sheets.delete(id);
    }
    if (css == null) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      sheets.set(id, { sheet });
    } catch (e) {
      const el = document.createElement('style');
      el.setAttribute('data-parity', '');
      el.textContent = css;
      (document.head || document.documentElement).appendChild(el);
      sheets.set(id, { el });
    }
  }

  globalThis.ParityPage = { uniqueSelector, labelOf, srcOf, similarOf, toHex, scanTheme, setFreeze, pageStyle, isOurs };
})();
