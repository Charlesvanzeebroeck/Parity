/* Parity — service worker: panel toggling, viewport emulation, full-page capture. */

const REPORT_URL = chrome.runtime.getURL('report.html');
const CAPTURE_SEGMENT = 4000;
const MAX_CAPTURE_HEIGHT = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- per-tab state (session storage survives SW restarts) ----------

async function getState() {
  const { tabs = {} } = await chrome.storage.session.get('tabs');
  return tabs;
}
async function patchTab(tabId, patch) {
  const tabs = await getState();
  if (patch === null) delete tabs[tabId];
  else tabs[tabId] = { ...(tabs[tabId] || {}), ...patch };
  await chrome.storage.session.set({ tabs });
  return tabs[tabId];
}

// ---------- injection ----------

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['collect.js', 'content.js'] });
}

async function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function togglePanel(tab) {
  if (!tab || !tab.id) return;
  if (!/^(https?|file):/.test(tab.url || '')) {
    // chrome:// pages, the Web Store etc. cannot be scripted
    return;
  }
  try {
    await inject(tab.id);
  } catch (e) {
    console.warn('Parity: cannot inject', e);
    return;
  }
  const res = await send(tab.id, { type: 'parity:toggle' });
  await patchTab(tab.id, { open: !!(res && res.open) });
  if (res && !res.open) await releaseViewport(tab.id);
}

chrome.action.onClicked.addListener((tab) => togglePanel(tab));

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'analyze' || !tab) return;
  try {
    await inject(tab.id);
    await send(tab.id, { type: 'parity:analyze-shortcut' });
  } catch (e) { /* ignore */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const st = (await getState())[tabId];
  if (!st || !st.open) return;
  try {
    await inject(tabId);
    await send(tabId, { type: 'parity:open' });
  } catch (e) { /* page not scriptable */ }
});

chrome.tabs.onRemoved.addListener((tabId) => { patchTab(tabId, null); });

// ---------- debugger / emulation ----------

const attached = new Set();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Already attached by us (SW restarted) is fine; anything else is a real error.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
    } catch (e2) {
      throw new Error('Could not attach to the tab (is DevTools device mode or another debugger extension active?): ' + e.message);
    }
  }
  attached.add(tabId);
  await sleep(250); // let the "is debugging this browser" bar settle
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

chrome.debugger.onDetach.addListener(async (source) => {
  if (!source.tabId) return;
  attached.delete(source.tabId);
  await patchTab(source.tabId, { emulating: false });
  try { await send(source.tabId, { type: 'parity:detached' }); } catch (e) { /* ignore */ }
});

async function nativeSize(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let zoom = 1;
  try { zoom = await chrome.tabs.getZoom(tabId); } catch (e) { /* ignore */ }
  return { w: Math.round(tab.width / zoom), h: Math.round(tab.height / zoom), zoom, windowId: tab.windowId, tabW: tab.width };
}

async function emulate(tabId, { width, vh, dsf, fit }) {
  await ensureAttached(tabId);
  const nat = await nativeSize(tabId);
  const scale = fit ? Math.min(1, nat.w / width) : 1;
  const height = Math.max(200, Math.round(vh || nat.h / scale));
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dsf == null ? 0 : dsf, mobile: false, scale,
    screenWidth: width, screenHeight: height,
  });
  try { await cdp(tabId, 'Emulation.setScrollbarsHidden', { hidden: true }); } catch (e) { /* older chrome */ }
  await patchTab(tabId, { emulating: true, width });
  return { mode: 'emulate', scale, height };
}

async function releaseViewport(tabId) {
  if (!attached.has(tabId)) {
    // maybe attached before a SW restart
    try { await chrome.debugger.detach({ tabId }); } catch (e) { /* not attached */ }
    await patchTab(tabId, { emulating: false });
    return;
  }
  try { await cdp(tabId, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
  try { await cdp(tabId, 'Emulation.setScrollbarsHidden', { hidden: false }); } catch (e) { /* ignore */ }
  try { await cdp(tabId, 'Emulation.setEmulatedMedia', { features: [] }); } catch (e) { /* ignore */ }
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* ignore */ }
  attached.delete(tabId);
  await patchTab(tabId, { emulating: false });
}

async function resizeWindow(tabId, width) {
  if (attached.has(tabId)) {
    try { await cdp(tabId, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
  }
  const nat = await nativeSize(tabId);
  const win = await chrome.windows.get(nat.windowId);
  if (win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
  const w0 = (await chrome.windows.get(win.id)).width;
  const target = Math.round(w0 + (width * nat.zoom - nat.tabW));
  await chrome.windows.update(win.id, { width: target });
  await sleep(250);
  // one correction pass (window chrome / scrollbar differences)
  const m = await send(tabId, { type: 'parity:measure' });
  if (m && Math.abs(m.innerWidth - width) >= 1) {
    const cur = (await chrome.windows.get(win.id)).width;
    await chrome.windows.update(win.id, { width: Math.round(cur + (width - m.innerWidth) * nat.zoom) });
    await sleep(200);
  }
  const m2 = await send(tabId, { type: 'parity:measure' });
  return { mode: 'window', achieved: m2 && m2.innerWidth };
}

async function applyViewport(tabId, { width, vh, mode }) {
  if (mode === 'window' && width >= 500) {
    await releaseViewport(tabId);
    return resizeWindow(tabId, width);
  }
  return emulate(tabId, { width, vh, dsf: 0, fit: true });
}

// ---------- capture ----------

// storage-key suffix for a section scope ('' = whole page); same hash in content.js / report.js
function scopeKey(scope) {
  if (!scope || !scope.selector) return '';
  let h = 2166136261 >>> 0;
  for (let i = 0; i < scope.selector.length; i++) { h ^= scope.selector.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return '@' + h.toString(36);
}

async function captureBreakpoint(tabId, key, bp, scope) {
  const W = Math.round(bp.width);
  await ensureAttached(tabId);
  const nat = await nativeSize(tabId);
  const vh = Math.round(bp.vh || nat.h);
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: W, height: vh, deviceScaleFactor: 1, mobile: false, scale: 1, screenWidth: W, screenHeight: vh,
  });
  try { await cdp(tabId, 'Emulation.setScrollbarsHidden', { hidden: true }); } catch (e) { /* ignore */ }
  try { await cdp(tabId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); } catch (e) { /* ignore */ }
  await sleep(350);

  const prep = await send(tabId, { type: 'parity:prepare-capture', scope });
  if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'Page did not respond to capture preparation');
  const H = Math.min(MAX_CAPTURE_HEIGHT, Math.ceil(prep.docHeight));
  const shots = [];
  try {
    for (let y = 0; y < H; y += CAPTURE_SEGMENT) {
      const h = Math.min(CAPTURE_SEGMENT, H - y);
      const r = await cdp(tabId, 'Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, fromSurface: true,
        clip: { x: 0, y, width: W, height: h, scale: 1 },
      });
      shots.push({ y, h, data: 'data:image/png;base64,' + r.data });
    }
  } finally {
    try { await cdp(tabId, 'Emulation.setEmulatedMedia', { features: [] }); } catch (e) { /* ignore */ }
    try { await send(tabId, { type: 'parity:capture-done' }); } catch (e) { /* ignore */ }
  }

  const tab = await chrome.tabs.get(tabId);
  const cap = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    capturedAt: new Date().toISOString(),
    url: tab.url,
    title: tab.title,
    tabId,
    key,
    bp,
    width: W,
    vh,
    docHeight: prep.docHeight,
    truncated: prep.docHeight > MAX_CAPTURE_HEIGHT || prep.truncated,
    nodes: prep.nodes,
    breakpoints: prep.breakpoints,
    shots,
  };
  if (scope) {
    if (!prep.scopeBox) throw new Error(`Section ${scope.selector} is not on the page at ${W}px`);
    cap.scope = { selector: scope.selector, label: scope.label, box: prep.scopeBox };
  }
  await chrome.storage.local.set({ [`cap:${key}:${bp.id}${scopeKey(scope)}`]: cap });
  return cap;
}

async function analyze(tabId, key, bps, viewport, scope) {
  const results = [];
  try {
    for (const bp of bps) {
      await send(tabId, { type: 'parity:progress', label: `Capturing ${bp.width}px…` }).catch(() => {});
      results.push(await captureBreakpoint(tabId, key, bp, scope));
    }
  } finally {
    // restore interactive viewport
    try {
      if (viewport && viewport.match && viewport.bp) await applyViewport(tabId, viewport.bp);
      else await releaseViewport(tabId);
    } catch (e) { /* ignore */ }
  }
  await openReport(tabId, key, bps.map((b) => b.id), scopeKey(scope));
  return { ok: true, count: results.length };
}

async function openReport(tabId, key, bpIds, sk) {
  const url = `${REPORT_URL}?k=${encodeURIComponent(key)}&b=${bpIds.join(',')}&t=${tabId}${sk ? '&s=' + encodeURIComponent(sk) : ''}`;
  const existing = await chrome.tabs.query({ url: REPORT_URL + '*' });
  const same = existing.find((t) => {
    try {
      const u = new URL(t.url);
      return u.searchParams.get('k') === key;
    } catch (e) { return false; }
  });
  const src = await chrome.tabs.get(tabId);
  if (same) {
    await chrome.tabs.update(same.id, { url, active: true });
    await chrome.windows.update(same.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url, index: src.index + 1, windowId: src.windowId, active: true });
  }
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  (async () => {
    switch (msg.type) {
      case 'parity:viewport':
        return applyViewport(tabId, msg);
      case 'parity:viewport-release':
        await releaseViewport(tabId);
        return { ok: true };
      case 'parity:analyze':
        return analyze(tabId, msg.key, msg.bps, msg.viewport, msg.scope || null);
      case 'parity:open-report':
        await openReport(tabId, msg.key, msg.bpIds, scopeKey(msg.scope));
        return { ok: true };
      case 'parity:closed':
        await patchTab(tabId, { open: false });
        await releaseViewport(tabId);
        return { ok: true };
      case 'parity:download': {
        const id = await chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'overwrite', saveAs: false });
        return { ok: true, id };
      }
      default:
        return undefined;
    }
  })().then(
    (r) => sendResponse(r === undefined ? { ok: true } : { ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
