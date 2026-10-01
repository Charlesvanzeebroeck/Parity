/* Parity — in-page panel, design overlay and issue layer. */
(function () {
  if (window.__parityContent) return;
  window.__parityContent = true;

  const Z = 2147483646;
  const SETTINGS_KEY = 'parity:settings';
  const DEFAULT_SETTINGS = { tolerance: 2, autoSave: true, saveImages: false, folder: 'parity', keys: true, figmaToken: '' };
  const defaultProject = () => ({
    v: 1,
    breakpoints: [],
    activeId: null,
    overlay: { visible: true, opacity: 0.5, mode: 'normal', invert: false, align: 'left', splitX: 0.5 },
    viewport: { match: true, mode: 'emulate' },
    freeze: false,
    showIssues: false,
    contentMode: 'same',
    ignore: [],
    panel: { x: null, y: 16, collapsed: false },
  });

  const S = {
    key: projectKey(),
    proj: null,
    settings: { ...DEFAULT_SETTINGS },
    open: false,
    bitmaps: new Map(),
    report: null,
    busy: false,
    capturing: false,
    editing: false,
    showSettings: false,
  };

  function projectKey() {
    return location.origin + location.pathname;
  }

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
    S.settings = { ...DEFAULT_SETTINGS, ...((await store.get(SETTINGS_KEY)) || {}) };
  }
  const activeBp = () => S.proj && S.proj.breakpoints.find((b) => b.id === S.proj.activeId);
  // storage-key suffix for the section scope ('' = whole page); same hash as background.js / report.js
  function scopeKey(scope) {
    if (!scope || !scope.selector) return '';
    let h = 2166136261 >>> 0;
    for (let i = 0; i < scope.selector.length; i++) { h ^= scope.selector.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return '@' + h.toString(36);
  }
  const sk = () => scopeKey(S.proj && S.proj.scope);
  const scopeEl = () => { try { return S.proj && S.proj.scope ? document.querySelector(S.proj.scope.selector) : null; } catch (e) { return null; } };
  const sectionImg = (bp) => (bp && S.proj.scope && bp.sections ? bp.sections[S.proj.scope.selector] : null);
  const loadReport = async () => { S.report = S.proj && S.proj.activeId ? await store.get(`rep:${S.key}:${S.proj.activeId}${sk()}`) : null; };
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
        toast(`Updated ${g.width}px design`);
      } else {
        bp = { id: uid(), name: labelFor(g.width), width: g.width, scale: g.scale, vh: null, offsetX: 0, offsetY: 0, imgId, imgW: bmp.width, imgH: bmp.height, file: f.name || 'pasted image' };
        S.proj.breakpoints.push(bp);
      }
      last = bp;
    }
    S.proj.breakpoints.sort((a, b) => a.width - b.width);
    saveProject();
    if (last) await setActive(last.id);
    else render();
  }

  async function removeBp(id) {
    const bp = S.proj.breakpoints.find((b) => b.id === id);
    if (!bp) return;
    if (bp.imgId) { store.del('img:' + bp.imgId); S.bitmaps.delete(bp.imgId); }
    store.del(`cap:${S.key}:${id}`);
    store.del(`rep:${S.key}:${id}`);
    for (const sec of Object.values(bp.sections || {})) store.del('img:' + sec.imgId);
    S.proj.breakpoints = S.proj.breakpoints.filter((b) => b.id !== id);
    if (S.proj.activeId === id) S.proj.activeId = S.proj.breakpoints[0] ? S.proj.breakpoints[0].id : null;
    saveProject();
    await setActive(S.proj.activeId);
  }

  async function setActive(id) {
    S.proj.activeId = id;
    S.editing = false;
    saveProject();
    await loadReport();
    render();
    await renderOverlay();
    renderIssues();
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
    setTimeout(() => { renderOverlay(); renderIssues(); }, 120);
  }

  // ---------- hosts ----------

  let overlayHost, overlayCanvas, panelHost, panelRoot, issuesHost, issuesRoot, splitEl;

  function mkHost(id, fixed) {
    const h = document.createElement('parity-' + id);
    h.setAttribute('data-parity', '');
    h.style.cssText = `all:initial;position:${fixed ? 'fixed' : 'absolute'};left:0;top:0;z-index:${Z};pointer-events:none;display:block;`;
    return h;
  }

  function ensureHosts() {
    if (!overlayHost) {
      overlayHost = mkHost('overlay', false);
      const r = overlayHost.attachShadow({ mode: 'open' });
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.style.cssText = 'display:block;width:100%;height:100%;';
      r.appendChild(overlayCanvas);
    }
    if (!issuesHost) {
      issuesHost = mkHost('issues', false);
      issuesHost.style.zIndex = Z;
      issuesRoot = issuesHost.attachShadow({ mode: 'open' });
    }
    if (!panelHost) {
      panelHost = mkHost('panel', true);
      panelHost.style.zIndex = Z + 1;
      panelHost.style.width = '0';
      panelHost.style.height = '0';
      panelRoot = panelHost.attachShadow({ mode: 'open' });
      buildPanel();
    }
    for (const h of [overlayHost, issuesHost, panelHost]) {
      if (!h.isConnected) document.documentElement.appendChild(h);
    }
  }
  const keeper = new MutationObserver(() => {
    if (!S.open) return;
    if ((overlayHost && !overlayHost.isConnected) || (panelHost && !panelHost.isConnected) || (issuesHost && !issuesHost.isConnected)) ensureHosts();
  });

  function removeHosts() {
    for (const h of [overlayHost, issuesHost, panelHost]) if (h) h.remove();
  }

  // ---------- overlay ----------

  let drawnFor = null;
  async function renderOverlay() {
    if (!S.open || !overlayHost) return;
    const bp = activeBp();
    const o = S.proj.overlay;
    if (!bp || !o.visible || S.capturing) { overlayHost.style.display = 'none'; updateSplit(); return; }
    // section scope: overlay the section JPEG on the section, or shift the full design so the section tops align
    const sec = sectionImg(bp);
    const sEl = S.proj.scope && S.proj.scopeAlign !== false ? scopeEl() : null;
    const sBox = sEl ? sEl.getBoundingClientRect() : null;
    const useSec = !!(sec && sBox);
    const bmp = await getBitmap(useSec ? { imgId: sec.imgId } : bp);
    if (!bmp) { overlayHost.style.display = 'none'; return; }
    const cssW = useSec ? Math.round(sBox.width) : bp.width;
    const cssH = Math.round((bmp.height * cssW) / bmp.width);
    const sig = (useSec ? sec.imgId : bp.imgId) + ':' + cssW;
    if (drawnFor !== sig) {
      const dpr = window.devicePixelRatio || 1;
      const s = Math.min(dpr, 16000 / cssH, 16000 / cssW, Math.sqrt(24e6 / (cssW * cssH)), bmp.width / cssW);
      overlayCanvas.width = Math.max(1, Math.round(cssW * s));
      overlayCanvas.height = Math.max(1, Math.round(cssH * s));
      const ctx = overlayCanvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, overlayCanvas.width, overlayCanvas.height);
      drawnFor = sig;
    }
    const docW = document.documentElement.clientWidth;
    let left = (o.align === 'center' ? Math.round((docW - cssW) / 2) : 0) + (bp.offsetX || 0);
    let top = bp.offsetY || 0;
    if (useSec) { left = Math.round(sBox.left + scrollX); top = Math.round(sBox.top + scrollY); }
    else if (sBox && S.report && S.report.scope && S.report.scope.designTop != null) top += Math.round(sBox.top + scrollY - S.report.scope.designTop);
    const st = overlayHost.style;
    st.display = 'block';
    st.left = left + 'px';
    st.top = top + 'px';
    st.width = cssW + 'px';
    st.height = cssH + 'px';
    st.opacity = o.mode === 'difference' ? '1' : String(o.opacity);
    st.mixBlendMode = o.mode === 'difference' ? 'difference' : 'normal';
    st.filter = o.invert ? 'invert(1)' : 'none';
    applyClip();
    updateSplit();
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
    const on = S.open && S.proj.overlay.mode === 'split' && S.proj.overlay.visible && activeBp() && !S.capturing;
    splitEl.style.display = on ? 'block' : 'none';
    if (on) splitEl.style.left = S.proj.overlay.splitX * window.innerWidth + 'px';
  }

  // ---------- issues layer ----------

  function renderIssues() {
    if (!issuesRoot) return;
    const rep = S.report;
    const on = S.open && S.proj.showIssues && rep && rep.issues && !S.capturing;
    const ign = S.open && !S.capturing && (S.proj.ignore || []).length && (S.proj.showIssues || (typeof PK !== 'undefined' && PK.on));
    issuesHost.style.display = on || ign ? 'block' : 'none';
    if (!on && !ign) { issuesRoot.innerHTML = ''; return; }
    const bp = activeBp();
    const sameWidth = bp && rep && Math.abs(document.documentElement.clientWidth - rep.page.width) <= 1;
    const items = on ? rep.issues.filter((i) => i.actual && i.expected).slice(0, 150) : [];
    let html = `<style>
      .b{position:absolute;box-sizing:border-box;pointer-events:none}
      .a{border:1.5px solid #22d3ee;background:rgba(34,211,238,.06)}
      .e{border:1.5px dashed #ff3d8b}
      .l{position:absolute;transform:translateY(-100%);font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#ff3d8b;color:#fff;padding:1px 5px;border-radius:4px 4px 4px 0;white-space:nowrap;pointer-events:none}
      .l.high{background:#ff3d57}.l.medium{background:#ff9f1a;color:#1b1300}.l.low{background:#8b8d94}
      .ig{position:absolute;box-sizing:border-box;border:1.5px dashed #a78bfa;background:repeating-linear-gradient(135deg,rgba(167,139,250,.16) 0 6px,transparent 6px 12px)}
      .ig span{position:absolute;left:4px;top:4px;font:700 10px ui-monospace,Menlo,monospace;background:#a78bfa;color:#140b2e;padding:1px 5px;border-radius:4px}
      .flash{animation:f 1.2s ease 2}
      @keyframes f{50%{box-shadow:0 0 0 6px rgba(200,255,61,.55)}}
    </style>`;
    for (const it of items) {
      let a = it.actual;
      // follow the live element (the page may have hot-reloaded since the capture)
      try {
        const el = it.element && it.element.selector && document.querySelector(it.element.selector);
        if (el && sameWidth && it.elementBox) {
          const r = el.getBoundingClientRect();
          a = { ...a, x: a.x + (r.left + scrollX - it.elementBox.x), y: a.y + (r.top + scrollY - it.elementBox.y), w: a.w + (r.width - it.elementBox.w), h: a.h + (r.height - it.elementBox.h) };
          a = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) };
        }
      } catch (e) { /* bad selector */ }
      const e = it.expected;
      const d = it.delta || {};
      const txt = [
        d.y ? `↕${d.y > 0 ? '+' : ''}${d.y}` : '',
        d.x ? `↔${d.x > 0 ? '+' : ''}${d.x}` : '',
        d.w ? `w${d.w > 0 ? '+' : ''}${d.w}` : '',
        d.h ? `h${d.h > 0 ? '+' : ''}${d.h}` : '',
        it.kind.find((k) => k.startsWith('gap') || k.startsWith('padding') || k.includes('color') || k === 'not-found') || '',
      ].filter(Boolean).join(' ');
      html += `<div class="b a" data-id="${it.id}" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px"></div>`;
      if (e.x !== a.x || e.y !== a.y || e.w !== a.w || e.h !== a.h) html += `<div class="b e" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px"></div>`;
      html += `<div class="l ${it.severity}" style="left:${a.x}px;top:${a.y}px">#${it.id} ${esc(txt)}</div>`;
    }
    if (ign) {
      for (const sel of S.proj.ignore) {
        let els = [];
        try { els = [...document.querySelectorAll(sel)]; } catch (e) { /* bad selector */ }
        for (const el of els.slice(0, 20)) {
          const r = el.getBoundingClientRect();
          html += `<div class="ig" style="left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px"><span>ignored</span></div>`;
        }
      }
    }
    issuesRoot.innerHTML = html;
  }

  function flashIssue(id) {
    const it = S.report && S.report.issues.find((i) => i.id === id);
    if (!it) return;
    if (!S.proj.showIssues) { S.proj.showIssues = true; saveProject(); render(); renderIssues(); }
    const box = issuesRoot.querySelector(`[data-id="${id}"]`);
    const y = box ? parseFloat(box.style.top) : it.actual.y;
    window.scrollTo({ top: Math.max(0, y - window.innerHeight / 3), behavior: 'auto' });
    if (box) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
  }

  // ---------- panel ----------

  const ICON = {
    eye: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>',
    eyeOff: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l12 12M6.5 3.3A7 7 0 0 1 8 3c4.5 0 7 5 7 5a12 12 0 0 1-2 2.6M4 4.9A12 12 0 0 0 1 8s2.5 5 7 5a7 7 0 0 0 3-.7"/></svg>',
    edit: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>',
    trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>',
    gear: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
    min: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h8"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    pick: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5l4.2 11 1.6-4.4 4.4-1.6z"/><path d="M8.6 8.6l4.4 4.4"/></svg>',
    replace: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.6M13.5 8a5.5 5.5 0 0 1-9.6 3.6M12.5 2v3h-3M3.5 14v-3h3"/></svg>',
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .panel{position:fixed;width:292px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;pointer-events:auto;
    background:rgba(17,18,20,.96);color:#e9e9ec;border:1px solid rgba(255,255,255,.09);border-radius:14px;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.25);backdrop-filter:blur(12px);
    font:12px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;overflow:hidden}
  .panel.drop-on{outline:2px solid #c8ff3d;outline-offset:-2px}
  .head{display:flex;align-items:center;justify-content:space-between;padding:9px 8px 9px 12px;cursor:grab;border-bottom:1px solid rgba(255,255,255,.06)}
  .head:active{cursor:grabbing}
  .brand{display:flex;align-items:center;gap:8px;font-weight:650;letter-spacing:.01em;font-size:12.5px}
  .mark{width:14px;height:14px;border-radius:4px;background:linear-gradient(90deg,#c8ff3d 50%,#3a3d44 50%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
  .brand small{color:#8b8d94;font-weight:500}
  .hbtns{display:flex;gap:2px}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
  .icon{width:26px;height:24px;display:grid;place-items:center;border-radius:7px;color:#a3a5ad}
  .icon:hover{background:rgba(255,255,255,.07);color:#fff}
  .icon.on{color:#c8ff3d}
  .body{overflow:auto;padding:4px 0 6px}
  .sec{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06)}
  .sec:last-child{border-bottom:0}
  .row{display:flex;align-items:center;gap:8px}
  .between{justify-content:space-between}
  .lab{color:#8b8d94;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
  .link{color:#c8ff3d;font-weight:600;font-size:11.5px}
  .link:hover{text-decoration:underline}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .chip{display:flex;flex-direction:column;align-items:flex-start;padding:6px 10px 5px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);min-width:58px;text-align:left}
  .chip b{font:650 13px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.01em}
  .chip span{font-size:10px;color:#8b8d94;margin-top:2px}
  .chip:hover{border-color:rgba(255,255,255,.18)}
  .chip.on{background:#c8ff3d;border-color:#c8ff3d;color:#111}
  .chip.on span{color:rgba(0,0,0,.6)}
  .chip i{font-style:normal;font-size:9px;opacity:.55;margin-left:4px}
  .drop{margin-top:8px;border:1.5px dashed rgba(255,255,255,.14);border-radius:10px;padding:16px 10px;text-align:center;color:#a3a5ad;cursor:pointer}
  .drop:hover{border-color:#c8ff3d;color:#fff}
  .drop small{display:block;color:#6f7179;margin-top:4px;font-size:10.5px}
  .detail{margin-top:8px;display:flex;align-items:center;justify-content:space-between;color:#8b8d94;font-size:11px}
  .detail .tools{display:flex;gap:0}
  .detail .icon{width:24px;height:22px}
  .form{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px 8px}
  .form label{display:flex;flex-direction:column;gap:3px;color:#8b8d94;font-size:10.5px}
  .form input,.form select,.set input{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 7px;width:100%;outline:none}
  .form input:focus,.set input:focus{border-color:#c8ff3d}
  .form .full{grid-column:1/-1}
  .form .acts{grid-column:1/-1;display:flex;gap:6px;justify-content:flex-end}
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
  .sw{display:flex;align-items:center;justify-content:space-between;margin-top:8px;cursor:pointer;color:#d6d7db}
  .sw:first-child{margin-top:0}
  .sw small{color:#6f7179;margin-left:4px}
  .tg{position:relative;width:28px;height:16px;border-radius:9px;background:rgba(255,255,255,.14);transition:background .15s}
  .tg::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}
  .tg.on{background:#c8ff3d}
  .tg.on::after{transform:translateX(12px);background:#111}
  .an{display:flex;gap:6px}
  .an .btn.pri{flex:1;padding:8px 10px;display:flex;justify-content:center;align-items:center;gap:8px;font-size:12.5px}
  .an .btn.pri[disabled]{opacity:.5;cursor:default}
  kbd{font:600 9.5px ui-monospace,Menlo,monospace;padding:1px 4px;border-radius:4px;background:rgba(0,0,0,.14)}
  .status{margin-top:8px;color:#a3a5ad;font-size:11px;min-height:0}
  .status:empty{display:none}
  .sum{margin-top:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .pill{font:600 10.5px ui-monospace,Menlo,monospace;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.07)}
  .pill.high{background:rgba(255,61,87,.18);color:#ff8a9a}
  .pill.medium{background:rgba(255,159,26,.16);color:#ffc36b}
  .pill.low{background:rgba(255,255,255,.07);color:#a3a5ad}
  .pill.ok{background:rgba(200,255,61,.14);color:#c8ff3d}
  .issues{margin-top:8px;max-height:210px;overflow:auto;border-radius:9px;background:rgba(0,0,0,.2)}
  .iss{display:flex;gap:8px;padding:6px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04);align-items:flex-start}
  .iss:hover{background:rgba(255,255,255,.05)}
  .iss .dot{width:7px;height:7px;border-radius:50%;margin-top:4px;flex:none;background:#8b8d94}
  .iss .dot.high{background:#ff3d57}.iss .dot.medium{background:#ff9f1a}
  .iss .t{font-size:11px;color:#d6d7db;line-height:1.35}
  .iss .t code{font:10px ui-monospace,Menlo,monospace;color:#8b8d94;display:block;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
  .keys{padding:8px 12px 4px;color:#6f7179;font-size:10.5px;line-height:1.6}
  .keys b{color:#a3a5ad;font-weight:600;font-family:ui-monospace,Menlo,monospace}
  .toast{position:absolute;left:10px;right:10px;bottom:10px;padding:8px 10px;border-radius:9px;background:#26282d;color:#fff;font-size:11.5px;box-shadow:0 6px 20px rgba(0,0,0,.4);opacity:0;transform:translateY(6px);transition:all .18s;pointer-events:none}
  .toast.on{opacity:1;transform:none}
  .toast.err{background:#4a1520}
  .set{display:grid;grid-template-columns:1fr 80px;gap:8px;align-items:center;color:#d6d7db}
  .set .sw{grid-column:1/-1;margin:0}
  .hint{color:#6f7179;font-size:10.5px;margin-top:6px;line-height:1.45}
  .scope{display:flex;align-items:center;gap:8px;min-width:0}
  .scope code{font:11px ui-monospace,Menlo,monospace;color:#c8ff3d;background:rgba(200,255,61,.1);padding:2px 6px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
  .scope .whole{color:#d6d7db}
  .scope .link{margin-left:auto}
  .scope .icon{width:20px;height:20px}
  .secrow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;color:#8b8d94;font-size:11px}
  .secrow b{color:#d6d7db;font-weight:600}
  .ignrow{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 0}
  .ignrow code{font:10.5px ui-monospace,Menlo,monospace;color:#c4b5fd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
  .pillbar{position:fixed;pointer-events:auto;display:flex;align-items:center;gap:8px;padding:7px 10px 7px 9px;border-radius:30px;background:rgba(17,18,20,.96);color:#e9e9ec;border:1px solid rgba(255,255,255,.1);box-shadow:0 10px 30px -8px rgba(0,0,0,.5);font:600 12px -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;cursor:pointer}
  .pillbar b{font-family:ui-monospace,Menlo,monospace}
  .split{position:fixed;top:0;bottom:0;width:0;pointer-events:none;display:none}
  .split::before{content:"";position:absolute;top:0;bottom:0;left:-1px;width:2px;background:#c8ff3d;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
  .split .knob{position:absolute;top:50%;left:-14px;width:28px;height:28px;margin-top:-14px;border-radius:50%;background:#c8ff3d;pointer-events:auto;cursor:ew-resize;display:grid;place-items:center;box-shadow:0 2px 10px rgba(0,0,0,.35)}
  .split .knob::after{content:"";width:10px;height:10px;border-left:2px solid #111;border-right:2px solid #111}
  .split .tagl,.split .tagr{position:absolute;top:12px;font:700 10px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:5px;background:#111;color:#c8ff3d;white-space:nowrap}
  .split .tagl{right:8px}.split .tagr{left:8px;color:#fff}
  .pbox{position:fixed;pointer-events:none;display:none;border:1.5px solid #c8ff3d;background:rgba(200,255,61,.08);box-shadow:0 0 0 1px rgba(0,0,0,.35);border-radius:2px;transition:all .06s linear}
  .pbox.copied{background:rgba(200,255,61,.28)}
  .ptip{position:fixed;pointer-events:none;display:none;max-width:420px;padding:7px 9px;border-radius:8px;background:rgba(17,18,20,.97);color:#e9e9ec;border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 24px rgba(0,0,0,.45);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
  .ptip .tg2{color:#c8ff3d;font-weight:700}
  .ptip .cl{color:#e9e9ec;word-break:break-word;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}
  .ptip .cl.none{color:#6f7179;font-style:italic}
  .ptip .sz{color:#8b8d94;float:right;margin-left:10px}
  .ptip .hk{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.08);color:#6f7179;font-family:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;font-size:10.5px}
  .ptip .hk b{color:#a3a5ad;font-weight:600}
  .ptip.ok .cl{color:#c8ff3d}
  `;

  let $panel, $toast, fileInput, replaceTarget = null;

  function buildPanel() {
    panelRoot.innerHTML = `<style>${CSS}</style><div class="panel"></div><div class="split"><span class="tagl">DESIGN</span><span class="tagr">SITE</span><div class="knob"></div></div><div class="pbox"></div><div class="ptip"></div>`;
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
      if (replaceTarget === 'section' && files[0]) {
        replaceTarget = null;
        return addSectionImage(files[0]);
      }
      if (replaceTarget && files[0]) {
        const bp = S.proj.breakpoints.find((b) => b.id === replaceTarget);
        replaceTarget = null;
        if (bp) return replaceImage(bp, files[0]);
      }
      addFiles(files);
    });

    // panel events (delegated)
    $panel.addEventListener('click', onClick);
    $panel.addEventListener('input', onInput);
    $panel.addEventListener('change', onInput);
    $panel.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) { S.editing = true; render(); }
    });
    // drag to move
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
    // drop files
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
    // split knob
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

  async function addSectionImage(file) {
    const bp = activeBp();
    const scope = S.proj.scope;
    if (!bp || !scope) return;
    const url = await readFile(file);
    const bmp = await createImageBitmap(file);
    bp.sections = bp.sections || {};
    const old = bp.sections[scope.selector];
    if (old) { store.del('img:' + old.imgId); S.bitmaps.delete(old.imgId); }
    const imgId = uid();
    await store.set('img:' + imgId, url);
    S.bitmaps.set(imgId, bmp);
    bp.sections[scope.selector] = { imgId, imgW: bmp.width, imgH: bmp.height, file: file.name || 'pasted image' };
    saveProject();
    drawnFor = null;
    toast(`Section design set for ${bp.width}px`);
    render();
    renderOverlay();
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
    if (Math.abs(bmp.width / bp.scale - bp.width) > 2) bp.scale = g.width === bp.width ? g.scale : Math.max(1, Math.round(bmp.width / bp.width));
    saveProject();
    drawnFor = null;
    toast('Design image replaced');
    render();
    renderOverlay();
  }

  function placePanel() {
    const p = S.proj.panel;
    const w = 292;
    const x = p.x == null ? window.innerWidth - w - 16 : Math.min(p.x, window.innerWidth - w - 4);
    const y = Math.min(p.y == null ? 16 : p.y, window.innerHeight - 40);
    const el = panelRoot.querySelector('.panel, .pillbar');
    if (el) { el.style.left = Math.max(4, x) + 'px'; el.style.top = Math.max(4, y) + 'px'; }
  }

  function tg(on) { return `<span class="tg ${on ? 'on' : ''}"></span>`; }

  function render() {
    if (!panelRoot || !S.proj) return;
    const P = S.proj;
    const bp = activeBp();
    const o = P.overlay;
    // collapsed pill
    const existingPill = panelRoot.querySelector('.pillbar');
    if (P.panel.collapsed) {
      $panel.style.display = 'none';
      if (!existingPill) {
        const pill = document.createElement('div');
        pill.className = 'pillbar';
        pill.addEventListener('click', () => { P.panel.collapsed = false; saveProject(); render(); });
        panelRoot.appendChild(pill);
      }
      panelRoot.querySelector('.pillbar').innerHTML = `<span class="mark"></span>Parity ${bp ? `<b>${bp.width}</b>` : ''}${o.visible && bp ? '' : ' <span style="color:#8b8d94">· hidden</span>'}`;
      placePanel();
      updateSplit();
      return;
    }
    if (existingPill) existingPill.remove();
    $panel.style.display = 'flex';

    const chips = P.breakpoints.map((b, i) => `<button class="chip ${b.id === P.activeId ? 'on' : ''}" data-act="bp" data-id="${b.id}" title="${esc(b.file || '')} — press ${i + 1}"><b>${b.width}<i>${b.scale > 1 ? '@' + b.scale + 'x' : ''}</i></b><span>${esc(b.name)}</span></button>`).join('');

    let detail = '';
    if (bp && S.editing) {
      detail = `<div class="form">
        <label>Name<input data-f="name" value="${esc(bp.name)}"></label>
        <label>Width (css px)<input data-f="width" type="number" value="${bp.width}"></label>
        <label>Export scale<select data-f="scale">${[1, 2, 3, 4].map((s) => `<option value="${s}" ${s === bp.scale ? 'selected' : ''}>@${s}x</option>`).join('')}</select></label>
        <label>Viewport height<input data-f="vh" type="number" placeholder="auto" value="${bp.vh || ''}"></label>
        <label>Offset X<input data-f="offsetX" type="number" value="${bp.offsetX || 0}"></label>
        <label>Offset Y<input data-f="offsetY" type="number" value="${bp.offsetY || 0}"></label>
        <label class="full">Figma frame link <span style="color:#6f7179">(optional, needs a token in ⚙)</span><input data-f="figmaUrl" placeholder="https://www.figma.com/design/…?node-id=12-345" value="${esc(bp.figmaUrl || '')}"></label>
        <div class="acts"><button class="btn" data-act="edit-cancel">Cancel</button><button class="btn pri" data-act="edit-save">Save</button></div>
      </div>
      <div class="hint">Viewport height sets what <b>100vh</b> resolves to — use the Figma frame's first-screen height if the hero is full-height.</div>`;
    } else if (bp) {
      detail = `<div class="detail"><span>${bp.imgW}×${bp.imgH} → ${bp.width}px${bp.vh ? ` · vh ${bp.vh}` : ''}${bp.offsetX || bp.offsetY ? ` · offset ${bp.offsetX},${bp.offsetY}` : ''}</span>
        <span class="tools"><button class="icon" data-act="edit" title="Edit breakpoint">${ICON.edit}</button><button class="icon" data-act="replace" title="Replace image">${ICON.replace}</button><button class="icon" data-act="delete" title="Delete breakpoint">${ICON.trash}</button></span></div>`;
    }

    const rep = S.report;
    let last = '';
    if (rep && bp) {
      const s = rep.stats;
      const ago = timeAgo(rep.generatedAt);
      last = `<div class="sum">
          <span class="pill ${s.issues ? '' : 'ok'}">${s.exactPct}% exact</span>
          ${s.bySeverity.high ? `<span class="pill high">${s.bySeverity.high} high</span>` : ''}
          ${s.bySeverity.medium ? `<span class="pill medium">${s.bySeverity.medium} med</span>` : ''}
          ${s.bySeverity.low ? `<span class="pill low">${s.bySeverity.low} low</span>` : ''}
          <span style="color:#6f7179;font-size:10.5px;margin-left:auto">${ago}</span>
        </div>
        <label class="sw" data-act="issues"><span>Show issues on page</span>${tg(P.showIssues)}</label>
        ${P.showIssues && rep.issues.length ? `<div class="issues">${rep.issues.slice(0, 60).map((it) => `<div class="iss" data-act="issue" data-id="${it.id}"><span class="dot ${it.severity}"></span><div class="t">#${it.id} ${esc(it.summary.replace(/^<[^>]+>\s*(".*?")?\s*/, (m, q) => q ? q + ' ' : ''))}<code>${esc(it.element && it.element.selector)}</code></div></div>`).join('')}</div>` : ''}
        <div class="row" style="margin-top:8px;gap:12px"><button class="link" data-act="open-report">Open report ↗</button>${rep.pageWidthMismatch ? '' : ''}</div>`;
    }

    const settings = S.showSettings ? `<div class="sec"><div class="set">
        <span>Tolerance (px)</span><input data-s="tolerance" type="number" min="0" max="20" value="${S.settings.tolerance}">
        <span>Download folder</span><input data-s="folder" value="${esc(S.settings.folder)}">
        <label class="sw" data-act="set-autosave"><span>Auto-save JSON to Downloads</span>${tg(S.settings.autoSave)}</label>
        <label class="sw" data-act="set-images"><span>Also save annotated PNG</span>${tg(S.settings.saveImages)}</label>
        <label class="sw" data-act="set-keys"><span>Single-key shortcuts</span>${tg(S.settings.keys)}</label>
        <span>Figma token</span><input data-s="figmaToken" type="password" placeholder="figd_…" value="${esc(S.settings.figmaToken || '')}">
      </div><div class="lab" style="margin-top:12px">This page</div><div class="set" style="margin-top:6px">
        <label class="sw" data-act="content-mode"><span>Content-tolerant <small>copy/images differ from mockup</small></span>${tg(S.proj.contentMode === 'tolerant')}</label>
        <div style="grid-column:1/-1">${(S.proj.ignore || []).length ? `<div class="hint" style="margin:0 0 4px">Ignored at analysis (⌥ click in pick mode to toggle):</div>${S.proj.ignore.map((sel, i) => `<div class="ignrow"><code>${esc(sel)}</code><button class="icon" data-act="unignore" data-i="${i}" title="Stop ignoring">${ICON.close}</button></div>`).join('')}` : '<div class="hint" style="margin:0">No ignored elements. In pick mode (C), ⌥ click an element to exclude it (e.g. header, hero).</div>'}</div>
      </div><div class="hint">Reports are written to <b>Downloads/${esc(S.settings.folder)}/latest.json</b> so a coding agent can read them.</div></div>` : '';

    $panel.innerHTML = `
      <div class="head"><div class="brand"><span class="mark"></span>Parity</div>
        <div class="hbtns"><button class="icon ${PK.on ? 'on' : ''}" data-act="pick" title="Pick an element to copy its classes (C)">${ICON.pick}</button><button class="icon ${S.showSettings ? 'on' : ''}" data-act="settings" title="Settings">${ICON.gear}</button><button class="icon" data-act="collapse" title="Collapse">${ICON.min}</button><button class="icon" data-act="close" title="Close (Alt+Shift+P)">${ICON.close}</button></div></div>
      <div class="body">
        ${settings}
        <div class="sec">
          <div class="row between"><span class="lab">Breakpoints</span>${P.breakpoints.length ? '<button class="link" data-act="add">+ Add</button>' : ''}</div>
          ${P.breakpoints.length ? `<div class="chips">${chips}</div>` : ''}
          ${P.breakpoints.length ? detail : `<div class="drop" data-act="add">Drop Figma JPEG exports<small>One per breakpoint — width is read from the file size and name (e.g. home-1440@2x.jpg). You can also paste.</small></div>`}
        </div>
        ${bp ? `
        <div class="sec">
          <div class="row"><button class="icon ${o.visible ? 'on' : ''}" data-act="visible" title="Show/hide overlay (H)">${o.visible ? ICON.eye : ICON.eyeOff}</button>
            <input type="range" min="0" max="100" value="${Math.round(o.opacity * 100)}" data-k="opacity" style="--p:${Math.round(o.opacity * 100)}%" ${o.mode !== 'normal' ? 'disabled style="--p:100%;opacity:.35"' : ''}>
            <span class="val">${o.mode === 'normal' ? Math.round(o.opacity * 100) + '%' : '—'}</span></div>
          <div class="seg">${[['normal', 'Overlay'], ['difference', 'Difference'], ['split', 'Split']].map(([v, l]) => `<button class="${o.mode === v ? 'on' : ''}" data-act="mode" data-v="${v}">${l}</button>`).join('')}</div>
          <div class="row" style="margin-top:8px;gap:14px">
            <label class="sw" style="margin:0;gap:8px" data-act="invert">${tg(o.invert)}<span>Invert</span></label>
            <label class="sw" style="margin:0;gap:8px" data-act="align">${tg(o.align === 'center')}<span>Center</span></label>
          </div>
        </div>
        <div class="sec">
          <label class="sw" data-act="match"><span>Match viewport to ${bp.width}px</span>${tg(P.viewport.match)}</label>
          ${P.viewport.match ? `<div class="seg">${[['emulate', 'Exact (emulated)'], ['window', 'Resize window']].map(([v, l]) => `<button class="${P.viewport.mode === v ? 'on' : ''}" data-act="vpmode" data-v="${v}">${l}</button>`).join('')}</div>` : ''}
          <label class="sw" data-act="freeze"><span>Freeze motion <small>animations → end state</small></span>${tg(P.freeze)}</label>
        </div>
        <div class="sec">
          <div class="scope"><span class="lab">Scope</span>
            ${P.scope ? `<code title="${esc(P.scope.selector)}">${esc(P.scope.label || P.scope.selector)}</code><button class="icon" data-act="scope-clear" title="Back to the whole page">${ICON.close}</button>` : '<span class="whole">Whole page</span>'}
            <button class="link" data-act="scope-pick">${P.scope ? 'Change' : 'Pick section'}</button></div>
          ${P.scope ? `<div class="secrow">${sectionImg(bp) ? `<span>Design: section JPEG <b>${esc(sectionImg(bp).file)}</b></span><button class="link" data-act="sec-remove">remove</button>` : `<span>Design: located in the full JPEG</span><button class="link" data-act="sec-add">+ section JPEG</button>`}</div>
          <label class="sw" data-act="scope-align"><span>Align overlay to this section</span>${tg(P.scopeAlign !== false)}</label>` : ''}
          <div class="an" style="margin-top:10px"><button class="btn pri" data-act="analyze" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Analyzing…' : P.scope ? 'Analyze section' : 'Analyze vs design'} <kbd>⌥⇧A</kbd></button>
            ${P.breakpoints.length > 1 ? `<button class="btn" data-act="analyze-all" ${S.busy ? 'disabled' : ''} title="Capture and analyze every breakpoint">All ${P.breakpoints.length}</button>` : ''}</div>
          <div class="status">${esc(S.status || '')}</div>
          ${last}
        </div>` : ''}
        ${S.settings.keys && bp ? `<div class="keys"><b>1–9</b> breakpoint · <b>H</b> hide · <b>D</b> diff · <b>S</b> split · <b>−/=</b> opacity · <b>⌥←↑→↓</b> nudge · <b>C</b> copy classes</div>` : ''}
      </div>
      <div class="toast"></div>`;
    $toast = $panel.querySelector('.toast');
    placePanel();
    updateSplit();
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }

  let toastT;
  function toast(msg, err) {
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { if ($toast) $toast.className = 'toast'; }, err ? 5000 : 2200);
  }

  async function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const P = S.proj;
    const bp = activeBp();
    switch (act) {
      case 'add': fileInput.click(); break;
      case 'bp': if (t.dataset.id !== P.activeId) await setActive(t.dataset.id); break;
      case 'edit': S.editing = true; render(); break;
      case 'edit-cancel': S.editing = false; render(); break;
      case 'edit-save': {
        const f = (k) => $panel.querySelector(`[data-f="${k}"]`).value;
        bp.name = f('name').trim() || bp.name;
        bp.width = Math.max(200, Math.round(+f('width') || bp.width));
        bp.scale = +f('scale') || 1;
        bp.vh = +f('vh') || null;
        bp.offsetX = Math.round(+f('offsetX') || 0);
        bp.offsetY = Math.round(+f('offsetY') || 0);
        bp.figmaUrl = f('figmaUrl').trim() || undefined;
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
      case 'invert': e.preventDefault(); P.overlay.invert = !P.overlay.invert; saveProject(); render(); renderOverlay(); break;
      case 'align': e.preventDefault(); P.overlay.align = P.overlay.align === 'center' ? 'left' : 'center'; saveProject(); render(); renderOverlay(); break;
      case 'match':
        e.preventDefault();
        P.viewport.match = !P.viewport.match;
        saveProject();
        render();
        if (P.viewport.match) applyViewport();
        else { chrome.runtime.sendMessage({ type: 'parity:viewport-release' }); setTimeout(renderOverlay, 200); }
        break;
      case 'vpmode': P.viewport.mode = t.dataset.v; saveProject(); render(); applyViewport(); break;
      case 'freeze': e.preventDefault(); P.freeze = !P.freeze; saveProject(); ParityCollect.setFreeze(P.freeze); render(); break;
      case 'analyze': runAnalyze(false); break;
      case 'analyze-all': runAnalyze(true); break;
      case 'issues': e.preventDefault(); P.showIssues = !P.showIssues; saveProject(); render(); renderIssues(); break;
      case 'issue': flashIssue(t.dataset.id); break;
      case 'open-report': chrome.runtime.sendMessage({ type: 'parity:open-report', key: S.key, bpIds: [bp.id], scope: P.scope || null }); break;
      case 'settings': S.showSettings = !S.showSettings; render(); break;
      case 'pick': togglePick(); break;
      case 'scope-pick': if (PK.on) stopPick(); startPick('scope'); break;
      case 'scope-clear': P.scope = null; saveProject(); drawnFor = null; await loadReport(); render(); renderOverlay(); renderIssues(); break;
      case 'scope-align': e.preventDefault(); P.scopeAlign = P.scopeAlign === false; saveProject(); drawnFor = null; render(); renderOverlay(); break;
      case 'sec-add': replaceTarget = 'section'; fileInput.click(); break;
      case 'sec-remove': {
        const sec = sectionImg(bp);
        if (sec) { store.del('img:' + sec.imgId); delete bp.sections[P.scope.selector]; saveProject(); drawnFor = null; render(); renderOverlay(); }
        break;
      }
      case 'set-autosave': e.preventDefault(); S.settings.autoSave = !S.settings.autoSave; store.set(SETTINGS_KEY, S.settings); render(); break;
      case 'set-images': e.preventDefault(); S.settings.saveImages = !S.settings.saveImages; store.set(SETTINGS_KEY, S.settings); render(); break;
      case 'set-keys': e.preventDefault(); S.settings.keys = !S.settings.keys; store.set(SETTINGS_KEY, S.settings); render(); break;
      case 'content-mode': e.preventDefault(); P.contentMode = P.contentMode === 'tolerant' ? 'same' : 'tolerant'; saveProject(); render(); toast(P.contentMode === 'tolerant' ? 'Content-tolerant: only position, box edges and type are compared' : 'Same-content mode'); break;
      case 'unignore': P.ignore.splice(+t.dataset.i, 1); saveProject(); render(); renderIssues(); break;
      case 'collapse': P.panel.collapsed = true; saveProject(); render(); break;
      case 'close': close(); break;
      default: break;
    }
  }

  function confirmInline(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    btn.style.color = '#ff5c74';
    btn.title = 'Click again to delete';
    toast('Click the bin again to delete this breakpoint');
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
    } else if (t.dataset.s && e.type === 'change') {
      const k = t.dataset.s;
      S.settings[k] = k === 'tolerance' ? Math.max(0, Math.min(20, +t.value || 0)) : k === 'figmaToken' ? t.value.trim() : t.value.replace(/[^\w.-]/g, '') || 'parity';
      store.set(SETTINGS_KEY, S.settings);
    }
  }

  // ---------- analyze ----------

  async function runAnalyze(all) {
    const bp = activeBp();
    if (!bp || S.busy) return;
    S.busy = true;
    S.status = S.proj.scope ? 'Capturing (section scope)…' : 'Capturing full page…';
    render();
    const bps = all ? S.proj.breakpoints : [bp];
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'parity:analyze',
        key: S.key,
        bps: bps.map((b) => {
          const sec = S.proj.scope && b.sections ? b.sections[S.proj.scope.selector] : null;
          return { id: b.id, name: b.name, width: b.width, vh: b.vh, scale: b.scale, offsetX: b.offsetX || 0, offsetY: b.offsetY || 0, imgId: b.imgId, imgW: b.imgW, imgH: b.imgH, file: b.file, sectionImgId: sec ? sec.imgId : undefined, sectionFile: sec ? sec.file : undefined };
        }),
        viewport: { match: S.proj.viewport.match, bp: { width: bp.width, vh: bp.vh, mode: S.proj.viewport.mode } },
        scope: S.proj.scope || null,
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Capture failed');
      S.status = 'Report opened in a new tab — analysis runs there.';
    } catch (e) {
      S.status = '';
      toast(String(e.message || e), true);
    } finally {
      S.busy = false;
      render();
      setTimeout(() => { if (S.status && S.status.startsWith('Report')) { S.status = ''; render(); } }, 6000);
    }
  }

  async function prepareCapture(msg) {
    stopPick();
    S.capturing = true;
    for (const h of [overlayHost, issuesHost, panelHost]) if (h) h.style.display = 'none';
    try {
      await ParityCollect.prepare();
      const res = ParityCollect.collect({ maxNodes: 4000, ignore: (S.proj && S.proj.ignore) || [] });
      let scopeBox = null;
      if (msg && msg.scope) {
        let el = null;
        try { el = document.querySelector(msg.scope.selector); } catch (e) { /* bad selector */ }
        if (el) { const r = el.getBoundingClientRect(); scopeBox = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }
      }
      return { ok: true, ...res, scopeBox };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  function captureDone() {
    S.capturing = false;
    if (!S.proj || !S.proj.freeze) ParityCollect.setFreeze(false);
    if (panelHost) panelHost.style.display = 'block';
    renderOverlay();
    renderIssues();
  }

  // ---------- element picker: click to copy classes ----------

  const PK = { on: false, el: null, stack: [], style: null, flashT: null, purpose: 'copy' };
  const pkBox = () => panelRoot && panelRoot.querySelector('.pbox');
  const pkTip = () => panelRoot && panelRoot.querySelector('.ptip');
  const classesOf = (el) => ((el.getAttribute && el.getAttribute('class')) || '').replace(/\s+/g, ' ').trim();
  const fromPanel = (e) => (e.composedPath ? e.composedPath() : []).includes(panelHost);

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

  function startPick(purpose) {
    if (PK.on || !S.open) return;
    PK.on = true;
    PK.purpose = purpose === 'scope' ? 'scope' : 'copy';
    PK.el = null;
    PK.stack = [];
    PK.style = document.createElement('style');
    PK.style.setAttribute('data-parity', '');
    PK.style.textContent = '*,*::before,*::after{cursor:crosshair!important}';
    (document.head || document.documentElement).appendChild(PK.style);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) window.addEventListener(t, pkBlock, true);
    window.addEventListener('pointermove', pkMove, true);
    toast(PK.purpose === 'scope' ? 'Click the section to debug on its own (↑ for the parent) · Esc to cancel' : 'Click: copy classes · ⇧ click: selector · ⌥ click: ignore in analysis · Esc to stop');
    render();
    renderIssues();
  }

  function stopPick() {
    if (!PK.on) return;
    PK.on = false;
    PK.el = null;
    PK.lock = null;
    if (PK.style) PK.style.remove();
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) window.removeEventListener(t, pkBlock, true);
    window.removeEventListener('pointermove', pkMove, true);
    const b = pkBox(), t = pkTip();
    if (b) b.style.display = 'none';
    if (t) t.style.display = 'none';
    if (S.open) { render(); renderIssues(); }
  }
  const togglePick = () => (PK.on ? stopPick() : startPick());

  function pkMove(e) {
    if (fromPanel(e)) { pkHover(null); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest('[data-parity]') || el === document.documentElement) { pkHover(null); return; }
    // after ↑/↓ keep the chosen ancestor until the pointer really moves
    if (PK.lock && Math.hypot(e.clientX - PK.lock.x, e.clientY - PK.lock.y) < 8) { pkPlaceTip(e.clientX, e.clientY); return; }
    PK.lock = null;
    if (el !== PK.el) { PK.stack = []; pkHover(el, e.clientX, e.clientY); }
    else pkPlaceTip(e.clientX, e.clientY);
  }

  let pkMouse = { x: 0, y: 0 };
  function pkHover(el, mx, my) {
    PK.el = el;
    const b = pkBox(), t = pkTip();
    if (!b || !t) return;
    if (!el) { b.style.display = 'none'; t.style.display = 'none'; return; }
    if (mx != null) pkMouse = { x: mx, y: my };
    const r = el.getBoundingClientRect();
    Object.assign(b.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const cls = classesOf(el);
    const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    t.className = 'ptip';
    t.innerHTML = `<span class="sz">${Math.round(r.width)}×${Math.round(r.height)}</span><span class="tg2">${esc(tag)}</span>
      <div class="cl ${cls ? '' : 'none'}">${cls ? esc(cls) : 'no classes — click copies the selector'}</div>
      <div class="hk">${PK.purpose === 'scope' ? '<b>click</b> debug this section on its own · <b>↑ ↓</b> parent/child · <b>Esc</b> cancel' : `<b>click</b> copy classes · <b>⇧ click</b> selector · <b>⌥ click</b> ${pkIgnoredSel(el) ? 'un-ignore' : 'ignore in analysis'} · <b>↑ ↓</b> parent/child · <b>Esc</b> exit`}</div>`;
    t.style.display = 'block';
    pkPlaceTip(pkMouse.x, pkMouse.y);
  }

  function pkPlaceTip(mx, my) {
    const t = pkTip();
    if (!t || t.style.display === 'none') return;
    pkMouse = { x: mx, y: my };
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = mx + 14, y = my + 18;
    if (x + w > window.innerWidth - 8) x = Math.max(8, mx - w - 14);
    if (y + h > window.innerHeight - 8) y = Math.max(8, my - h - 14);
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }

  function pkRefresh() {
    if (PK.on && PK.el && PK.el.isConnected) pkHover(PK.el);
  }

  // which ignore entry covers this element (itself or an ancestor)
  function pkIgnoredSel(el) {
    for (const sel of (S.proj && S.proj.ignore) || []) {
      try { if (el.closest(sel)) return sel; } catch (e) { /* bad selector */ }
    }
    return null;
  }

  async function pkBlock(e) {
    if (!PK.on || fromPanel(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click' || !PK.el) return;
    const el = PK.el;
    const cls = classesOf(el);
    if (PK.purpose === 'scope') {
      const sel = ParityCollect.uniqueSelector(el);
      const t = (el.getAttribute('aria-label') || el.querySelector('h1,h2,h3')?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      S.proj.scope = { selector: sel, label: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${t ? ' · ' + t : ''}` };
      saveProject();
      stopPick();
      drawnFor = null;
      await loadReport();
      render();
      renderOverlay();
      renderIssues();
      toast('Scope set — Analyze now checks this section on its own');
      return;
    }
    if (e.altKey) {
      const hit = pkIgnoredSel(el);
      if (hit) { S.proj.ignore = S.proj.ignore.filter((x) => x !== hit); toast('No longer ignored: ' + hit); }
      else {
        const sel = ParityCollect.uniqueSelector(el);
        S.proj.ignore = [...(S.proj.ignore || []), sel];
        toast('Ignored in analysis: ' + sel);
      }
      saveProject();
      renderIssues();
      pkRefresh();
      if (S.showSettings) render();
      return;
    }
    const useSel = e.shiftKey || !cls;
    const text = useSel ? ParityCollect.uniqueSelector(el) : cls;
    const ok = await copyText(text);
    const b = pkBox(), t = pkTip();
    if (ok) {
      if (b) { b.classList.add('copied'); }
      if (t) {
        t.classList.add('ok');
        const c = t.querySelector('.cl');
        if (c) { c.classList.remove('none'); c.textContent = `Copied ${useSel ? 'selector' : 'classes'} ✓  ${text}`; }
      }
      clearTimeout(PK.flashT);
      PK.flashT = setTimeout(() => { if (b) b.classList.remove('copied'); pkRefresh(); }, 1100);
    } else toast('Clipboard blocked by the page — focus the page and try again', true);
  }

  function pkKey(e) {
    if (e.key === 'Escape') { stopPick(); return true; }
    if (!PK.el) return e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (e.key === 'ArrowUp' && !e.altKey) {
      const p = PK.el.parentElement;
      if (p && p !== document.documentElement) { PK.stack.push(PK.el); const keep = PK.stack; pkHover(p); PK.stack = keep; PK.lock = { ...pkMouse }; }
      return true;
    }
    if (e.key === 'ArrowDown' && !e.altKey) {
      const c = PK.stack.pop() || PK.el.firstElementChild;
      if (c) { const keep = PK.stack; pkHover(c); PK.stack = keep; PK.lock = { ...pkMouse }; }
      return true;
    }
    return false;
  }

  // ---------- keyboard ----------

  function editable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }
  function onKey(e) {
    if (!S.open || !S.proj || S.capturing) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.some((n) => n && n.tagName && editable(n))) return;
    if (editable(document.activeElement) && document.activeElement !== panelHost) return;
    if (e.metaKey || e.ctrlKey) return;
    if (PK.on && pkKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    const bp = activeBp();
    const P = S.proj;
    // Alt+arrows: nudge overlay
    if (e.altKey && /^Arrow/.test(e.key) && bp) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') bp.offsetX = (bp.offsetX || 0) - step;
      if (e.key === 'ArrowRight') bp.offsetX = (bp.offsetX || 0) + step;
      if (e.key === 'ArrowUp') bp.offsetY = (bp.offsetY || 0) - step;
      if (e.key === 'ArrowDown') bp.offsetY = (bp.offsetY || 0) + step;
      e.preventDefault();
      e.stopPropagation();
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
    } else if (k === 'h') { P.overlay.visible = !P.overlay.visible; render(); renderOverlay(); }
    else if (k === 'd') { P.overlay.mode = P.overlay.mode === 'difference' ? 'normal' : 'difference'; P.overlay.visible = true; render(); renderOverlay(); }
    else if (k === 's') { P.overlay.mode = P.overlay.mode === 'split' ? 'normal' : 'split'; P.overlay.visible = true; render(); renderOverlay(); }
    else if (k === 'i') { P.overlay.invert = !P.overlay.invert; render(); renderOverlay(); }
    else if (k === 'c') { togglePick(); }
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
      pkRefresh();
    });
  }
  let resizeT;
  function onResize() {
    onScrollResize();
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { renderOverlay(); renderIssues(); }, 150);
  }
  let pathT;
  let issueT;

  async function open() {
    if (S.open) return;
    S.open = true;
    S.key = projectKey();
    await loadProject();
    ensureHosts();
    keeper.observe(document.documentElement, { childList: true });
    if (!S.proj.activeId && S.proj.breakpoints[0]) S.proj.activeId = S.proj.breakpoints[0].id;
    await loadReport();
    render();
    await renderOverlay();
    renderIssues();
    if (S.proj.freeze) ParityCollect.setFreeze(true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('scroll', onScrollResize, { passive: true });
    window.addEventListener('resize', onResize);
    applyViewport();
    pathT = setInterval(async () => {
      if (projectKey() !== S.key) {
        S.key = projectKey();
        await loadProject();
        drawnFor = null;
        await loadReport();
        render();
        renderOverlay();
        renderIssues();
      }
    }, 1000);
    issueT = setInterval(() => {
      if (S.proj && S.proj.showIssues && S.report) renderIssues();
      if (S.proj && S.proj.scope && S.proj.scopeAlign !== false && S.proj.overlay.visible) renderOverlay();
    }, 1500);
  }

  function close() {
    stopPick();
    S.open = false;
    keeper.disconnect();
    removeHosts();
    ParityCollect.setFreeze(false);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('paste', onPaste, true);
    window.removeEventListener('scroll', onScrollResize);
    window.removeEventListener('resize', onResize);
    clearInterval(pathT);
    clearInterval(issueT);
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
      case 'parity:measure':
        sendResponse({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, clientWidth: document.documentElement.clientWidth, dpr: window.devicePixelRatio });
        return false;
      case 'parity:prepare-capture':
        prepareCapture(msg).then(sendResponse);
        return true;
      case 'parity:capture-done':
        captureDone();
        sendResponse({ ok: true });
        return false;
      case 'parity:progress':
        S.status = msg.label;
        render();
        sendResponse({ ok: true });
        return false;
      case 'parity:analyze-shortcut':
        (async () => {
          if (!S.open) await open();
          runAnalyze(false);
        })();
        sendResponse({ ok: true });
        return false;
      case 'parity:report-ready':
        (async () => {
          if (!S.open || !S.proj) return;
          if (msg.key !== S.key || (msg.sk || '') !== sk()) return;
          if (S.proj.activeId === msg.bpId) {
            await loadReport();
            render();
            renderIssues();
          }
        })();
        sendResponse({ ok: true });
        return false;
      case 'parity:detached':
        if (S.open && S.proj && S.proj.viewport.match && S.proj.viewport.mode === 'emulate') {
          S.proj.viewport.match = false;
          saveProject();
          render();
          toast('Viewport emulation was cancelled — toggle "Match viewport" to resume.');
          setTimeout(() => { renderOverlay(); renderIssues(); }, 200);
        }
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
