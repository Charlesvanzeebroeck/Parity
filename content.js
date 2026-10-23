/* Parity — in-page panel and design overlay. The live editor lives in editor.js (ParityEditor). */
(function () {
  if (window.__parityContent) return;
  window.__parityContent = true;

  const Z = 2147483646;
  const { SETTINGS_KEY, DEFAULT_SETTINGS, segmentsOf } = globalThis.ParityShared;
  const Ed = globalThis.ParityEditor;
  const Pg = globalThis.ParityPage;
  const defaultProject = () => ({
    v: 3,
    breakpoints: [],
    activeId: null,
    overlay: { visible: true, opacity: 0.5, mode: 'normal', invert: false, align: 'left', splitX: 0.5 },
    viewport: { match: true, mode: 'emulate' },
    freeze: false,
    panel: { x: null, y: 16, collapsed: false, tab: 'edit' },
  });

  const S = { key: projectKey(), proj: null, settings: { ...DEFAULT_SETTINGS }, open: false, bitmaps: new Map(), editing: false, showSettings: false, addOpen: false };

  function projectKey() { return location.origin + location.pathname; }

  // ---------- storage ----------

  const store = {
    get: (k) => chrome.storage.local.get(k).then((r) => r[k]),
    set: (k, v) => chrome.storage.local.set({ [k]: v }),
    del: (k) => chrome.storage.local.remove(k),
  };
  let saveT = null;
  function saveProject() {
    clearTimeout(saveT);
    saveT = setTimeout(() => store.set('proj:' + S.key, S.proj), 150);
  }
  async function loadProject() {
    const p = await store.get('proj:' + S.key);
    const d = defaultProject();
    S.proj = p ? { ...d, ...p, overlay: { ...d.overlay, ...(p.overlay || {}) }, viewport: { ...d.viewport, ...(p.viewport || {}) }, panel: { ...d.panel, ...(p.panel || {}) } } : d;
    if (!['edit', 'overlay'].includes(S.proj.panel.tab)) S.proj.panel.tab = 'edit';
    S.settings = { ...DEFAULT_SETTINGS, ...((await store.get(SETTINGS_KEY)) || {}) };
  }
  const activeBp = () => S.proj && S.proj.breakpoints.find((b) => b.id === S.proj.activeId);
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- images ----------

  function dataUrlToBlob(url) {
    const i = url.indexOf(',');
    const mime = (url.slice(0, i).match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(url.slice(i + 1));
    const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: mime });
  }
  async function getBitmap(bp) {
    if (!bp || !bp.imgId) return null;
    if (S.bitmaps.has(bp.imgId)) return S.bitmaps.get(bp.imgId);
    const url = await store.get('img:' + bp.imgId);
    if (!url) return null;
    const bmp = await createImageBitmap(dataUrlToBlob(url));
    S.bitmaps.set(bp.imgId, bmp);
    return bmp;
  }
  function readFile(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  const COMMON = [320, 360, 375, 390, 393, 402, 414, 428, 430, 440, 744, 768, 800, 810, 820, 834, 1024, 1080, 1194, 1280, 1366, 1440, 1512, 1536, 1600, 1680, 1728, 1920, 2560];
  function guessWidth(name, w) {
    const nums = (name.match(/\d{3,4}/g) || []).map(Number).filter((n) => n >= 280 && n <= 3000);
    for (const n of nums) for (const s of [1, 2, 3, 4]) if (Math.abs(w / s - n) <= 2) return { width: n, scale: s };
    for (const s of [1, 2, 3]) for (const c of COMMON) if (Math.abs(w / s - c) <= 1) return { width: c, scale: s };
    return w > 2200 ? { width: Math.round(w / 2), scale: 2 } : { width: w, scale: 1 };
  }
  const labelFor = (w) => (w <= 480 ? 'Mobile' : w <= 1024 ? 'Tablet' : 'Desktop');

  async function addFiles(files) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return toast('Drop JPEG or PNG exports');
    let last = null;
    for (const f of imgs) {
      const url = await readFile(f);
      const bmp = await createImageBitmap(f);
      const g = guessWidth(f.name || '', bmp.width);
      const imgId = uid();
      await store.set('img:' + imgId, url);
      S.bitmaps.set(imgId, bmp);
      let bp = S.proj.breakpoints.find((b) => b.width === g.width);
      if (bp) {
        if (bp.imgId) { store.del('img:' + bp.imgId); S.bitmaps.delete(bp.imgId); }
        Object.assign(bp, { imgId, imgW: bmp.width, imgH: bmp.height, scale: g.scale, file: f.name || 'pasted image' });
        toast(`Updated the ${g.width}px design (edits kept)`);
      } else {
        bp = { id: uid(), name: labelFor(g.width), width: g.width, scale: g.scale, vh: null, offsetX: 0, offsetY: 0, imgId, imgW: bmp.width, imgH: bmp.height, file: f.name || 'pasted image', edits: [] };
        S.proj.breakpoints.push(bp);
      }
      last = bp;
    }
    S.proj.breakpoints.sort((a, b) => a.width - b.width);
    S.addOpen = false;
    saveProject();
    drawnFor = null;
    if (last) await setActive(last.id);
    else render();
  }

  // a breakpoint without a design, at the current width (edit without a mockup)
  async function addLiveBp() {
    const w = document.documentElement.clientWidth;
    let bp = S.proj.breakpoints.find((b) => b.width === w);
    if (!bp) {
      bp = { id: uid(), name: labelFor(w), width: w, scale: 1, vh: null, offsetX: 0, offsetY: 0, imgId: null, file: null, edits: [] };
      S.proj.breakpoints.push(bp);
      S.proj.breakpoints.sort((a, b) => a.width - b.width);
    }
    S.addOpen = false;
    saveProject();
    await setActive(bp.id);
  }

  async function replaceImage(bp, file) {
    const url = await readFile(file);
    const bmp = await createImageBitmap(file);
    if (bp.imgId) { store.del('img:' + bp.imgId); S.bitmaps.delete(bp.imgId); }
    const imgId = uid();
    await store.set('img:' + imgId, url);
    S.bitmaps.set(imgId, bmp);
    const g = guessWidth(file.name || '', bmp.width);
    Object.assign(bp, { imgId, imgW: bmp.width, imgH: bmp.height, file: file.name });
    if (!bp.scale || Math.abs(bmp.width / bp.scale - bp.width) > 2) bp.scale = g.width === bp.width ? g.scale : Math.max(1, Math.round(bmp.width / bp.width));
    saveProject();
    drawnFor = null;
    toast('Design image replaced');
    render();
    renderOverlay();
  }

  async function removeBp(id) {
    const bp = S.proj.breakpoints.find((b) => b.id === id);
    if (!bp) return;
    if (bp.imgId) { store.del('img:' + bp.imgId); S.bitmaps.delete(bp.imgId); }
    S.proj.breakpoints = S.proj.breakpoints.filter((b) => b.id !== id);
    if (S.proj.activeId === id) S.proj.activeId = S.proj.breakpoints[0] ? S.proj.breakpoints[0].id : null;
    saveProject();
    await setActive(S.proj.activeId);
  }

  async function setActive(id) {
    S.proj.activeId = id;
    S.editing = false;
    MV.sel = 0;
    const nb = activeBp();
    if (nb && nb.locked) stopMove();
    saveProject();
    Ed.refresh();
    render();
    await renderOverlay();
    applyViewport();
  }

  // ---------- viewport ----------

  let vpToken = 0;
  async function applyViewport() {
    const bp = activeBp();
    const my = ++vpToken;
    if (!S.open || !bp || !S.proj.viewport.match) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'parity:viewport', width: bp.width, vh: bp.vh, mode: S.proj.viewport.mode });
      if (my !== vpToken) return;
      if (r && !r.ok) toast(r.error, true);
      else if (r && r.mode === 'window' && r.achieved && Math.abs(r.achieved - bp.width) > 1) toast(`Window reached ${r.achieved}px — use Exact mode for ${bp.width}px`);
    } catch (e) { toast(String(e.message || e), true); }
    setTimeout(() => { renderOverlay(); Ed.onScroll(); }, 120);
  }

  // ---------- hosts ----------

  let overlayHost, overlayRoot, panelHost, panelRoot, guidesHost, guidesRoot, splitEl;
  const allHosts = () => [overlayHost, guidesHost, panelHost];

  function mkHost(id, fixed) {
    const h = document.createElement('parity-' + id);
    h.setAttribute('data-parity', '');
    h.style.cssText = `all:initial;position:${fixed ? 'fixed' : 'absolute'};left:0;top:0;z-index:${Z};pointer-events:none;display:block;`;
    return h;
  }

  function ensureHosts() {
    if (!overlayHost) {
      overlayHost = mkHost('overlay', false);
      overlayRoot = overlayHost.attachShadow({ mode: 'open' });
      overlayHost.addEventListener('pointerdown', mvDown);
      overlayHost.addEventListener('dblclick', mvDblClick);
      overlayHost.addEventListener('pointermove', mvHover);
    }
    if (!guidesHost) {
      guidesHost = mkHost('guides', false);
      guidesRoot = guidesHost.attachShadow({ mode: 'open' });
      guidesRoot.addEventListener('click', onGuideClick);
    }
    if (!panelHost) {
      panelHost = mkHost('panel', true);
      panelHost.style.zIndex = Z + 1;
      panelHost.style.width = '0';
      panelHost.style.height = '0';
      panelRoot = panelHost.attachShadow({ mode: 'open' });
      buildPanel();
    }
    for (const h of allHosts()) if (!h.isConnected) document.documentElement.appendChild(h);
  }
  const keeper = new MutationObserver(() => {
    if (S.open && allHosts().some((h) => h && !h.isConnected)) ensureHosts();
  });
  function removeHosts() { for (const h of allHosts()) if (h) h.remove(); }

  // ---------- overlay ----------

  function segDy(bp, i) { return i === 0 ? bp.offsetY || 0 : bp.slices[i - 1].dy || 0; }
  function setSegDy(bp, i, v) { if (i === 0) bp.offsetY = Math.round(v); else bp.slices[i - 1].dy = Math.round(v); }
  function shiftAll(bp, d) {
    bp.offsetY = (bp.offsetY || 0) + d;
    for (const c of bp.slices || []) c.dy = (c.dy || 0) + d;
  }

  // last layout: {left, top, cssW, cssH, segs}
  const OV = { left: 0, top: 0, cssW: 0, cssH: 0, segs: [] };
  let drawnFor = null;
  async function renderOverlay() {
    if (!S.open || !overlayHost) return;
    const bp = activeBp();
    const o = S.proj.overlay;
    if (!bp || !o.visible) { overlayHost.style.display = 'none'; updateSplit(); renderGuides(); return; }
    const bmp = await getBitmap(bp);
    if (!bmp) { overlayHost.style.display = 'none'; updateSplit(); renderGuides(); return; }
    const cssW = bp.width;
    const cssH = Math.round((bmp.height * cssW) / bmp.width);
    if (bp.slices) {
      const ok = bp.slices.filter((c, i, a) => c.y > 0 && c.y < cssH && (i === 0 || c.y > a[i - 1].y));
      if (ok.length !== bp.slices.length) { bp.slices = ok; if (!ok.length) delete bp.slices; saveProject(); }
    }
    const segs = segmentsOf(bp, cssH);
    const sig = bp.imgId + ':' + cssW + ':' + segs.map((g) => g.y0).join(',');
    if (drawnFor !== sig) {
      const dpr = window.devicePixelRatio || 1;
      const s = Math.min(dpr, 16000 / cssW, Math.sqrt(24e6 / (cssW * cssH)), bmp.width / cssW);
      const k = bmp.width / cssW;
      overlayRoot.innerHTML = '<style>canvas{position:absolute;left:0;display:block;width:100%}</style>';
      for (const g of segs) {
        const c = document.createElement('canvas');
        const h = g.y1 - g.y0;
        c.width = Math.max(1, Math.round(cssW * s));
        c.height = Math.max(1, Math.min(16000, Math.round(h * s)));
        c.style.height = h + 'px';
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, g.y0 * k, bmp.width, h * k, 0, 0, c.width, c.height);
        overlayRoot.appendChild(c);
      }
      drawnFor = sig;
    }
    const docW = document.documentElement.clientWidth;
    const left = (o.align === 'center' ? Math.round((docW - cssW) / 2) : 0) + (bp.offsetX || 0);
    Object.assign(OV, { left, top: 0, cssW, cssH });
    const st = overlayHost.style;
    st.display = 'block';
    st.opacity = o.mode === 'difference' ? '1' : String(o.opacity);
    st.mixBlendMode = o.mode === 'difference' ? 'difference' : 'normal';
    st.filter = o.invert ? 'invert(1)' : 'none';
    layoutOverlay();
  }

  // position the band canvases from the current offsets (cheap: no redraw — used while dragging)
  function layoutOverlay() {
    const bp = activeBp();
    if (!bp || !overlayRoot || overlayHost.style.display === 'none') return;
    const segs = segmentsOf(bp, OV.cssH);
    OV.segs = segs;
    const minY = Math.min(...segs.map((g) => g.y0 + g.dy));
    const maxY = Math.max(...segs.map((g) => g.y1 + g.dy));
    const st = overlayHost.style;
    st.left = OV.left + 'px';
    st.top = OV.top + minY + 'px';
    st.width = OV.cssW + 'px';
    st.height = maxY - minY + 'px';
    const cs = overlayRoot.querySelectorAll('canvas');
    segs.forEach((g, i) => { if (cs[i]) cs[i].style.top = g.y0 + g.dy - minY + 'px'; });
    st.pointerEvents = MV.on ? 'auto' : 'none';
    st.cursor = MV.on ? (MV.drag ? 'grabbing' : 'ns-resize') : '';
    applyClip();
    updateSplit();
    renderGuides();
  }

  function applyClip() {
    if (!overlayHost) return;
    const o = S.proj.overlay;
    if (o.mode !== 'split') { overlayHost.style.clipPath = 'none'; return; }
    const hostLeft = parseFloat(overlayHost.style.left) || 0;
    const w = parseFloat(overlayHost.style.width) || 0;
    const xDoc = o.splitX * window.innerWidth + window.scrollX - hostLeft;
    overlayHost.style.clipPath = `inset(0 ${Math.max(0, w - xDoc)}px 0 0)`;
    overlayHost.style.opacity = '1';
  }

  function updateSplit() {
    if (!splitEl) return;
    const bp = activeBp();
    const on = S.open && S.proj.overlay.mode === 'split' && S.proj.overlay.visible && bp && bp.imgId;
    splitEl.style.display = on ? 'block' : 'none';
    if (on) splitEl.style.left = S.proj.overlay.splitX * window.innerWidth + 'px';
  }

  // ---------- move mode: drag the design vertically, cut it into bands, lock it ----------

  const MV = { on: false, sel: 0, drag: null, last: null, auto: 0, raf: 0, hoverY: null };
  const pageYOf = (e) => e.clientY + window.scrollY;

  function segAt(pageY) {
    const segs = OV.segs;
    for (let i = segs.length - 1; i >= 0; i--) {
      const t = OV.top + segs[i].y0 + segs[i].dy;
      if (pageY >= t && pageY < t + segs[i].y1 - segs[i].y0) return i;
    }
    let best = 0, bd = Infinity;
    segs.forEach((g, i) => {
      const t = OV.top + g.y0 + g.dy, b = t + g.y1 - g.y0;
      const d = pageY < t ? t - pageY : pageY - b;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  function startMove() {
    const bp = activeBp();
    if (!bp || !S.open || !bp.imgId) return;
    if (bp.locked) { toast('Overlay is locked — press L or click the padlock to unlock', true); return; }
    Ed.setMode(false);
    MV.on = true;
    MV.sel = Math.min(MV.sel, (bp.slices || []).length);
    if (!S.proj.overlay.visible) S.proj.overlay.visible = true;
    render();
    renderOverlay();
    Ed.onScroll();
  }
  function stopMove() {
    if (!MV.on) return;
    MV.on = false;
    MV.drag = null;
    MV.hoverY = null;
    cancelAnimationFrame(MV.raf);
    if (S.open) { render(); layoutOverlay(); Ed.onScroll(); }
  }
  const toggleMove = () => (MV.on ? stopMove() : startMove());

  function toggleLock() {
    const bp = activeBp();
    if (!bp) return;
    bp.locked = !bp.locked;
    if (bp.locked) stopMove();
    saveProject();
    render();
    toast(bp.locked ? `Overlay position locked for ${bp.width}px` : 'Overlay unlocked — M to move it');
  }

  function addCut(pageY) {
    const bp = activeBp();
    const i = segAt(pageY);
    const g = OV.segs[i];
    const y = Math.round(pageY - OV.top - g.dy);
    if (y <= g.y0 + 4 || y >= g.y1 - 4) return;
    bp.slices = (bp.slices || []).concat({ y, dy: g.dy }).sort((a, b) => a.y - b.y);
    MV.sel = bp.slices.findIndex((c) => c.y === y) + 1;
    drawnFor = null;
    saveProject();
    renderOverlay();
    render();
    toast(`Cut at ${y}px — drag the part below to line it up`);
  }
  function removeCut(ci) {
    const bp = activeBp();
    if (!bp || !bp.slices || !bp.slices[ci]) return;
    bp.slices.splice(ci, 1);
    if (!bp.slices.length) delete bp.slices;
    MV.sel = Math.max(0, Math.min(MV.sel > ci ? MV.sel - 1 : MV.sel, (bp.slices || []).length));
    drawnFor = null;
    saveProject();
    renderOverlay();
    render();
  }
  function resetOffsets() {
    const bp = activeBp();
    if (!bp) return;
    bp.offsetY = 0;
    delete bp.slices;
    MV.sel = 0;
    drawnFor = null;
    saveProject();
    renderOverlay();
    render();
    toast('Vertical offset and cuts cleared');
  }

  function snapDy(bp, i, v) {
    const targets = [0];
    if (i > 0) targets.push(segDy(bp, i - 1));
    for (const t of targets) if (Math.abs(v - t) <= 4) return t;
    return v;
  }

  function mvApply() {
    const D = MV.drag, bp = activeBp();
    if (!D || !bp) return;
    const d = Math.round(D.lastClientY + window.scrollY - D.startY);
    if (D.all) {
      bp.offsetY = D.orig[0] + d;
      (bp.slices || []).forEach((c, k) => { c.dy = D.orig[k + 1] + d; });
    } else setSegDy(bp, D.i, D.alt ? D.orig + d : snapDy(bp, D.i, D.orig + d));
    layoutOverlay();
  }

  function mvDown(e) {
    if (!MV.on || e.button !== 0) return;
    const bp = activeBp();
    if (!bp) return;
    e.preventDefault();
    e.stopPropagation();
    const y = pageYOf(e);
    const now = performance.now();
    if (MV.last && now - MV.last.t < 350 && Math.abs(MV.last.y - y) < 5) { MV.last = null; addCut(y); return; }
    MV.last = { t: now, y };
    const i = segAt(y);
    MV.sel = i;
    MV.drag = {
      i, all: e.shiftKey, alt: e.altKey, startY: y, lastClientY: e.clientY,
      orig: e.shiftKey ? [bp.offsetY || 0, ...(bp.slices || []).map((c) => c.dy || 0)] : segDy(bp, i),
    };
    overlayHost.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!MV.drag) return;
      MV.drag.lastClientY = ev.clientY;
      MV.drag.alt = ev.altKey;
      if (Math.abs(pageYOf(ev) - MV.drag.startY) > 2) MV.last = null;
      const edge = 48, vh = window.innerHeight;
      MV.auto = ev.clientY < edge ? -Math.ceil((edge - ev.clientY) / 3) : ev.clientY > vh - edge ? Math.ceil((ev.clientY - vh + edge) / 3) : 0;
      mvApply();
    };
    const tick = () => {
      if (!MV.drag) return;
      if (MV.auto) { window.scrollBy(0, MV.auto); mvApply(); }
      MV.raf = requestAnimationFrame(tick);
    };
    MV.raf = requestAnimationFrame(tick);
    const up = () => {
      overlayHost.removeEventListener('pointermove', move);
      overlayHost.removeEventListener('pointerup', up);
      overlayHost.removeEventListener('pointercancel', up);
      cancelAnimationFrame(MV.raf);
      MV.auto = 0;
      MV.drag = null;
      saveProject();
      layoutOverlay();
      render();
    };
    overlayHost.addEventListener('pointermove', move);
    overlayHost.addEventListener('pointerup', up);
    overlayHost.addEventListener('pointercancel', up);
    layoutOverlay();
  }
  function mvDblClick(e) { if (MV.on) { e.preventDefault(); e.stopPropagation(); } }
  function mvHover(e) {
    if (!MV.on || MV.drag) return;
    MV.hoverY = pageYOf(e);
    const h = guidesRoot && guidesRoot.querySelector('.hov');
    if (h) { h.style.top = MV.hoverY + 'px'; h.style.display = 'block'; }
  }

  function nudgeSel(d) {
    const bp = activeBp();
    if (!bp) return;
    const i = Math.min(MV.sel, (bp.slices || []).length);
    setSegDy(bp, i, segDy(bp, i) + d);
    saveProject();
    layoutOverlay();
    render();
  }

  const fmtD = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + 'px';
  function renderGuides() {
    if (!guidesRoot) return;
    const bp = activeBp();
    const on = MV.on && bp && S.open && overlayHost && overlayHost.style.display !== 'none';
    guidesHost.style.display = on ? 'block' : 'none';
    if (!on) { guidesRoot.innerHTML = ''; return; }
    const L = OV.left, W = OV.cssW;
    let html = `<style>
      .cut{position:absolute;height:0;border-top:2px dashed #c8ff3d;pointer-events:none;filter:drop-shadow(0 0 1px rgba(0,0,0,.6))}
      .tag{position:absolute;left:8px;top:-11px;display:flex;align-items:center;gap:6px;padding:2px 4px 2px 8px;border-radius:20px;background:#111214;color:#e9e9ec;border:1px solid rgba(200,255,61,.5);font:600 10.5px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;pointer-events:auto;box-shadow:0 4px 12px rgba(0,0,0,.35)}
      .tag b{color:#c8ff3d;font-weight:700}
      .tag button{all:unset;cursor:pointer;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;color:#8b8d94;font-size:12px;line-height:1}
      .tag button:hover{background:rgba(255,92,116,.2);color:#ff5c74}
      .sel{position:absolute;box-sizing:border-box;border:1.5px solid #c8ff3d;background:rgba(200,255,61,.05);pointer-events:none}
      .sel span{position:absolute;left:8px;top:16px;padding:2px 7px;border-radius:5px;background:#c8ff3d;color:#111;font:700 11px ui-monospace,Menlo,monospace}
      .hov{position:absolute;height:0;border-top:1px dashed rgba(200,255,61,.55);pointer-events:none;display:none}
      .hov i{position:absolute;right:8px;top:-17px;font:600 10px ui-monospace,Menlo,monospace;color:#c8ff3d;background:rgba(17,18,20,.85);padding:1px 6px;border-radius:4px;font-style:normal}
    </style>`;
    const segs = OV.segs;
    const sel = Math.min(MV.sel, segs.length - 1);
    const sg = segs[sel];
    if (sg) {
      const t = OV.top + sg.y0 + sg.dy;
      const rel = sel > 0 ? sg.dy - segs[sel - 1].dy : null;
      html += `<div class="sel" style="left:${L}px;top:${t}px;width:${W}px;height:${sg.y1 - sg.y0}px"><span>${segs.length > 1 ? `band ${sel + 1}/${segs.length} · ` : ''}↕ ${fmtD(sg.dy)}${rel ? ` (${fmtD(rel)} vs above)` : ''}</span></div>`;
    }
    segs.forEach((g, i) => {
      if (i === 0) return;
      const t = OV.top + g.y0 + g.dy;
      const rel = g.dy - segs[i - 1].dy;
      html += `<div class="cut" style="left:${L}px;top:${t}px;width:${W}px"><div class="tag">✂ <span>cut @${g.y0}</span><b>${fmtD(rel)}</b><button data-cut="${i - 1}" title="Remove this cut">×</button></div></div>`;
    });
    html += `<div class="hov" style="left:${L}px;width:${W}px${MV.hoverY != null ? `;top:${MV.hoverY}px;display:block` : ''}"><i>double-click to cut here</i></div>`;
    guidesRoot.innerHTML = html;
  }
  function onGuideClick(e) {
    const b = e.target.closest && e.target.closest('[data-cut]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    removeCut(+b.dataset.cut);
  }

  // ---------- panel ----------

  const ICON = {
    eye: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>',
    eyeOff: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l12 12M6.5 3.3A7 7 0 0 1 8 3c4.5 0 7 5 7 5a12 12 0 0 1-2 2.6M4 4.9A12 12 0 0 0 1 8s2.5 5 7 5a7 7 0 0 0 3-.7"/></svg>',
    trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>',
    gear: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
    min: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h8"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    cursor: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.5l9.5 5-4.2 1.2L6.5 13z"/></svg>',
    move: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5v13M5 4.5l3-3 3 3M5 11.5l3 3 3-3M3 8h10"/></svg>',
    lock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
    unlock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/></svg>',
    replace: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.6M13.5 8a5.5 5.5 0 0 1-9.6 3.6M12.5 2v3h-3M3.5 14v-3h3"/></svg>',
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .panel{position:fixed;width:312px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;pointer-events:auto;
    background:rgba(13,14,16,.97);color:#e9e9ec;border:1px solid rgba(255,255,255,.08);border-radius:16px;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.25);backdrop-filter:blur(12px);
    font:12px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;overflow:hidden}
  .panel.drop-on{outline:2px solid #c8ff3d;outline-offset:-2px}
  .head{display:flex;align-items:center;justify-content:space-between;padding:10px 8px 10px 14px;cursor:grab;border-bottom:1px solid rgba(255,255,255,.06)}
  .head:active{cursor:grabbing}
  .brand{display:flex;align-items:center;gap:8px;font-weight:650;letter-spacing:.01em;font-size:12.5px}
  .mark{width:16px;height:16px;border-radius:5px;background:linear-gradient(90deg,#c8ff3d 50%,#3a3d44 50%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
  .hbtns{display:flex;gap:2px}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
  button[disabled]{opacity:.45;cursor:default}
  .icon{width:26px;height:24px;display:grid;place-items:center;border-radius:7px;color:#a3a5ad}
  .icon:hover{background:rgba(255,255,255,.07);color:#fff}
  .icon.on{color:#c8ff3d}
  .body{overflow:auto;padding:4px 0 6px}
  .row{display:flex;align-items:center;gap:8px}
  .lab{color:#8b8d94;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
  .link{color:#c8ff3d;font-weight:600;font-size:11.5px}
  .link:hover{text-decoration:underline}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{display:flex;flex-direction:column;align-items:flex-start;padding:5px 9px 4px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);min-width:0;text-align:left;position:relative}
  .chip b{font:650 13px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.01em}
  .chip span{font-size:9.5px;color:#8b8d94;margin-top:2px}
  .chip:hover{border-color:rgba(255,255,255,.18)}
  .chip.on{background:#c8ff3d;border-color:#c8ff3d;color:#111}
  .chip.on span{color:rgba(0,0,0,.6)}
  .chip em{position:absolute;right:-5px;top:-6px;font:700 9px/14px ui-monospace,Menlo,monospace;font-style:normal;min-width:14px;padding:0 3px;border-radius:7px;background:#ff3d8b;color:#fff;text-align:center}
  .chips .icon{width:30px;height:auto;align-self:stretch;border-radius:9px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.12);font-size:15px;color:#a3a5ad}
  .chips .icon:hover,.chips .icon.on{border-color:#c8ff3d;color:#c8ff3d}
  .bprow{display:flex;align-items:center;gap:6px;padding:10px 12px 0}
  .bpmeta{display:flex;align-items:center;gap:6px;padding:6px 12px 0;color:#6f7179;font-size:10.5px}
  .bpmeta .link{font-size:10.5px;font-weight:500;color:#8b8d94;margin-left:auto}
  .bpmeta .link:hover{color:#c8ff3d}
  .box{margin:8px 12px 0;padding:10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}
  .drop{border:1.5px dashed rgba(255,255,255,.14);border-radius:10px;padding:16px 10px;text-align:center;color:#a3a5ad;cursor:pointer}
  .drop:hover{border-color:#c8ff3d;color:#fff}
  .drop small{display:block;color:#6f7179;margin-top:4px;font-size:10.5px}
  .form{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
  .form label{display:flex;flex-direction:column;gap:3px;color:#8b8d94;font-size:10.5px}
  .form input,.form select,.set input{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 7px;width:100%;outline:none}
  .form input:focus,.set input:focus{border-color:#c8ff3d}
  .form .acts{grid-column:1/-1;display:flex;gap:6px;justify-content:space-between}
  .btn{padding:6px 10px;border-radius:8px;background:rgba(255,255,255,.07);font-weight:600}
  .btn:hover{background:rgba(255,255,255,.12)}
  .btn.pri{background:#c8ff3d;color:#111}
  .btn.pri:hover{background:#d6ff6b}
  input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:4px;border-radius:4px;background:linear-gradient(90deg,#c8ff3d var(--p),rgba(255,255,255,.12) var(--p));outline:none}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer}
  .val{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9cad0;width:34px;text-align:right}
  .seg{display:flex;margin-top:8px;padding:2px;border-radius:9px;background:rgba(255,255,255,.05)}
  .seg button{flex:1;padding:5px 4px;border-radius:7px;color:#a3a5ad;font-weight:600;font-size:11.5px}
  .seg button:hover{color:#fff}
  .seg button.on{background:rgba(255,255,255,.12);color:#fff}
  .sw{display:flex;align-items:center;justify-content:space-between;cursor:pointer;color:#d6d7db}
  .tg{position:relative;width:28px;height:16px;border-radius:9px;background:rgba(255,255,255,.14);transition:background .15s}
  .tg::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}
  .tg.on{background:#c8ff3d}
  .tg.on::after{transform:translateX(12px);background:#111}
  kbd{font:600 9.5px ui-monospace,Menlo,monospace;padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.14)}
  .toast{position:absolute;left:10px;right:10px;bottom:10px;padding:8px 10px;border-radius:9px;background:#26282d;color:#fff;font-size:11.5px;box-shadow:0 6px 20px rgba(0,0,0,.4);opacity:0;transform:translateY(6px);transition:all .18s;pointer-events:none;z-index:2}
  .toast.on{opacity:1;transform:none}
  .toast.err{background:#4a1520}
  .set{display:grid;grid-template-columns:1fr 110px;gap:8px;align-items:center;color:#d6d7db}
  .set .sw{grid-column:1/-1}
  .hint{color:#6f7179;font-size:10.5px;margin-top:6px;line-height:1.45}
  .hint b{color:#a3a5ad}
  .pillbar{position:fixed;pointer-events:auto;display:flex;align-items:center;gap:8px;padding:7px 10px 7px 9px;border-radius:30px;background:rgba(17,18,20,.96);color:#e9e9ec;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 30px -8px rgba(0,0,0,.5);font:600 12px -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;cursor:pointer}
  .pillbar b{font-family:ui-monospace,Menlo,monospace}
  .pillbar .live{color:#c8ff3d}
  .split{position:fixed;top:0;bottom:0;width:0;pointer-events:none;display:none}
  .split::before{content:"";position:absolute;top:0;bottom:0;left:-1px;width:2px;background:#c8ff3d;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
  .split .knob{position:absolute;top:50%;left:-14px;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:#c8ff3d;pointer-events:auto;cursor:ew-resize;display:grid;place-items:center;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .split .knob::after{content:"";width:10px;height:10px;border-left:2px solid #111;border-right:2px solid #111}
  .split .tagl,.split .tagr{position:absolute;top:12px;font:700 10px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:5px;background:#111;color:#c8ff3d;white-space:nowrap}
  .split .tagl{right:8px}.split .tagr{left:8px;color:#fff}
  .mvrow{display:flex;align-items:center;gap:6px;margin-top:10px}
  .mvb{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:rgba(255,255,255,.07);font-weight:600;font-size:11.5px;color:#d6d7db}
  .mvb:hover{background:rgba(255,255,255,.12);color:#fff}
  .mvb.on{background:#c8ff3d;color:#111}
  .mvb kbd{background:rgba(255,255,255,.08)}
  .mvb.on kbd{background:rgba(0,0,0,.14)}
  .icon.locked{color:#ff9f1a;background:rgba(255,159,26,.12)}
  .mvinfo{margin-left:auto;display:flex;align-items:center;gap:8px;font:600 10.5px ui-monospace,Menlo,monospace;color:#8b8d94;white-space:nowrap}
  .mvbar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:none;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:12px;background:rgba(17,18,20,.96);color:#c9cad0;border:1px solid rgba(200,255,61,.35);box-shadow:0 10px 30px -8px rgba(0,0,0,.6);font:500 11.5px -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;pointer-events:auto;white-space:nowrap}
  .mvbar.on{display:flex}
  .mvbar b{color:#c8ff3d;font-weight:700;letter-spacing:.06em;font-size:10.5px}
  .mvbar kbd{background:rgba(255,255,255,.1);color:#e9e9ec}
  .mvbar button{padding:5px 10px;border-radius:7px;background:#c8ff3d;color:#111;font-weight:700}
  .tabs{display:flex;gap:2px;margin:10px 12px 0;padding:2px;border-radius:9px;background:rgba(255,255,255,.05)}
  .tabs button{flex:1;padding:6px 4px;border-radius:7px;color:#a3a5ad;font-weight:650;font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:6px}
  .tabs button:hover{color:#fff}
  .tabs button.on{background:rgba(255,255,255,.12);color:#fff}
  .tabs .badge{font:700 9.5px ui-monospace,Menlo,monospace;padding:1px 5px;border-radius:10px;background:rgba(200,255,61,.16);color:#c8ff3d}
  .pane{padding:10px 12px 12px}
  .tps{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .tp{padding:4px 9px;border-radius:20px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#a3a5ad;font-size:11px;font-weight:600}
  .tp:hover{color:#fff;border-color:rgba(255,255,255,.2)}
  .tp.on{background:rgba(200,255,61,.13);border-color:rgba(200,255,61,.45);color:#c8ff3d}
  .grp{margin-top:12px}
  .grp:first-child{margin-top:0}
  .grp .lab{display:block;margin-bottom:6px}
  .keys{color:#6f7179;font-size:10.5px;line-height:1.6;margin-top:8px}
  .keys b{color:#a3a5ad;font-weight:600;font-family:ui-monospace,Menlo,monospace}
  ${Ed.CSS}
  `;

  let $panel, $toast, fileInput, replaceTarget = null;

  function buildPanel() {
    panelRoot.innerHTML = `<style>${CSS}</style><div class="panel"></div><div class="split"><span class="tagl">DESIGN</span><span class="tagr">SITE</span><div class="knob"></div></div><div class="mvbar"><b>MOVE DESIGN</b><span>Drag ↕ to slide · <kbd>dbl-click</kbd> cut · <kbd>⇧</kbd> drag all · <kbd>⌥</kbd> no snap · <kbd>↑↓</kbd> nudge · <kbd>[ ]</kbd> band · <kbd>⌫</kbd> remove cut</span><button data-mv="done">Done <kbd>Esc</kbd></button></div>`;
    panelRoot.querySelector('.mvbar').addEventListener('click', (e) => { if (e.target.closest('[data-mv=done]')) stopMove(); });
    $panel = panelRoot.querySelector('.panel');
    splitEl = panelRoot.querySelector('.split');
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    panelRoot.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (replaceTarget && files[0]) {
        const bp = S.proj.breakpoints.find((b) => b.id === replaceTarget);
        replaceTarget = null;
        if (bp) return replaceImage(bp, files[0]);
      }
      addFiles(files);
    });
    $panel.addEventListener('click', onClick);
    $panel.addEventListener('input', onInput);
    $panel.addEventListener('change', onInput);
    $panel.addEventListener('dblclick', (e) => { if (e.target.closest('.chip')) { S.editing = true; render(); } });
    $panel.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.head');
      if (!head || e.target.closest('button')) return;
      const r = $panel.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        S.proj.panel.x = Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - ox));
        S.proj.panel.y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - oy));
        placePanel();
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); saveProject(); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    let dragDepth = 0;
    $panel.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $panel.classList.add('drop-on'); });
    $panel.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    $panel.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $panel.classList.remove('drop-on'); } });
    $panel.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $panel.classList.remove('drop-on');
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    const knob = splitEl.querySelector('.knob');
    knob.addEventListener('pointerdown', (e) => {
      knob.setPointerCapture(e.pointerId);
      const move = (ev) => {
        S.proj.overlay.splitX = Math.max(0, Math.min(1, ev.clientX / window.innerWidth));
        updateSplit();
        applyClip();
      };
      const up = () => { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); saveProject(); };
      knob.addEventListener('pointermove', move);
      knob.addEventListener('pointerup', up);
    });
  }

  function placePanel() {
    const p = S.proj.panel;
    const w = 312;
    const x = p.x == null ? window.innerWidth - w - 16 : Math.min(p.x, window.innerWidth - w - 4);
    const y = Math.min(p.y == null ? 16 : p.y, window.innerHeight - 40);
    const el = panelRoot.querySelector('.panel, .pillbar');
    if (el) { el.style.left = Math.max(4, x) + 'px'; el.style.top = Math.max(4, y) + 'px'; }
  }

  const tg = (on) => `<span class="tg ${on ? 'on' : ''}"></span>`;

  function mvInfo(bp) {
    const n = (bp.slices || []).length;
    const y = bp.offsetY || 0;
    if (!n && !y) return '';
    const txt = n ? `${n} cut${n > 1 ? 's' : ''}${y ? ' · ' + fmtD(y) : ''}` : `↕ ${fmtD(y)}`;
    return `<span class="mvinfo">${txt}${bp.locked ? '' : '<button class="link" data-act="reset-offsets" title="Clear the vertical offset and all cuts">reset</button>'}</span>`;
  }

  function render() {
    if (!panelRoot || !S.proj) return;
    const P = S.proj;
    const bp = activeBp();
    const o = P.overlay;
    const existingPill = panelRoot.querySelector('.pillbar');
    if (P.panel.collapsed) {
      $panel.style.display = 'none';
      if (!existingPill) {
        const pill = document.createElement('div');
        pill.className = 'pillbar';
        pill.addEventListener('click', () => { P.panel.collapsed = false; saveProject(); render(); });
        panelRoot.appendChild(pill);
      }
      const n = Ed.count(bp);
      panelRoot.querySelector('.pillbar').innerHTML = `<span class="mark"></span>Parity ${bp ? `<b>${bp.width}</b>` : ''}${Ed.isOn() ? ' <span class="live">· editing</span>' : ''}${n ? ` · ${n} edit${n > 1 ? 's' : ''}` : ''}`;
      Ed.mount(null);
      placePanel();
      updateSplit();
      return;
    }
    if (existingPill) existingPill.remove();
    $panel.style.display = 'flex';

    const tab = P.panel.tab === 'overlay' ? 'overlay' : 'edit';
    const chips = P.breakpoints.map((b, i) => `<button class="chip ${b.id === P.activeId ? 'on' : ''}" data-act="bp" data-id="${b.id}" title="${esc(b.name)}${b.file ? ' · ' + esc(b.file) : ' · no design'} — key ${i + 1}, double-click to edit"><b>${b.width}</b><span>${esc(b.name)}${b.imgId ? '' : ' · live'}</span>${(b.edits || []).length ? `<em>${b.edits.length}</em>` : ''}</button>`).join('');

    const addBox = S.addOpen || !P.breakpoints.length ? `<div class="box">
        <div class="drop" data-act="add">Drop / choose design JPEGs<small>One per breakpoint. Width comes from the file name or size (@2x ok). You can also paste.</small></div>
        <div class="hint" style="text-align:center">or <button class="link" data-act="add-live">edit at ${document.documentElement.clientWidth}px without a design</button></div>
      </div>` : '';

    let form = '';
    if (bp && S.editing) {
      form = `<div class="box"><div class="form">
        <label>Name<input data-f="name" value="${esc(bp.name)}"></label>
        <label>Width (css px)<input data-f="width" type="number" value="${bp.width}"></label>
        <label>Export scale<select data-f="scale">${[1, 2, 3, 4].map((sc) => `<option value="${sc}" ${sc === bp.scale ? 'selected' : ''}>@${sc}x</option>`).join('')}</select></label>
        <label>Viewport height<input data-f="vh" type="number" placeholder="auto" value="${bp.vh || ''}"></label>
        <label>Offset X<input data-f="offsetX" type="number" value="${bp.offsetX || 0}"></label>
        <label>Offset Y<input data-f="offsetY" type="number" value="${bp.offsetY || 0}"></label>
        <div class="acts"><span style="display:flex"><button class="icon" data-act="replace" title="${bp.imgId ? 'Replace' : 'Add'} the design image">${ICON.replace}</button><button class="icon" data-act="delete" title="Delete breakpoint and its edits">${ICON.trash}</button></span>
          <span style="display:flex;gap:6px"><button class="btn" data-act="edit-cancel">Cancel</button><button class="btn pri" data-act="edit-save">Save</button></span></div>
      </div><div class="hint">Viewport height = what <b>100vh</b> resolves to.${bp.imgId ? ` ${bp.imgW}×${bp.imgH} image${bp.file ? ' · ' + esc(bp.file) : ''}` : ' No design image.'}</div></div>`;
    }

    let overlay = '';
    if (bp) {
      overlay = bp.imgId ? `<div class="pane">
          <div class="row"><button class="icon ${o.visible ? 'on' : ''}" data-act="visible" title="Show/hide overlay (H)">${o.visible ? ICON.eye : ICON.eyeOff}</button>
            <input type="range" min="0" max="100" value="${Math.round(o.opacity * 100)}" data-k="opacity" style="--p:${Math.round(o.opacity * 100)}%" ${o.mode !== 'normal' ? 'disabled style="--p:100%;opacity:.35"' : ''}>
            <span class="val">${o.mode === 'normal' ? Math.round(o.opacity * 100) + '%' : '—'}</span></div>
          <div class="seg">${[['normal', 'Overlay'], ['difference', 'Difference'], ['split', 'Split']].map(([v, l]) => `<button class="${o.mode === v ? 'on' : ''}" data-act="mode" data-v="${v}">${l}</button>`).join('')}</div>
          <div class="tps">
            <button class="tp ${o.invert ? 'on' : ''}" data-act="invert" title="Invert the overlay (I)">Invert</button>
            <button class="tp ${o.align === 'center' ? 'on' : ''}" data-act="align" title="Center the overlay horizontally">Center</button>
            <button class="tp ${P.viewport.match ? 'on' : ''}" data-act="match" title="Set the tab to the breakpoint width">Match ${bp.width}px</button>
            <button class="tp ${P.freeze ? 'on' : ''}" data-act="freeze" title="Animations → end state">Freeze motion</button>
          </div>
          <div class="mvrow">
            <button class="mvb ${MV.on ? 'on' : ''}" data-act="move" ${bp.locked ? 'disabled' : ''} title="Drag the design vertically, double-click to cut it into bands (M)">${ICON.move}Move design <kbd>M</kbd></button>
            <button class="icon ${bp.locked ? 'locked' : ''}" data-act="lock" title="${bp.locked ? 'Unlock position (L)' : 'Lock position (L)'}">${bp.locked ? ICON.lock : ICON.unlock}</button>
            ${mvInfo(bp)}
          </div>
          <div class="hint">Tip: <b>Difference</b> turns everything that lines up black — edit until the page goes dark.</div>
        </div>` : `<div class="pane"><div class="drop" data-act="replace">Add a design JPEG for ${bp.width}px</div>
          <div class="tps"><button class="tp ${P.viewport.match ? 'on' : ''}" data-act="match">Match ${bp.width}px</button><button class="tp ${P.freeze ? 'on' : ''}" data-act="freeze">Freeze motion</button></div></div>`;
    }

    const n = Ed.count(bp);
    const settings = `<div class="pane">
        <div class="grp"><span class="lab">Export</span><div class="set">
          <span>Download folder</span><input data-s="folder" value="${esc(S.settings.folder)}"></div>
          <div class="hint">Download writes <b>Downloads/${esc(S.settings.folder)}/&lt;page&gt;/edits.md</b> and <b>edits.json</b>.</div></div>
        ${P.viewport.match ? `<div class="grp"><span class="lab">Match viewport by</span><div class="seg" style="margin:0">${[['emulate', 'Exact width'], ['window', 'Resize window']].map(([v, l]) => `<button class="${P.viewport.mode === v ? 'on' : ''}" data-act="vpmode" data-v="${v}">${l}</button>`).join('')}</div></div>` : ''}
        <div class="grp"><span class="lab">Keys</span><div class="set"><label class="sw" data-act="set-keys"><span>Single-key shortcuts</span>${tg(S.settings.keys)}</label></div>
          ${S.settings.keys ? `<div class="keys"><b>E</b> edit · <b>1–9</b> breakpoint · <b>H</b> hide design · <b>D</b> difference · <b>S</b> split · <b>I</b> invert · <b>−/=</b> opacity · <b>⌥ arrows</b> nudge design · <b>M</b> move/cut design · <b>L</b> lock</div>` : ''}</div>
        <button class="btn" data-act="settings" style="width:100%;margin-top:12px">Done</button></div>`;

    $panel.innerHTML = `
      <div class="head"><div class="brand"><span class="mark"></span>Parity</div>
        <div class="hbtns"><button class="icon ${Ed.isOn() ? 'on' : ''}" data-act="edit-mode" title="Edit the page (E)">${ICON.cursor}</button><button class="icon ${S.showSettings ? 'on' : ''}" data-act="settings" title="Settings">${ICON.gear}</button><button class="icon" data-act="collapse" title="Collapse">${ICON.min}</button><button class="icon" data-act="close" title="Close (Alt+Shift+P)">${ICON.close}</button></div></div>
      <div class="body">
        ${S.showSettings ? settings : `
        ${P.breakpoints.length ? `<div class="bprow"><div class="chips">${chips}<button class="icon ${S.addOpen ? 'on' : ''}" data-act="add-menu" title="Add a breakpoint">+</button></div></div>` : ''}
        ${bp && !S.editing ? `<div class="bpmeta"><span>${bp.imgId ? 'JPEG' : 'No design'} · ${bp.width}px${bp.vh ? ` · vh ${bp.vh}` : ''}${bp.offsetX || bp.offsetY ? ` · offset ${bp.offsetX || 0},${bp.offsetY || 0}` : ''}${bp.locked ? ' · locked' : ''}</span><button class="link" data-act="edit">Edit</button></div>` : ''}
        ${addBox}
        ${form}
        ${bp ? `<div class="tabs"><button class="${tab === 'edit' ? 'on' : ''}" data-act="tab" data-v="edit">Edit${n ? ` <span class="badge">${n}</span>` : ''}</button><button class="${tab === 'overlay' ? 'on' : ''}" data-act="tab" data-v="overlay">Design overlay</button></div>
        ${tab === 'overlay' ? overlay : '<div class="pane edmount"></div>'}` : ''}`}
      </div>
      <div class="toast"></div>`;
    $toast = $panel.querySelector('.toast');
    Ed.mount($panel.querySelector('.edmount'));
    const bar = panelRoot.querySelector('.mvbar');
    if (bar) bar.classList.toggle('on', MV.on);
    placePanel();
    updateSplit();
  }

  let toastT;
  function toast(msg, err) {
    if (!$toast || !$toast.isConnected) $toast = $panel && $panel.querySelector('.toast');
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { if ($toast) $toast.className = 'toast'; }, err ? 5000 : 2400);
  }

  function toggleEdit() {
    if (!activeBp()) { toast('Add a design JPEG first — or “edit without a design”', true); S.addOpen = true; render(); return; }
    stopMove();
    if (S.proj.panel.tab !== 'edit') { S.proj.panel.tab = 'edit'; saveProject(); }
    if (S.proj.panel.collapsed && !Ed.isOn()) { /* stay collapsed; the bar shows the mode */ }
    Ed.toggle();
  }

  async function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const P = S.proj;
    const bp = activeBp();
    switch (act) {
      case 'add': fileInput.click(); break;
      case 'add-live': await addLiveBp(); break;
      case 'add-menu': S.addOpen = !S.addOpen; S.editing = false; render(); break;
      case 'tab': P.panel.tab = t.dataset.v; saveProject(); render(); break;
      case 'edit-mode': toggleEdit(); break;
      case 'bp': if (t.dataset.id !== P.activeId) await setActive(t.dataset.id); break;
      case 'edit': S.editing = !S.editing; S.addOpen = false; render(); break;
      case 'edit-cancel': S.editing = false; render(); break;
      case 'edit-save': {
        const f = (k) => $panel.querySelector(`[data-f="${k}"]`).value;
        bp.name = f('name').trim() || bp.name;
        bp.width = Math.max(200, Math.round(+f('width') || bp.width));
        bp.scale = +f('scale') || 1;
        bp.vh = +f('vh') || null;
        bp.offsetX = Math.round(+f('offsetX') || 0);
        bp.offsetY = Math.round(+f('offsetY') || 0);
        P.breakpoints.sort((a, b) => a.width - b.width);
        S.editing = false;
        drawnFor = null;
        saveProject();
        render();
        renderOverlay();
        applyViewport();
        break;
      }
      case 'replace': replaceTarget = bp.id; fileInput.click(); break;
      case 'delete': if (confirmInline(t)) await removeBp(bp.id); break;
      case 'visible': P.overlay.visible = !P.overlay.visible; saveProject(); render(); renderOverlay(); break;
      case 'mode': P.overlay.mode = t.dataset.v; saveProject(); render(); renderOverlay(); break;
      case 'invert': P.overlay.invert = !P.overlay.invert; saveProject(); render(); renderOverlay(); break;
      case 'align': P.overlay.align = P.overlay.align === 'center' ? 'left' : 'center'; saveProject(); render(); renderOverlay(); break;
      case 'match':
        P.viewport.match = !P.viewport.match;
        saveProject();
        render();
        if (P.viewport.match) applyViewport();
        else { chrome.runtime.sendMessage({ type: 'parity:viewport-release' }); setTimeout(() => { renderOverlay(); Ed.onScroll(); }, 200); }
        break;
      case 'vpmode': P.viewport.mode = t.dataset.v; saveProject(); render(); applyViewport(); break;
      case 'freeze': P.freeze = !P.freeze; saveProject(); Pg.setFreeze(P.freeze); render(); break;
      case 'settings': S.showSettings = !S.showSettings; render(); break;
      case 'set-keys': e.preventDefault(); S.settings.keys = !S.settings.keys; store.set(SETTINGS_KEY, S.settings); render(); break;
      case 'collapse': P.panel.collapsed = true; stopMove(); saveProject(); render(); break;
      case 'move': toggleMove(); break;
      case 'lock': toggleLock(); break;
      case 'reset-offsets': resetOffsets(); break;
      case 'close': close(); break;
      default: break;
    }
  }

  function confirmInline(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    btn.style.color = '#ff5c74';
    toast('Click the bin again to delete this breakpoint and its edits');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.style.color = ''; } }, 3000);
    return false;
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.k === 'opacity') {
      S.proj.overlay.opacity = t.value / 100;
      t.style.setProperty('--p', t.value + '%');
      const v = $panel.querySelector('.val');
      if (v) v.textContent = t.value + '%';
      renderOverlay();
      saveProject();
    } else if (t.dataset.s === 'folder' && e.type === 'change') {
      S.settings.folder = t.value.replace(/[^\w.-]/g, '') || 'parity';
      store.set(SETTINGS_KEY, S.settings);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.setAttribute('data-parity', '');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.documentElement.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  // ---------- keyboard ----------

  function editable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }
  function onKey(e) {
    if (!S.open || !S.proj) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.some((n) => n && n.tagName && editable(n))) return;
    if (editable(document.activeElement) && document.activeElement !== panelHost) return;
    if (Ed.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.metaKey || e.ctrlKey) return;
    const bp = activeBp();
    const P = S.proj;
    if (MV.on && bp) {
      let done = true;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'Escape') stopMove();
      else if (e.key === 'ArrowUp') nudgeSel(-step);
      else if (e.key === 'ArrowDown') nudgeSel(step);
      else if (e.key === '[' || e.key === ']') { MV.sel = Math.max(0, Math.min((bp.slices || []).length, MV.sel + (e.key === '[' ? -1 : 1))); renderGuides(); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { if (MV.sel > 0) removeCut(MV.sel - 1); }
      else done = false;
      if (done) { e.preventDefault(); e.stopPropagation(); return; }
    }
    // Alt+arrows: nudge the design (↑↓ shift every band together)
    if (e.altKey && /^Arrow/.test(e.key) && bp && bp.imgId) {
      e.preventDefault();
      e.stopPropagation();
      if (bp.locked) { toast('Overlay is locked — press L to unlock', true); return; }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') bp.offsetX = (bp.offsetX || 0) - step;
      if (e.key === 'ArrowRight') bp.offsetX = (bp.offsetX || 0) + step;
      if (e.key === 'ArrowUp') shiftAll(bp, -step);
      if (e.key === 'ArrowDown') shiftAll(bp, step);
      saveProject();
      renderOverlay();
      if (!S.editing) render();
      return;
    }
    if (e.altKey || !S.settings.keys) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (/^[1-9]$/.test(k)) {
      const target = P.breakpoints[+k - 1];
      if (target) setActive(target.id); else handled = false;
    } else if (k === 'e') toggleEdit();
    else if (k === 'h') { P.overlay.visible = !P.overlay.visible; render(); renderOverlay(); }
    else if (k === 'd') { P.overlay.mode = P.overlay.mode === 'difference' ? 'normal' : 'difference'; P.overlay.visible = true; render(); renderOverlay(); }
    else if (k === 's') { P.overlay.mode = P.overlay.mode === 'split' ? 'normal' : 'split'; P.overlay.visible = true; render(); renderOverlay(); }
    else if (k === 'i') { P.overlay.invert = !P.overlay.invert; render(); renderOverlay(); }
    else if (k === 'm') toggleMove();
    else if (k === 'l') toggleLock();
    else if (k === '=' || k === '+' || k === '-' || k === '_') {
      const d = k === '-' || k === '_' ? -0.1 : 0.1;
      P.overlay.opacity = Math.round(Math.max(0, Math.min(1, P.overlay.opacity + d)) * 10) / 10;
      if (P.overlay.mode !== 'normal') P.overlay.mode = 'normal';
      P.overlay.visible = true;
      render();
      renderOverlay();
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); saveProject(); }
  }

  async function onPaste(e) {
    if (!S.open || editable(document.activeElement)) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    await addFiles(files);
  }

  // ---------- lifecycle ----------

  let rafPending = false;
  function onScrollResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!S.open) return;
      applyClip();
      updateSplit();
      placePanel();
      Ed.onScroll();
      if (MV.drag) mvApply();
    });
  }
  let resizeT;
  function onResize() {
    onScrollResize();
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { renderOverlay(); Ed.onScroll(); }, 150);
  }
  let pathT;

  const editorCtx = {
    bp: () => activeBp(),
    bps: () => (S.proj ? S.proj.breakpoints : []),
    save: () => saveProject(),
    toast: (m, err) => toast(m, err),
    copy: (t) => copyText(t),
    settings: () => S.settings,
    blocked: () => MV.on,
    changed: () => render(),
    download: (filename, text, mime) => chrome.runtime.sendMessage({ type: 'parity:download', filename, url: `data:${mime || 'text/plain'};charset=utf-8,` + encodeURIComponent(text) }),
  };

  async function open() {
    if (S.open) return;
    S.open = true;
    S.key = projectKey();
    await loadProject();
    ensureHosts();
    keeper.observe(document.documentElement, { childList: true });
    if (!S.proj.activeId && S.proj.breakpoints[0]) S.proj.activeId = S.proj.breakpoints[0].id;
    Ed.attach(editorCtx);
    render();
    await renderOverlay();
    if (S.proj.freeze) Pg.setFreeze(true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('scroll', onScrollResize, { passive: true });
    window.addEventListener('resize', onResize);
    applyViewport();
    pathT = setInterval(async () => {
      if (projectKey() === S.key) return;
      S.key = projectKey();
      await loadProject();
      drawnFor = null;
      Ed.refresh();
      render();
      renderOverlay();
    }, 1000);
  }

  function close() {
    stopMove();
    Ed.detach();
    S.open = false;
    keeper.disconnect();
    removeHosts();
    Pg.setFreeze(false);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('paste', onPaste, true);
    window.removeEventListener('scroll', onScrollResize);
    window.removeEventListener('resize', onResize);
    clearInterval(pathT);
    clearTimeout(saveT);
    if (S.proj) store.set('proj:' + S.key, S.proj);
    chrome.runtime.sendMessage({ type: 'parity:closed' }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'parity:toggle':
        if (S.open) { close(); sendResponse({ open: false }); }
        else open().then(() => sendResponse({ open: true }));
        return true;
      case 'parity:open':
        open().then(() => sendResponse({ open: true }));
        return true;
      case 'parity:edit-shortcut':
        (async () => { if (!S.open) await open(); toggleEdit(); })();
        sendResponse({ ok: true });
        return false;
      case 'parity:measure':
        sendResponse({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, clientWidth: document.documentElement.clientWidth, dpr: window.devicePixelRatio });
        return false;
      case 'parity:detached':
        if (S.open && S.proj && S.proj.viewport.match && S.proj.viewport.mode === 'emulate') {
          S.proj.viewport.match = false;
          saveProject();
          render();
          toast('Viewport emulation was cancelled — toggle “Match” to resume.');
          setTimeout(() => { renderOverlay(); Ed.onScroll(); }, 200);
        }
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
