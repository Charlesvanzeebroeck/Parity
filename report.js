/* Parity — report page: runs the analysis worker, renders the viewer, exports agent JSON. */
(function () {
  const qs = new URLSearchParams(location.search);
  const KEY = qs.get('k');
  const BP_IDS = (qs.get('b') || '').split(',').filter(Boolean);
  const TAB_ID = +qs.get('t') || null;
  const SK = qs.get('s') || ''; // section scope suffix ('' = whole page)
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
    set: (k, v) => chrome.storage.local.set({ [k]: v }),
  };

  const V = {
    proj: null,
    settings: { tolerance: 2, autoSave: true, saveImages: false, folder: 'parity' },
    bps: [],          // [{bp, cap, rep, status}]
    cur: 0,
    sel: null,
    mode: 'side',
    zoom: 'fit',
    opacity: 0.5,
    sev: new Set(['high', 'medium', 'low']),
    q: '',
    boxes: true,
  };

  // ---------- helpers ----------

  let toastT;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = 'toast'; }, err ? 5000 : 2000);
  }
  function progress(on, label, p, sub) {
    $('progress').hidden = !on;
    if (label != null) $('pLabel').textContent = label;
    if (p != null) $('pBar').style.width = Math.round(p * 100) + '%';
    if (sub != null) $('pSub').textContent = sub;
  }
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(`${what} copied`);
    }
  }
  const slug = (s) => String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
  const TW_DEFAULT = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

  // the project's own breakpoints (from the captured stylesheets), and which prefix to edit at this width
  function resolveBreakpoints(info, W) {
    let prefixes = {}, source = 'tailwind defaults (no project breakpoints found in the stylesheets)';
    if (info && info.named && Object.keys(info.named).length) {
      prefixes = info.named;
      source = 'CSS custom properties --breakpoint-*';
    } else if (info && info.minWidths && info.minWidths.length) {
      for (const { px } of info.minWidths) {
        const name = Object.keys(TW_DEFAULT).find((k) => TW_DEFAULT[k] === px) || `min-${px}`;
        prefixes[name] = px;
      }
      source = '@media (min-width / width >=) rules in the stylesheets';
    } else prefixes = { ...TW_DEFAULT };
    const sorted = Object.entries(prefixes).sort((a, b) => a[1] - b[1]);
    const active = sorted.filter(([, px]) => px <= W);
    const next = sorted.find(([, px]) => px > W);
    const editPrefix = active.length ? active[active.length - 1][0] : '(base)';
    const from = active.length ? active[active.length - 1][1] : 0;
    const usedMin = info && info.minWidths ? info.minWidths.map((m) => m.px).filter((px) => !sorted.some(([, v]) => v === px)) : [];
    return {
      source,
      prefixes: Object.fromEntries(sorted),
      active: ['(base)', ...active.map(([n]) => n)],
      editPrefix,
      appliesFrom: from,
      appliesTo: next ? next[1] - 1 : null,
      rule: `Edit ${editPrefix === '(base)' ? 'unprefixed (mobile-first base)' : editPrefix + ':'} classes${from ? ` (or @media (width >= ${from}px))` : ''}: they apply from ${from}px${next ? ` to ${next[1] - 1}px` : ' upward'}. ${next ? `Changing them does not affect ${next[0]} (≥${next[1]}px).` : ''}`.trim(),
      otherMediaMinWidths: usedMin.length ? usedMin : undefined,
      maxWidthQueries: info && info.maxWidths && info.maxWidths.length ? info.maxWidths.map((m) => m.px) : undefined,
    };
  }
  const twPrefixes = (w, bpi) => (bpi ? bpi.active : resolveBreakpoints(null, w).active);

  // compare with the previous run of the same breakpoint (ids are stable hashes of selector + kind)
  function diffReports(prev, cur) {
    if (!prev || !prev.issues) return null;
    // compare the issue's own cause only (absolute x/y move whenever something above is fixed)
    const sig = (it) => {
      const d = it.delta || {};
      const v = { sx: it.ownShift ? it.ownShift.x : 0, sy: it.ownShift ? it.ownShift.y : 0, w: d.w || 0, h: d.h || 0, fs: it.fontSize ? it.fontSize.design : 0 };
      for (const [k, x] of Object.entries(d)) if (!['x', 'y', 'w', 'h'].includes(k)) v[k] = x;
      return v;
    };
    const differs = (a, b) => {
      const A = sig(a), B = sig(b);
      return [...new Set([...Object.keys(A), ...Object.keys(B)])].some((k) => Math.abs((A[k] || 0) - (B[k] || 0)) > 1);
    };
    const pm = new Map(prev.issues.map((i) => [i.id, i]));
    const cm = new Map(cur.issues.map((i) => [i.id, i]));
    const resolved = [], added = [], changed = [];
    let unchanged = 0;
    for (const [id, it] of pm) if (!cm.has(id)) resolved.push({ id, summary: it.summary, kind: it.kind });
    for (const [id, it] of cm) {
      const o = pm.get(id);
      if (!o) { added.push(id); it.status = 'new'; }
      else if (differs(o, it)) { changed.push({ id, before: o.summary, after: it.summary }); it.status = 'changed'; }
      else { unchanged++; it.status = 'unchanged'; }
    }
    return { previousCapturedAt: prev.capturedAt, previousExactPct: prev.stats && prev.stats.exactPct, resolved, added, changed, unchanged };
  }

  // ---------- Figma REST (optional): exact values for matched issues ----------

  function parseFigmaUrl(u) {
    const m = String(u || '').match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)[^?#]*\?[^#]*?node-id=([0-9]+)[-:%3A]+([0-9]+)/i);
    return m ? { key: m[1], nodeId: `${m[2]}:${m[3]}` } : null;
  }
  async function figmaFetch(path, token) {
    const r = await fetch('https://api.figma.com/v1/' + path, { headers: { 'X-Figma-Token': token } });
    if (!r.ok) throw new Error(`Figma API ${r.status} ${r.statusText} for ${path.split('?')[0]}`);
    return r.json();
  }
  async function loadFigmaFrame(bp, token, W) {
    const ref = parseFigmaUrl(bp.figmaUrl);
    if (!ref) throw new Error('Figma frame URL must contain node-id (right-click the frame → Copy link)');
    const j = await figmaFetch(`files/${ref.key}/nodes?ids=${encodeURIComponent(ref.nodeId)}`, token);
    const entry = j.nodes && j.nodes[ref.nodeId];
    if (!entry || !entry.document) throw new Error('Figma node not found: ' + ref.nodeId);
    let varNames = {};
    try {
      const v = await figmaFetch(`files/${ref.key}/variables/local`, token);
      for (const [id, x] of Object.entries((v.meta && v.meta.variables) || {})) varNames[id] = x.name;
    } catch (e) { /* variables API needs an Enterprise plan; ids only */ }
    const styleNames = {};
    for (const [id, st] of Object.entries(entry.styles || {})) styleNames[id] = st.name;
    const root = entry.document;
    const fb = root.absoluteBoundingBox;
    const k = W / fb.width;
    const flat = [];
    const bv = (o) => {
      if (!o) return null;
      const out = {};
      for (const [prop, val] of Object.entries(o)) {
        const one = Array.isArray(val) ? val[0] : val;
        if (one && one.id) out[prop] = varNames[one.id] || one.id;
      }
      return Object.keys(out).length ? out : null;
    };
    const walk = (n) => {
      if (n.visible === false) return;
      const b = n.absoluteBoundingBox;
      if (b && n !== root) {
        const rec = { nodeId: n.id, name: n.name, type: n.type, box: { x: Math.round((b.x - fb.x) * k), y: Math.round((b.y - fb.y) * k), w: Math.round(b.width * k), h: Math.round(b.height * k) } };
        const values = {};
        if (n.type === 'TEXT') {
          rec.characters = (n.characters || '').replace(/\s+/g, ' ').trim();
          const st = n.style || {};
          Object.assign(values, { fontSize: st.fontSize, lineHeightPx: st.lineHeightPx && Math.round(st.lineHeightPx * 100) / 100, letterSpacing: st.letterSpacing, fontFamily: st.fontFamily, fontWeight: st.fontWeight, textCase: st.textCase });
          if (n.styles && n.styles.text) rec.textStyle = styleNames[n.styles.text] || n.styles.text;
        }
        if (n.layoutMode && n.layoutMode !== 'NONE') {
          Object.assign(values, { layoutMode: n.layoutMode, itemSpacing: n.itemSpacing, counterAxisSpacing: n.counterAxisSpacing, paddingTop: n.paddingTop, paddingRight: n.paddingRight, paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft });
        }
        if (n.cornerRadius) values.cornerRadius = n.cornerRadius;
        rec.values = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
        rec.boundVariables = bv(n.boundVariables);
        flat.push(rec);
      }
      for (const c of n.children || []) walk(c);
    };
    walk(root);
    return { ref, frame: { name: root.name, width: fb.width, height: fb.height, scale: Math.round(k * 1000) / 1000 }, nodes: flat };
  }
  const iou = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    if (w <= 0 || h <= 0) return 0;
    const i = w * h;
    return i / (a.w * a.h + b.w * b.h - i);
  };
  const normText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function figmaFor(it, fig) {
    const box = it.expected || it.actual;
    const txt = normText(it.element && it.element.text);
    let best = null;
    const consider = (n, score) => { if (score > 0 && (!best || score > best.score)) best = { n, score }; };
    for (const n of fig.nodes) {
      if (txt && n.type === 'TEXT') {
        const c = normText(n.characters);
        const same = c && (c === txt || (txt.length > 12 && (c.startsWith(txt.slice(0, 40)) || txt.startsWith(c.slice(0, 40)))));
        consider(n, (same ? 1 : 0) + iou(box, n.box) * 0.5 + (same ? 0.4 : 0));
      } else if (!txt && n.type !== 'TEXT') {
        const pref = /gap|padding/.test(it.kind.join()) ? (n.values.layoutMode ? 0.15 : -0.2) : 0;
        consider(n, iou(box, n.box) + pref);
      }
    }
    if (!best || best.score < 0.55) return null;
    const n = best.n;
    return { nodeId: n.nodeId, name: n.name, type: n.type, textStyle: n.textStyle, box: n.box, values: n.values, boundVariables: n.boundVariables, match: Math.round(best.score * 100) / 100 };
  }
  function applyFigma(rep, fig) {
    let mapped = 0;
    for (const it of rep.issues) {
      if (it.kind.includes('type-scale')) {
        // members' text nodes give the exact intended size
        const f = figmaFor(it, fig);
        if (f && f.values.fontSize) {
          it.figma = f;
          it.fontSize = { ...it.fontSize, design: f.values.fontSize, method: 'figma node style', imageEstimate: it.fontSize.design };
          it.suggestions = [`Figma: ${f.name} is ${f.values.fontSize}px${f.values.lineHeightPx ? ` / ${f.values.lineHeightPx}px` : ''}${f.textStyle ? ` (text style "${f.textStyle}")` : ''}${f.boundVariables && f.boundVariables.fontSize ? ` bound to variable ${f.boundVariables.fontSize}` : ' (raw value, not bound to a variable)'}.`, ...it.suggestions];
          mapped++;
        }
        continue;
      }
      const f = figmaFor(it, fig);
      if (!f) continue;
      it.figma = f;
      mapped++;
      const v = f.values || {};
      const raw = (prop) => (f.boundVariables && f.boundVariables[prop] ? `bound to ${f.boundVariables[prop]}` : 'raw value');
      if (it.kind.some((k) => k.startsWith('gap')) && v.itemSpacing != null) it.suggestions.unshift(`Figma: auto-layout itemSpacing ${v.itemSpacing}px (${raw('itemSpacing')}).`);
      if (it.kind.some((k) => k.startsWith('padding')) && v.paddingTop != null) it.suggestions.unshift(`Figma: padding ${v.paddingTop}/${v.paddingRight}/${v.paddingBottom}/${v.paddingLeft}px (${raw('paddingTop')}).`);
      if (v.fontSize && it.element && it.element.text) it.suggestions.unshift(`Figma: ${v.fontSize}px${v.lineHeightPx ? ` / ${v.lineHeightPx}px` : ''} ${v.fontFamily || ''} ${v.fontWeight || ''}${f.textStyle ? ` (style "${f.textStyle}")` : ''} — ${raw('fontSize')}.`.replace(/\s+/g, ' '));
    }
    return mapped;
  }

  // ---------- analysis ----------

  let worker = null;
  let jobId = 0;
  function runWorker(cap, designUrl, bp, sectionUrl) {
    if (!worker) worker = new Worker('analyzer-worker.js');
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') progress(true, null, m.p, m.label);
        else if (m.type === 'done') { worker.removeEventListener('message', onMsg); resolve(m.result); }
        else if (m.type === 'error') { worker.removeEventListener('message', onMsg); reject(new Error(m.error)); }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ id, cap, designUrl, sectionUrl, bp, tolerance: V.settings.tolerance, contentMode: (V.proj && V.proj.contentMode) || 'same' });
    });
  }

  async function analyzeEntry(entry, idx, total) {
    const { bp, cap } = entry;
    progress(true, `Analyzing ${bp.width}px${total > 1 ? ` (${idx + 1}/${total})` : ''}`, 0, 'Loading design');
    const designUrl = await store.get('img:' + (cap.bp.imgId || bp.imgId));
    if (!designUrl) throw new Error(`No design image stored for ${bp.width}px`);
    const sectionUrl = cap.scope && cap.bp.sectionImgId ? await store.get('img:' + cap.bp.sectionImgId) : null;
    const res = await runWorker(cap, designUrl, { ...bp, ...cap.bp }, sectionUrl);
    const prev = await store.get(`rep:${KEY}:${bp.id}${SK}`);
    if (res.cropImages) {
      await store.set(`crop:${KEY}:${bp.id}${SK}`, res.cropImages);
      entry.crop = res.cropImages;
    }
    const rep = {
      capId: cap.id,
      generatedAt: new Date().toISOString(),
      capturedAt: cap.capturedAt,
      url: cap.url,
      title: cap.title,
      breakpoint: { id: bp.id, name: bp.name, width: cap.width, viewportHeight: cap.vh },
      design: { file: cap.bp.file || bp.file, naturalWidth: res.designNatural.w, naturalHeight: res.designNatural.h, exportScale: cap.bp.scale || bp.scale, offset: { x: cap.bp.offsetX || 0, y: cap.bp.offsetY || 0 } },
      tolerancePx: V.settings.tolerance,
      truncated: !!cap.truncated,
      page: res.page,
      stats: res.stats,
      contentMode: res.contentMode,
      ignored: (V.proj && V.proj.ignore && V.proj.ignore.length) ? V.proj.ignore : undefined,
      projectBreakpoints: resolveBreakpoints(cap.breakpoints, cap.width),
      ledger: res.ledger,
      scope: res.scope || undefined,
      issues: res.issues,
    };
    const bpCfg = (V.proj && V.proj.breakpoints.find((b) => b.id === bp.id)) || bp;
    if (V.settings.figmaToken && bpCfg.figmaUrl) {
      progress(true, null, 0.99, 'Reading the Figma frame');
      try {
        const fig = await loadFigmaFrame(bpCfg, V.settings.figmaToken, cap.width);
        const mapped = applyFigma(rep, fig);
        rep.figma = { fileKey: fig.ref.key, nodeId: fig.ref.nodeId, frame: fig.frame, mappedIssues: mapped };
      } catch (err) {
        rep.figma = { error: String(err.message || err) };
      }
    }
    rep.diff = diffReports(prev && prev.capId !== cap.id ? prev : (prev && prev.previous) || null, rep);
    if (prev && prev.capId !== cap.id) rep.previous = { capturedAt: prev.capturedAt, stats: prev.stats, issues: prev.issues.map((i) => ({ id: i.id, summary: i.summary, kind: i.kind, severity: i.severity, delta: i.delta, ownShift: i.ownShift, fontSize: i.fontSize })) };
    else if (prev && prev.previous) rep.previous = prev.previous;
    await store.set(`rep:${KEY}:${bp.id}${SK}`, rep);
    if (TAB_ID) chrome.tabs.sendMessage(TAB_ID, { type: 'parity:report-ready', key: KEY, bpId: bp.id, sk: SK }).catch(() => {});
    return rep;
  }

  // ---------- agent JSON ----------

  function cleanIssue(it) {
    const o = {};
    for (const [k, v] of Object.entries(it)) {
      if (k.startsWith('_') || k === 'elementBox' || k === 'rank' || v === undefined) continue;
      if (Array.isArray(v) && !v.length) continue;
      o[k] = v;
    }
    if (o.element) o.element = Object.fromEntries(Object.entries(o.element).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
    return o;
  }

  function agentJson(entries) {
    const reps = entries.filter((e) => e.rep).map((e) => e.rep);
    const first = reps[0] || {};
    return {
      schema: 'parity.report/1',
      generatedAt: new Date().toISOString(),
      url: first.url,
      title: first.title,
      conventions: {
        units: 'CSS px in document coordinates at the given viewport width',
        delta: 'expected (Figma design) minus actual (live page). +y = move down / needs more space above, +h = make taller, +w = make wider',
        rootCauses: 'Each issue is the element that causes a mismatch. Shifts inherited from parents or earlier siblings are removed; sibling offsets that share a cause are grouped into one gap/padding issue on the parent, and text sharing one computed style and scale factor into one type-scale issue (members listed, member issues marked groupedInto).',
        frames: 'actual/expected/delta are on the visible box: the border box for elements with a background/border, the text line boxes (Range rects, i.e. font ascent+descent, NOT cap-trimmed) for text. box is the CSS border box. typography gives cap top and alphabetic baseline of the first line for site and design — use those for text positioning with text-box-trim / cap-trim.',
        ids: 'id is a stable hash of selector + kind: the same id across runs means the same problem. diffFromPrevious lists resolved / new / changed ids against the previous capture.',
        source: 'source = nearest data-astro-source-file/loc (Astro dev mode), block = nearest <section> or element with data-block*/data-content-type attributes, astroCid = scoped-style ids.',
        scope: 'When a breakpoint has scope, only that section was analyzed: its top is aligned to the same section in the design (or to a section-only JPEG), so drift from content above is excluded. Coordinates are page px in that aligned frame.',
        colors: 'Colors are sampled from the JPEG, so snap them to the nearest design token rather than using the hex literally.',
      },
      howToFix: [
        'Work top-to-bottom within a breakpoint: vertical fixes push everything below them.',
        'Only change styles that apply at the breakpoint in question (use the listed Tailwind prefixes or the matching media query) so other breakpoints are not affected.',
        'Use element.selector, element.classes, element.text and element.attrs to find the component in the codebase.',
        'computed holds the current computed styles; suggestions give concrete before → after values.',
        'After editing, re-run Parity (Alt+Shift+A in the browser) and re-read this file to verify.',
      ],
      breakpoints: reps.map((r) => ({
        name: r.breakpoint.name,
        viewport: { width: r.breakpoint.width, height: r.breakpoint.viewportHeight },
        breakpoints: r.projectBreakpoints,
        tailwindActivePrefixes: twPrefixes(r.breakpoint.width, r.projectBreakpoints),
        editPrefix: r.projectBreakpoints && r.projectBreakpoints.editPrefix,
        contentMode: r.contentMode,
        ignoredSelectors: r.ignored,
        design: r.design,
        figma: r.figma,
        page: r.page,
        truncated: r.truncated || undefined,
        scope: r.scope ? { ...r.scope, crop: undefined } : undefined,
        stats: { ...r.stats, ms: undefined },
        diffFromPrevious: r.diff || undefined,
        ledger: r.ledger,
        issues: r.issues.map(cleanIssue),
      })),
    };
  }

  function agentPrompt(entries) {
    const j = agentJson(entries);
    const lines = [];
    lines.push(`Fix the layout differences between the live page and its Figma design.`);
    lines.push(`Page: ${j.url}`);
    lines.push(`Parity compared a full-page capture against the design JPEG and traced each mismatch to the element that causes it (inherited shifts removed). Units are CSS px; delta = design − site (+y = move down, +h = make taller).`);
    lines.push(`Work top-to-bottom per breakpoint, and only change styles that apply at that breakpoint (responsive prefix / media query) so the others don't regress.`);
    for (const b of j.breakpoints) {
      lines.push('');
      lines.push(`## ${b.name} — ${b.viewport.width}px wide${b.scope ? ` — section ${b.scope.selector} only` : ''}`);
      if (b.scope) lines.push(`Section scope: only elements inside ${b.scope.selector} were analyzed, with the section top aligned to the design (${b.scope.source}${b.scope.offsetRemoved != null ? `; ${b.scope.offsetRemoved}px of drift from above was removed` : ''}). Fix only inside this section.`);
      if (b.breakpoints) lines.push(`Breakpoint rule: ${b.breakpoints.rule}`);
      lines.push(`${b.stats.exactPct}% of elements pixel-exact; page height ${b.page.actualHeight}px vs design ${b.page.designHeight}px.${b.contentMode === 'tolerant' ? ' Content-tolerant mode: copy/images differ from the mockup, only position, box edges and type are compared.' : ''}`);
      if (b.diffFromPrevious) {
        const d = b.diffFromPrevious;
        lines.push(`Since the previous run: ${d.resolved.length} resolved, ${d.added.length} new, ${d.changed.length} changed, ${d.unchanged} unchanged.${d.added.length ? ' New: ' + d.added.join(', ') : ''}`);
      }
      const drift = (b.ledger || []).filter((l) => Math.abs(l.ownTopDelta) > 1 || Math.abs(l.heightDelta) > 1);
      if (drift.length) {
        lines.push('Vertical ledger (band: own top Δ, height Δ, cumulative bottom Δ):');
        for (const l of drift.slice(0, 15)) lines.push(`   ${l.band} — ${l.ownTopDelta >= 0 ? '+' : ''}${l.ownTopDelta}, ${l.heightDelta >= 0 ? '+' : ''}${l.heightDelta}, ${l.cumulativeBottomDelta >= 0 ? '+' : ''}${l.cumulativeBottomDelta}`);
      }
      if (!b.issues.length) { lines.push('No issues above tolerance.'); continue; }
      for (const it of b.issues.slice(0, 40)) {
        lines.push(`#${it.id} [${it.severity}]${it.status && it.status !== 'unchanged' ? ' (' + it.status + ')' : ''} ${it.summary}`);
        lines.push(`   selector: ${it.element && it.element.selector}${it.element && it.element.classes ? `  classes: "${it.element.classes.slice(0, 160)}"` : ''}`);
        if (it.source) lines.push(`   source: ${it.source.file}${it.source.loc ? ':' + it.source.loc : ''}`);
        if (it.block && it.block.attrs) lines.push(`   block: ${JSON.stringify(it.block.attrs)}`);
        if (it.typography && it.typography.delta) lines.push(`   cap top Δ ${it.typography.delta.capTop}, baseline Δ ${it.typography.delta.baseline}`);
        if (it.figma) lines.push(`   figma: ${it.figma.name} ${JSON.stringify(it.figma.values)}${it.figma.boundVariables ? ' vars ' + JSON.stringify(it.figma.boundVariables) : ' (raw values)'}`);
        if (it.suggestions && it.suggestions.length) lines.push(`   fix: ${it.suggestions.join(' ')}`);
        if (it.tailwind) lines.push(`   related classes: ${it.tailwind.join(' ')}`);
      }
      if (b.issues.length > 40) lines.push(`…and ${b.issues.length - 40} more in the JSON.`);
    }
    lines.push('');
    lines.push(`Full structured report: ~/Downloads/${V.settings.folder}/latest.json`);
    lines.push(`When done, tell me to re-run Parity so you can verify against the new report.`);
    return lines.join('\n');
  }

  async function download(obj, filename, mime) {
    const blob = obj instanceof Blob ? obj : new Blob([JSON.stringify(obj, null, 2)], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  async function autoSave(entries) {
    if (!V.settings.autoSave) return;
    const folder = V.settings.folder || 'parity';
    const page = slug(KEY);
    try {
      for (const e of entries) {
        if (!e.rep) continue;
        const sfx = e.rep.scope ? '-' + slug(e.rep.scope.selector).slice(0, 30) : '';
        await download(agentJson([e]), `${folder}/${page}/${e.bp.width}${sfx}.json`);
        if (V.settings.saveImages) {
          const blob = await annotatedPng(e);
          if (blob) await download(blob, `${folder}/${page}/${e.bp.width}${sfx}-annotated.png`);
        }
      }
      const all = V.bps.filter((x) => x.rep);
      await download(agentJson(all), `${folder}/latest.json`);
      toast(`Saved to Downloads/${folder}/latest.json`);
    } catch (err) {
      toast('Auto-save failed: ' + err.message, true);
    }
  }

  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  async function annotatedPng(e) {
    const { cap, rep } = e;
    const W = cap.width;
    const H = Math.max(rep.page.actualHeight, rep.page.designHeight);
    const s = Math.min(0.5, 12000 / H);
    const gap = 24;
    const c = new OffscreenCanvas(Math.round((W * 2 + gap) * s), Math.round(H * s) + 30);
    const x = c.getContext('2d');
    x.fillStyle = '#111';
    x.fillRect(0, 0, c.width, c.height);
    x.font = 'bold 14px monospace';
    x.fillStyle = '#ff3d8b'; x.fillText('DESIGN', 6, 18);
    x.fillStyle = '#22d3ee'; x.fillText('SITE', (W + gap) * s + 6, 18);
    x.save();
    x.translate(0, 26);
    x.scale(s, s);
    const d = await loadImg(await store.get('img:' + (cap.bp.imgId || e.bp.imgId)));
    x.drawImage(d, cap.bp.offsetX || 0, cap.bp.offsetY || 0, W, (d.height * W) / d.width);
    for (const sh of cap.shots) x.drawImage(await loadImg(sh.data), W + gap, sh.y, W, sh.h);
    x.lineWidth = 2 / s;
    x.font = `bold ${Math.round(12 / s)}px monospace`;
    for (const it of rep.issues) {
      const col = it.severity === 'high' ? '#ff3d57' : it.severity === 'medium' ? '#ff9f1a' : '#8b8d94';
      x.strokeStyle = '#ff3d8b';
      x.setLineDash([6 / s, 4 / s]);
      if (it.expected) x.strokeRect(it.expected.x, it.expected.y, it.expected.w, it.expected.h);
      x.setLineDash([]);
      x.strokeStyle = '#22d3ee';
      if (it.actual) x.strokeRect(W + gap + it.actual.x, it.actual.y, it.actual.w, it.actual.h);
      x.fillStyle = col;
      if (it.actual) x.fillText('#' + it.id, W + gap + it.actual.x, it.actual.y - 3 / s);
      if (it.expected) x.fillText('#' + it.id, it.expected.x, it.expected.y - 3 / s);
    }
    x.restore();
    return c.convertToBlob({ type: 'image/png' });
  }

  // ---------- rendering ----------

  function renderHeader() {
    const e = V.bps[V.cur];
    const cap = e && e.cap;
    $('pageTitle').textContent = (cap && cap.title) || 'Parity report';
    $('pageUrl').textContent = (cap && cap.url) || KEY || '';
    $('pageUrl').href = (cap && cap.url) || '#';
    document.title = `Parity — ${(cap && cap.title) || 'report'}`;
    if (cap && cap.scope) $('pageTitle').textContent = `${cap.title || ''} — section ${cap.scope.label || cap.scope.selector}`;
    $('tabs').innerHTML = V.bps.map((x, i) => {
      const st = x.status === 'busy' ? 'busy' : x.rep ? (x.rep.issues.length ? 'bad' : 'ok') : '';
      return `<button class="tab ${i === V.cur ? 'on' : ''}" data-i="${i}" title="${esc(x.bp.name)}"><span class="d ${st}"></span>${x.bp.width}</button>`;
    }).join('');
    $('rerun').disabled = !TAB_ID;
  }

  const fmt = (v) => (v > 0 ? '+' : '') + v;
  function renderStats() {
    const e = V.bps[V.cur];
    if (!e) { $('stats').innerHTML = ''; return; }
    if (!e.rep) {
      $('stats').innerHTML = `<div class="note ${e.error ? 'warn' : ''}">${esc(e.error || (e.cap ? 'Waiting for analysis…' : 'No capture for this breakpoint yet. Press Analyze in the Parity panel.'))}</div>`;
      return;
    }
    const s = e.rep.stats, p = e.rep.page;
    const hd = p.heightDelta;
    $('stats').innerHTML = `
      <div class="score"><b>${s.exactPct}%</b><span>elements pixel-exact (±${e.rep.tolerancePx}px)</span></div>
      <div class="meta">
        <span class="pill">${s.issues} issue${s.issues === 1 ? '' : 's'}</span>
        ${s.bySeverity.high ? `<span class="pill high">${s.bySeverity.high} high</span>` : ''}
        ${s.bySeverity.medium ? `<span class="pill medium">${s.bySeverity.medium} medium</span>` : ''}
        ${s.bySeverity.low ? `<span class="pill low">${s.bySeverity.low} low</span>` : ''}
        <span class="pill">${s.matched}/${s.analyzed} matched</span>
        <span class="pill">${s.inheritedShifts} inherited</span>
      </div>
      <div class="note">${e.rep.breakpoint.width}×${e.rep.breakpoint.viewportHeight} viewport · page ${p.actualHeight}px vs design ${p.designHeight}px${hd ? ` (${hd > 0 ? '+' : ''}${hd})` : ''} · ${new Date(e.rep.capturedAt).toLocaleTimeString()}</div>
      ${e.rep.scope ? `<div class="note bpnote"><b>section</b> ${esc(e.rep.scope.selector)} · ${esc(e.rep.scope.source)}${e.rep.scope.offsetRemoved != null ? ` · ${fmt(e.rep.scope.offsetRemoved)}px drift from above removed` : ''}</div>` : ''}
      ${e.rep.projectBreakpoints ? `<div class="note bpnote"><b>${esc(e.rep.projectBreakpoints.editPrefix)}</b> ${esc(e.rep.projectBreakpoints.rule)}</div>` : ''}
      ${e.rep.contentMode === 'tolerant' ? '<div class="note">Content-tolerant mode: copy and images may differ from the mockup.</div>' : ''}
      ${e.rep.diff ? `<div class="diffbar"><span class="pill ok">✓ ${e.rep.diff.resolved.length} resolved</span><span class="pill high">${e.rep.diff.added.length} new</span><span class="pill medium">${e.rep.diff.changed.length} changed</span><span class="pill">${e.rep.diff.unchanged} unchanged</span><span class="dim">vs ${new Date(e.rep.diff.previousCapturedAt).toLocaleTimeString()}${e.rep.diff.previousExactPct != null ? ` (${e.rep.diff.previousExactPct}% → ${s.exactPct}%)` : ''}</span></div>
        ${e.rep.diff.resolved.length ? `<details class="fold"><summary>Resolved since last run</summary>${e.rep.diff.resolved.map((r) => `<div class="mini"><code>#${esc(r.id)}</code> ${esc(r.summary)}</div>`).join('')}</details>` : ''}` : ''}
      ${e.rep.figma ? `<div class="note ${e.rep.figma.error ? 'warn' : ''}">${e.rep.figma.error ? 'Figma: ' + esc(e.rep.figma.error) : `Figma frame “${esc(e.rep.figma.frame.name)}”: ${e.rep.figma.mappedIssues} issues mapped to nodes`}</div>` : ''}
      ${e.rep.ledger && e.rep.ledger.length ? `<details class="fold"><summary>Vertical ledger (${e.rep.ledger.length} bands)</summary><table class="ledger"><thead><tr><th>Band</th><th>Site</th><th>Design</th><th>Own Δ</th><th>H Δ</th><th>Cum Δ</th></tr></thead><tbody>${e.rep.ledger.map((l) => `<tr class="${Math.abs(l.ownTopDelta) > e.rep.tolerancePx || Math.abs(l.heightDelta) > e.rep.tolerancePx ? 'hot' : ''}"><td title="${esc(l.selector)}">${esc(l.band.replace(/^<([^>]+)>.*$/, '$1'))}</td><td>${l.site.top}–${l.site.bottom}</td><td>${l.design.top}–${l.design.bottom}</td><td>${fmt(l.ownTopDelta)}</td><td>${fmt(l.heightDelta)}</td><td>${fmt(l.cumulativeBottomDelta)}</td></tr>`).join('')}</tbody></table></details>` : ''}
      ${e.rep.truncated ? '<div class="note warn">Page was taller than 30 000px — only the top part was analyzed.</div>' : ''}
      ${e.cap && e.cap.width !== Math.round(e.rep.breakpoint.width) ? '<div class="note warn">Capture width differs from the breakpoint.</div>' : ''}`;
  }

  function filtered() {
    const e = V.bps[V.cur];
    if (!e || !e.rep) return [];
    const q = V.q.trim().toLowerCase();
    return e.rep.issues.filter((it) => V.sev.has(it.severity) && (!q || JSON.stringify([it.summary, it.element, it.kind]).toLowerCase().includes(q)));
  }

  function renderList() {
    const e = V.bps[V.cur];
    const list = $('list');
    if (!e || !e.rep) { list.innerHTML = ''; return; }
    const items = filtered();
    if (!e.rep.issues.length) {
      list.innerHTML = `<div class="empty"><b>Pixel parity.</b>No element is off by more than ${e.rep.tolerancePx}px at ${e.rep.breakpoint.width}px.</div>`;
      return;
    }
    if (!items.length) { list.innerHTML = '<div class="empty">No issues match the filter.</div>'; return; }
    list.innerHTML = items.map((it) => {
      const d = it.delta || {};
      const deltas = [];
      if (it.ownShift && (it.ownShift.x || it.ownShift.y)) deltas.push(`<span><em>move</em> ${it.ownShift.x ? `x ${fmt(it.ownShift.x)} ` : ''}${it.ownShift.y ? `y ${fmt(it.ownShift.y)}` : ''}</span>`);
      if (d.w) deltas.push(`<span><em>w</em> ${fmt(d.w)}</span>`);
      if (d.h) deltas.push(`<span><em>h</em> ${fmt(d.h)}</span>`);
      for (const k of Object.keys(d)) if (/^(gap|padding)/.test(k)) deltas.push(`<span><em>${k}</em> ${fmt(d[k])}</span>`);
      if (it.color) deltas.push(`<span><span class="swatch" style="background:${it.color.actual}"></span>${it.color.actual} → <span class="swatch" style="background:${it.color.expected}"></span>${it.color.expected}</span>`);
      return `<div class="card ${V.sel === it.id ? 'sel' : ''}" data-id="${it.id}">
        <div class="ch"><span class="dot ${it.severity}"></span><span class="id">#${it.id}</span>${it.status === 'new' ? '<span class="st new">new</span>' : it.status === 'changed' ? '<span class="st chg">changed</span>' : ''}<span class="kinds">${it.kind.map((k) => `<span class="kind">${esc(k)}</span>`).join('')}</span></div>
        <div class="sum">${esc(it.summary)}</div>
        <div class="sel-row"><code title="${esc(it.element && it.element.selector)}">${esc(it.element && it.element.selector)}</code><button class="copy" data-copy="${esc(it.element && it.element.selector)}" data-what="Selector">selector</button>${it.element && it.element.classes ? `<button class="copy" data-copy="${esc(it.element.classes)}" data-what="Classes">classes</button>` : ''}</div>
        ${deltas.length ? `<div class="deltas">${deltas.join('')}</div>` : ''}
        ${it.fontSize ? `<div class="deltas"><span><em>font-size</em> ${it.fontSize.site} → ${it.fontSize.design}px</span><span><em>×</em>${it.fontSize.ratio}</span></div>` : ''}
        ${it.typography && it.typography.delta ? `<div class="deltas"><span><em>cap top</em> ${fmt(it.typography.delta.capTop)}</span><span><em>baseline</em> ${fmt(it.typography.delta.baseline)}</span></div>` : ''}
        ${it.source || it.block ? `<div class="ctx">${it.source ? `<code>${esc(it.source.file)}${it.source.loc ? ':' + esc(it.source.loc) : ''}</code>` : ''}${it.block ? `<span>block ${esc(it.block.attrs ? Object.values(it.block.attrs).join(' · ') : it.block.selector)}</span>` : ''}</div>` : ''}
        ${it.figma ? `<div class="ctx fig"><span>Figma ${esc(it.figma.name)}</span><code>${esc(JSON.stringify(it.figma.values))}</code><span>${it.figma.boundVariables ? 'vars: ' + esc(Object.entries(it.figma.boundVariables).map(([k, v]) => k + '=' + v).join(', ')) : 'raw values'}</span></div>` : ''}
        ${it.suggestions && it.suggestions.length ? `<ul class="sugs">${it.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        ${it.tailwind ? `<div class="tw">${it.tailwind.map((c) => `<code>${esc(c)}</code>`).join('')}</div>` : ''}
        <div class="foot">${it.confidence != null ? `<span>confidence ${Math.round(it.confidence * 100)}%</span>` : ''}${it.notes ? `<span>${esc(it.notes.join(' · '))}</span>` : ''}${it.children ? `<span>${it.children.length} children</span>` : ''}</div>
      </div>`;
    }).join('');
  }

  let stageZoom = 1;
  function renderStage() {
    const e = V.bps[V.cur];
    const stage = $('stage');
    if (!e || !e.cap) { stage.innerHTML = ''; return; }
    const cap = e.cap;
    const W = cap.width;
    const scoped = !!(e.rep && e.rep.scope && e.crop);
    const cs = scoped ? e.rep.scope.crop : null;
    const Ha = scoped ? cs.site.h : cap.shots.reduce((m, s) => Math.max(m, s.y + s.h), 0);
    const bp = cap.bp || e.bp;
    const Hd = scoped ? cs.design.h : e.rep ? e.rep.page.designHeight : Math.round((bp.imgH * W) / bp.imgW);
    const H = Math.max(Ha, Hd);
    const avail = $('stageWrap').clientWidth - 40 - (V.mode === 'side' ? 24 : 0);
    const cols = V.mode === 'side' ? 2 : 1;
    stageZoom = V.zoom === 'fit' ? Math.min(1, avail / (W * cols)) : +V.zoom;
    const z = stageZoom;
    const issues = e.rep ? filtered() : [];
    const shotsHtml = scoped
      ? `<img src="${e.crop.site}" style="top:0;width:${W}px;height:${Ha}px" alt="">`
      : cap.shots.map((s, i) => `<img src="${(e.shotUrls && e.shotUrls[i]) || s.data}" style="top:${s.y}px;width:${W}px;height:${s.h}px" alt="">`).join('');
    const designHtml = scoped
      ? `<img class="design-img" src="${e.crop.design}" style="left:0;top:0;width:${W}px" alt="">`
      : `<img class="design-img" src="${e.designUrl || ''}" style="left:${bp.offsetX || 0}px;top:${bp.offsetY || 0}px;width:${W}px" alt="">`;
    const oy = scoped ? cs.site.y : 0; // scoped coordinates are page px aligned at the section top
    const boxesFor = (which) => issues.map((it) => {
      const r0 = which === 'e' ? it.expected : it.actual;
      if (!r0) return '';
      const r = { ...r0, y: r0.y - oy };
      const sel = V.sel === it.id ? ' sel' : '';
      return `<div class="bx ${which}${sel}" data-id="${it.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div><div class="bl ${it.severity}" style="left:${r.x}px;top:${r.y}px;transform:translateY(-100%) scale(${1 / Math.max(z, 0.35)});transform-origin:0 100%">#${it.id}</div>`;
    }).join('');
    const frame = (inner, h, cls) => `<div class="frame-box" style="width:${W * z}px;height:${h * z}px"><div class="frame ${V.boxes ? '' : 'noboxes'} ${cls || ''}" style="width:${W}px;height:${h}px;transform:scale(${z})">${inner}</div></div>`;
    if (V.mode === 'side') {
      stage.innerHTML = `
        <div class="col"><h4><i style="background:var(--design)"></i>Design</h4>${frame(designHtml + boxesFor('e'), Hd)}</div>
        <div class="col"><h4><i style="background:var(--site)"></i>Site</h4>${frame(shotsHtml + boxesFor('a'), Ha)}</div>`;
    } else {
      const blend = V.mode === 'diff' ? 'mix-blend-mode:difference;opacity:1' : `opacity:${V.opacity}`;
      const overlay = `<div style="position:absolute;inset:0;${blend};pointer-events:none">${designHtml}</div>`;
      stage.innerHTML = `<div class="col"><h4><i style="background:var(--site)"></i>Site${V.mode === 'diff' ? ' ⊖ design' : ' + design'}</h4>${frame(`<div style="position:absolute;inset:0;isolation:isolate">${shotsHtml}${overlay}</div>` + boxesFor('e') + boxesFor('a'), H)}</div>`;
    }
    $('opWrap').style.display = V.mode === 'overlay' ? 'flex' : 'none';
  }

  function renderAll() {
    renderHeader();
    renderStats();
    renderList();
    renderStage();
  }

  function select(id, scrollList) {
    V.sel = id;
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
    document.querySelectorAll('.bx').forEach((b) => b.classList.toggle('sel', b.dataset.id === id));
    const e = V.bps[V.cur];
    const it = e && e.rep && e.rep.issues.find((i) => i.id === id);
    if (!it) return;
    const r = it.actual || it.expected;
    const wrap = $('stageWrap');
    const oy = e.rep.scope && e.crop ? e.rep.scope.crop.site.y : 0;
    wrap.scrollTo({ top: Math.max(0, (r.y - oy) * stageZoom - wrap.clientHeight / 3), behavior: 'smooth' });
    if (scrollList) {
      const card = document.querySelector(`.card[data-id="${id}"]`);
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ---------- events ----------

  $('tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tab');
    if (!b) return;
    V.cur = +b.dataset.i;
    V.sel = null;
    renderAll();
  });
  $('list').addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-copy]');
    if (c) { ev.stopPropagation(); copy(c.dataset.copy, c.dataset.what || 'Selector'); return; }
    const card = ev.target.closest('.card');
    if (card) select(card.dataset.id, false);
  });
  $('stage').addEventListener('click', (ev) => {
    const b = ev.target.closest('.bx');
    if (b) select(b.dataset.id, true);
  });
  $('viewMode').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    V.mode = b.dataset.v;
    [...$('viewMode').children].forEach((x) => x.classList.toggle('on', x === b));
    renderStage();
  });
  $('zoom').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    V.zoom = b.dataset.z;
    [...$('zoom').children].forEach((x) => x.classList.toggle('on', x === b));
    renderStage();
  });
  $('opacity').addEventListener('input', (ev) => {
    V.opacity = ev.target.value / 100;
    $('opVal').textContent = ev.target.value + '%';
    renderStage();
  });
  $('boxes').addEventListener('change', (ev) => { V.boxes = ev.target.checked; renderStage(); });
  $('sevFilters').addEventListener('click', (ev) => {
    const b = ev.target.closest('.fchip');
    if (!b) return;
    const s = b.dataset.sev;
    if (V.sev.has(s)) V.sev.delete(s); else V.sev.add(s);
    b.classList.toggle('on', V.sev.has(s));
    renderList();
    renderStage();
  });
  $('search').addEventListener('input', (ev) => { V.q = ev.target.value; renderList(); renderStage(); });
  $('copyJson').addEventListener('click', () => {
    const e = V.bps[V.cur];
    if (!e || !e.rep) return toast('Nothing to copy yet', true);
    copy(JSON.stringify(agentJson([e]), null, 2), 'JSON');
  });
  $('copyPrompt').addEventListener('click', () => {
    const all = V.bps.filter((x) => x.rep);
    if (!all.length) return toast('Nothing to copy yet', true);
    copy(agentPrompt(all), 'Agent prompt');
  });
  $('dlJson').addEventListener('click', async () => {
    const all = V.bps.filter((x) => x.rep);
    if (!all.length) return toast('Nothing to download yet', true);
    await download(agentJson(all), `${V.settings.folder}/latest.json`);
    toast(`Saved to Downloads/${V.settings.folder}/latest.json`);
  });
  $('rerun').addEventListener('click', async () => {
    if (!TAB_ID) return;
    const proj = await store.get('proj:' + KEY);
    const bps = V.bps.map((x) => (proj && proj.breakpoints.find((b) => b.id === x.bp.id)) || x.bp);
    const active = proj && proj.breakpoints.find((b) => b.id === proj.activeId);
    progress(true, 'Capturing the page again…', 0, 'Keep the page tab open');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'parity:analyze', tabId: TAB_ID, key: KEY,
        bps: bps.map((b) => {
          const sc = V.bps[0] && V.bps[0].cap && V.bps[0].cap.scope;
          const sec = sc && b.sections ? b.sections[sc.selector] : null;
          return { id: b.id, name: b.name, width: b.width, vh: b.vh, scale: b.scale, offsetX: b.offsetX || 0, offsetY: b.offsetY || 0, imgId: b.imgId, imgW: b.imgW, imgH: b.imgH, file: b.file, sectionImgId: sec ? sec.imgId : undefined, sectionFile: sec ? sec.file : undefined };
        }),
        viewport: { match: !!(proj && proj.viewport.match), bp: active ? { width: active.width, vh: active.vh, mode: proj.viewport.mode } : null },
        scope: (V.bps[0] && V.bps[0].cap && V.bps[0].cap.scope) ? { selector: V.bps[0].cap.scope.selector, label: V.bps[0].cap.scope.label } : null,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Capture failed');
    } catch (err) {
      progress(false);
      toast(err.message, true);
    }
  });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderStage, 120); });
  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    const items = filtered();
    if (!items.length) return;
    if (ev.key === 'j' || ev.key === 'ArrowDown' || ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const i = items.findIndex((x) => x.id === V.sel);
      const n = ev.key === 'j' || ev.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      select(items[n].id, true);
    }
  });

  // ---------- boot ----------

  async function boot() {
    if (!KEY) { $('pageTitle').textContent = 'No report selected'; return; }
    V.proj = await store.get('proj:' + KEY);
    V.settings = { ...V.settings, ...((await store.get('parity:settings')) || {}) };
    const ids = BP_IDS.length ? BP_IDS : (V.proj ? V.proj.breakpoints.map((b) => b.id) : []);
    for (const id of ids) {
      const cap = await store.get(`cap:${KEY}:${id}${SK}`);
      const rep = await store.get(`rep:${KEY}:${id}${SK}`);
      const crop = SK ? await store.get(`crop:${KEY}:${id}${SK}`) : null;
      const bp = (V.proj && V.proj.breakpoints.find((b) => b.id === id)) || (cap && cap.bp);
      if (!bp) continue;
      const designData = await store.get('img:' + ((cap && cap.bp && cap.bp.imgId) || bp.imgId));
      const toUrl = async (d) => (d ? URL.createObjectURL(await (await fetch(d)).blob()) : '');
      const designUrl = await toUrl(designData);
      const shotUrls = cap ? await Promise.all(cap.shots.map((s) => toUrl(s.data))) : [];
      V.bps.push({ bp, cap, rep: rep && cap && rep.capId === cap.id ? rep : null, crop, designUrl, shotUrls, status: '' });
    }
    V.bps.sort((a, b) => a.bp.width - b.bp.width);
    if (!V.bps.length) { $('pageTitle').textContent = 'Nothing captured yet'; return; }
    renderAll();
    const todo = V.bps.filter((e) => e.cap && !e.rep);
    const fresh = [];
    for (let k = 0; k < todo.length; k++) {
      const e = todo[k];
      e.status = 'busy';
      renderHeader();
      try {
        e.rep = await analyzeEntry(e, k, todo.length);
        fresh.push(e);
      } catch (err) {
        console.error(err);
        e.error = 'Analysis failed: ' + err.message;
      }
      e.status = '';
      if (V.bps.indexOf(e) === V.cur) renderAll(); else renderHeader();
    }
    progress(false);
    renderAll();
    if (fresh.length) autoSave(fresh);
  }
  boot();
})();
