/*
 * Parity — DOM collection + capture preparation.
 * Injected together with content.js. Exposes globalThis.ParityCollect.
 */
(function () {
  if (globalThis.ParityCollect) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'DIALOG']);
  const MEDIA = new Set(['img', 'video', 'canvas', 'svg', 'iframe', 'input', 'textarea', 'select', 'progress', 'meter', 'object', 'embed', 'hr', 'picture']);
  const NOISY_CLASS = /^(astro-|svelte-|css-|sc-|jsx-|emotion-|_)/;

  const num = (v) => {
    const f = parseFloat(v);
    return Number.isFinite(f) ? Math.round(f * 100) / 100 : 0;
  };
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  };
  const union = (a, b) => {
    if (!a) return b ? { ...b } : null;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const intersect = (a, b) => {
    if (!a || !b) return null;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0.5 && h > 0.5 ? { x, y, w, h } : null;
  };
  const rnd = (r) => r && { x: Math.round(r.x * 2) / 2, y: Math.round(r.y * 2) / 2, w: Math.round(r.w * 2) / 2, h: Math.round(r.h * 2) / 2 };

  function uniqueSelector(el) {
    const okId = (id) => id && /^[A-Za-z][\w-]*$/.test(id);
    if (okId(el.id) && document.querySelectorAll('#' + el.id).length === 1) return '#' + el.id;
    const parts = [];
    let cur = el;
    let guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 12) {
      let seg;
      if (okId(cur.id) && cur !== el && document.querySelectorAll('#' + cur.id).length === 1) {
        seg = '#' + cur.id;
        parts.unshift(seg);
        const sel = parts.join(' > ');
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
        break;
      }
      seg = cur.tagName.toLowerCase();
      if (cur.tagName === 'BODY') { parts.unshift('body'); break; }
      const cls = [...cur.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && !NOISY_CLASS.test(c)).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      const sel = parts.join(' > ');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) { /* ignore */ }
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ---- font metrics (cap height / ascent) via canvas, cached per font ----
  const fmCache = new Map();
  let fmCtx = null;
  function fontMetrics(cs) {
    const font = `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`;
    if (fmCache.has(font)) return fmCache.get(font);
    if (!fmCtx) fmCtx = document.createElement('canvas').getContext('2d');
    fmCtx.font = font;
    const H = fmCtx.measureText('H');
    const x = fmCtx.measureText('x');
    const m = {
      cap: H.actualBoundingBoxAscent / 100,           // cap height / font-size
      xh: x.actualBoundingBoxAscent / 100,            // x-height / font-size
      asc: (H.fontBoundingBoxAscent || 80) / 100,     // ascent / font-size
      desc: (H.fontBoundingBoxDescent || 20) / 100,   // descent / font-size
    };
    fmCache.set(font, m);
    return m;
  }

  // ---- project breakpoints: @media (min-width / width >=) and --breakpoint-* ----
  function scanBreakpoints() {
    const rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const toPx = (v, u) => (u === 'px' ? +v : +v * (u === 'rem' ? rootFs : 16));
    const minW = new Map(), maxW = new Map(), named = {};
    const reMin = /(?:min-width\s*:\s*|width\s*>=\s*)([\d.]+)(px|rem|em)/g;
    const reMax = /(?:max-width\s*:\s*|width\s*<\s*=?\s*)([\d.]+)(px|rem|em)/g;
    let sheetsRead = 0, sheetsBlocked = 0;
    const visit = (rules) => {
      for (const r of rules) {
        if (r.conditionText != null && r.media) {
          let m;
          reMin.lastIndex = 0; reMax.lastIndex = 0;
          while ((m = reMin.exec(r.conditionText))) { const px = Math.round(toPx(m[1], m[2])); minW.set(px, (minW.get(px) || 0) + 1); }
          while ((m = reMax.exec(r.conditionText))) { const px = Math.round(toPx(m[1], m[2])); maxW.set(px, (maxW.get(px) || 0) + 1); }
        }
        if (r.style && r.selectorText && /:root|:host|^html$/.test(r.selectorText)) {
          for (let k = 0; k < r.style.length; k++) {
            const prop = r.style[k];
            if (prop.startsWith('--breakpoint-')) {
              const v = r.style.getPropertyValue(prop).trim().match(/^([\d.]+)(px|rem|em)$/);
              if (v) named[prop.slice(13)] = Math.round(toPx(v[1], v[2]));
            }
          }
        }
        if (r.cssRules) visit(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) {
      try { visit(sh.cssRules); sheetsRead++; } catch (e) { sheetsBlocked++; }
    }
    const rootCs = getComputedStyle(document.documentElement);
    for (const n of ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']) {
      if (named[n]) continue;
      const v = rootCs.getPropertyValue('--breakpoint-' + n).trim().match(/^([\d.]+)(px|rem|em)$/);
      if (v) named[n] = Math.round(toPx(v[1], v[2]));
    }
    const list = (m) => [...m].sort((a, b) => a[0] - b[0]).map(([px, count]) => ({ px, count }));
    return { named, minWidths: list(minW).slice(0, 16), maxWidths: list(maxW).slice(0, 16), rootFontSize: rootFs, sheetsRead, sheetsBlocked };
  }

  const BLOCK_ATTR = /^data-(block|block-id|block-type|blockid|content-type|contenttype|element-type|component|section|umb)/i;

  function isOurs(el) {
    return el.hasAttribute && el.hasAttribute('data-parity');
  }

  function collect(opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes || 4000;
    const sx = window.scrollX, sy = window.scrollY;
    const W = document.documentElement.clientWidth;
    const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const page = { x: 0, y: 0, w: W, h: docH };
    const nodes = [];
    const range = document.createRange();
    const ignored = new Set();
    for (const sel of opts.ignore || []) {
      try { document.querySelectorAll(sel).forEach((e) => ignored.add(e)); } catch (e) { /* bad selector */ }
    }

    function bgBehind(el) {
      let a = el.parentElement;
      while (a) {
        const c = getComputedStyle(a).backgroundColor;
        if (alpha(c) > 0.05) return c;
        a = a.parentElement;
      }
      return 'rgb(255, 255, 255)';
    }

    function walk(el, parentIdx, depth) {
      if (nodes.length >= maxNodes) return null;
      if (SKIP.has(el.tagName) || isOurs(el)) return null;
      const tag = el.tagName.toLowerCase();
      const isSvgChild = el instanceof SVGElement && tag !== 'svg';
      if (isSvgChild) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return null;
      if (cs.display === 'contents') {
        let ink = null;
        for (const c of el.children) ink = union(ink, walk(c, parentIdx, depth));
        return ink;
      }
      const visible = cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.02;
      const r = el.getBoundingClientRect();
      const box = { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
      const media = MEDIA.has(tag);
      const bgA = alpha(cs.backgroundColor);
      const bw = [num(cs.borderTopWidth), num(cs.borderRightWidth), num(cs.borderBottomWidth), num(cs.borderLeftWidth)];
      const hasBorder = bw.some((v) => v > 0) && alpha(cs.borderTopColor) + alpha(cs.borderLeftColor) + alpha(cs.borderBottomColor) > 0.1 && cs.borderStyle !== 'none';
      const bgVisible = bgA > 0.05 && cs.backgroundColor !== bgBehind(el);
      const bv = visible && tag !== 'body' && tag !== 'html' && (bgVisible || cs.backgroundImage !== 'none' || hasBorder || cs.boxShadow !== 'none');
      let pseudo = false;
      if (visible && !media) {
        for (const pe of ['::before', '::after']) {
          const ps = getComputedStyle(el, pe);
          if (ps.content && ps.content !== 'none' && ps.content !== 'normal' && ps.display !== 'none' && (ps.content !== '""' || alpha(ps.backgroundColor) > 0.05 || ps.backgroundImage !== 'none' || ps.borderTopWidth !== '0px')) pseudo = true;
        }
      }

      const idx = nodes.length;
      const node = { i: idx, p: parentIdx, d: depth, tag, box: rnd(box) };
      nodes.push(node);
      if (ignored.has(el)) {
        // excluded from analysis: keep the box (for the ledger / overlay) but don't walk inside
        node.ig = true;
        node.ink = rnd(intersect(box, page));
        node.sel = uniqueSelector(el);
        const cls0 = el.getAttribute('class');
        if (cls0) node.cls = cls0.trim().replace(/\s+/g, ' ').slice(0, 400);
        return node.ink;
      }
      // source + block context (Astro dev attributes, CMS block markers)
      const srcFile = el.getAttribute('data-astro-source-file');
      if (srcFile) node.src = { file: srcFile.replace(/^.*?\/src\//, 'src/'), loc: el.getAttribute('data-astro-source-loc') || undefined };
      let blockAttrs = null;
      for (const a of el.attributes) {
        if (BLOCK_ATTR.test(a.name)) (blockAttrs = blockAttrs || {})[a.name] = a.value.slice(0, 80);
      }
      if (tag === 'section' || blockAttrs) node.blk = blockAttrs || {};

      let text = '';
      let tink = null;
      const frags = [];
      if (visible && !media) {
        for (const c of el.childNodes) {
          if (c.nodeType === 3 && c.textContent.trim()) {
            text += ' ' + c.textContent;
            range.selectNodeContents(c);
            for (const rr of range.getClientRects()) {
              if (rr.width > 0.5 && rr.height > 0.5) {
                const f = { x: rr.left + sx, y: rr.top + sy, w: rr.width, h: rr.height };
                frags.push(f);
                tink = union(tink, f);
              }
            }
          }
        }
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (frags.length) {
        // group fragments into lines; derive cap top + baseline from font metrics
        frags.sort((a, b) => a.y - b.y || a.x - b.x);
        const lines = [];
        for (const f of frags) {
          const L = lines[lines.length - 1];
          if (L && Math.abs(L.y - f.y) < 2) { L.x0 = Math.min(L.x0, f.x); L.x1 = Math.max(L.x1, f.x + f.w); L.h = Math.max(L.h, f.h); }
          else lines.push({ y: f.y, h: f.h, x0: f.x, x1: f.x + f.w });
        }
        const fm = fontMetrics(cs);
        const fs = num(cs.fontSize);
        const k = (L) => L.h / (fm.asc + fm.desc); // content area -> scale (≈ font-size)
        const base = (L) => L.y + fm.asc * k(L);
        const first = lines[0], last = lines[lines.length - 1];
        const b0 = base(first);
        node.tm = {
          capTop: Math.round((b0 - fm.cap * fs) * 10) / 10,
          baseline: Math.round(b0 * 10) / 10,
          lastBaseline: Math.round(base(last) * 10) / 10,
          capH: Math.round(fm.cap * fs * 10) / 10,
          capRatio: Math.round(fm.cap * 1000) / 1000,
          lines: lines.length,
          x0: Math.round(first.x0), x1: Math.round(first.x1),
          lineBox: lines.length > 1 ? Math.round((lines[1].y - first.y) * 10) / 10 : undefined,
        };
      }

      let ink = null;
      if (visible && (media || bv || pseudo) && box.w > 0 && box.h > 0) ink = { ...box };
      ink = union(ink, tink);
      const childMedia = tag === 'svg' || tag === 'picture' || tag === 'select' || tag === 'iframe';
      if (!childMedia) {
        for (const c of el.children) {
          const ci = walk(c, idx, depth + 1);
          if (ci) ink = union(ink, ci);
        }
      }
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || (cs.clipPath && cs.clipPath !== 'none');
      if (ink && clips) ink = intersect(ink, box);
      if (ink) ink = intersect(ink, page);

      node.ink = rnd(ink);
      if (tink) node.tink = rnd(intersect(tink, page));
      node.bv = bv || media;
      if (media) node.media = true;

      if (ink) {
        if (el.id) node.id = el.id;
        const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
        if (cls.trim()) node.cls = cls.trim().replace(/\s+/g, ' ').slice(0, 400);
        if (text) node.text = text.slice(0, 120);
        else {
          const lab = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
          if (lab) node.label = lab.slice(0, 60);
        }
        const attrs = {};
        let na = 0;
        for (const a of el.attributes) {
          if (na >= 6) break;
          if (a.name.startsWith('data-') && !a.name.startsWith('data-parity')) { attrs[a.name] = a.value.slice(0, 60); na++; }
        }
        if (tag === 'img' && el.getAttribute('src')) attrs.src = el.getAttribute('src').split('?')[0].split('/').pop().slice(0, 80);
        if (tag === 'a' && el.getAttribute('href')) attrs.href = el.getAttribute('href').slice(0, 80);
        if (el.getAttribute('aria-label')) attrs['aria-label'] = el.getAttribute('aria-label').slice(0, 60);
        if (Object.keys(attrs).length) node.attrs = attrs;
        node.sel = uniqueSelector(el);
        const st = {
          display: cs.display,
          position: cs.position,
          m: [num(cs.marginTop), num(cs.marginRight), num(cs.marginBottom), num(cs.marginLeft)],
          pd: [num(cs.paddingTop), num(cs.paddingRight), num(cs.paddingBottom), num(cs.paddingLeft)],
          w: cs.width,
          h: cs.height,
          fs: num(cs.fontSize),
          lh: cs.lineHeight === 'normal' ? Math.round(num(cs.fontSize) * 1.2 * 10) / 10 : num(cs.lineHeight),
          fw: cs.fontWeight,
          ff: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
          ls: cs.letterSpacing,
          color: cs.color,
          bg: cs.backgroundColor,
        };
        if (cs.maxWidth !== 'none') st.maxW = cs.maxWidth;
        if (cs.minHeight !== 'auto' && cs.minHeight !== '0px') st.minH = cs.minHeight;
        if (/flex|grid/.test(cs.display)) {
          st.gap = [num(cs.rowGap), num(cs.columnGap)];
          st.fd = cs.flexDirection;
          st.jc = cs.justifyContent;
          st.ai = cs.alignItems;
          if (/grid/.test(cs.display)) st.gtc = cs.gridTemplateColumns.slice(0, 80);
        }
        if (cs.position !== 'static') { st.top = cs.top; st.left = cs.left; }
        if (bw.some((v) => v > 0)) st.bw = bw;
        if (cs.borderRadius !== '0px') st.br = cs.borderRadius;
        if (cs.textAlign !== 'start') st.ta = cs.textAlign;
        if (cs.transform !== 'none') st.transform = cs.transform.slice(0, 60);
        node.st = st;
      }
      return visible || ink ? node.ink : null;
    }

    if (document.body) walk(document.body, -1, 0);
    let breakpoints = null;
    try { breakpoints = scanBreakpoints(); } catch (e) { /* ignore */ }
    return { nodes, width: W, docHeight: docH, vh: window.innerHeight, truncated: nodes.length >= maxNodes, breakpoints };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}html,body{scroll-behavior:auto!important}`;

  function setFreeze(on) {
    let s = document.getElementById('parity-freeze');
    if (on && !s) {
      s = document.createElement('style');
      s.id = 'parity-freeze';
      s.setAttribute('data-parity', '');
      s.textContent = FREEZE_CSS;
      (document.head || document.documentElement).appendChild(s);
    } else if (!on && s) s.remove();
    if (on) {
      try {
        for (const a of document.getAnimations()) {
          try {
            const end = a.effect && a.effect.getComputedTiming().endTime;
            if (end === Infinity) a.pause(); else a.finish();
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }
  }

  async function prepare() {
    setFreeze(true);
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
    // walk the page so lazy content / reveal-on-scroll triggers
    const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
    const maxH = Math.min(60000, document.documentElement.scrollHeight);
    for (let y = 0, k = 0; y < maxH && k < 90; y += step, k++) {
      window.scrollTo(0, y);
      await sleep(45);
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(120);
    window.scrollTo(0, 0);
    try { await Promise.race([document.fonts.ready, sleep(3000)]); } catch (e) { /* ignore */ }
    const pending = [...document.images].filter((i) => !i.complete);
    await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(4000)]);
    setFreeze(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(250);
    window.scrollTo(0, 0);
    await sleep(50);
  }

  globalThis.ParityCollect = { collect, prepare, setFreeze, uniqueSelector, scanBreakpoints };
})();
