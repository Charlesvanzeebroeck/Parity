/* Parity — service worker: injection, panel toggle, re-open after reload, viewport control, downloads. */
importScripts('shared.js');

const FILES = ['shared.js', 'edits-core.js', 'page.js', 'editor.js', 'content.js'];
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

const scriptable = (tab) => tab && tab.id && /^(https?|file):/.test(tab.url || '');
const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: FILES });
const send = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg);

async function togglePanel(tab) {
  if (!scriptable(tab)) return; // chrome:// pages, the Web Store etc.
  try { await inject(tab.id); } catch (e) { console.warn('Parity: cannot inject', e); return; }
  const res = await send(tab.id, { type: 'parity:toggle' });
  await patchTab(tab.id, { open: !!(res && res.open) });
  if (res && !res.open) await releaseViewport(tab.id);
}

chrome.action.onClicked.addListener((tab) => togglePanel(tab));

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'edit' || !scriptable(tab)) return;
  try {
    await inject(tab.id);
    await send(tab.id, { type: 'parity:edit-shortcut' });
    await patchTab(tab.id, { open: true });
  } catch (e) { /* not scriptable */ }
});

// re-open after a reload, so hand edits come back with the page
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

// ---------- viewport: CDP emulation (exact width) or window resize ----------

const attached = new Set();

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); } // already ours (SW restarted)
    catch (e2) { throw new Error('Could not attach to the tab (is DevTools device mode or another debugger extension active?): ' + e.message); }
  }
  attached.add(tabId);
  await sleep(250); // let the "is debugging this browser" bar settle
}
const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params || {});

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

async function emulate(tabId, { width, vh }) {
  await ensureAttached(tabId);
  const nat = await nativeSize(tabId);
  const scale = Math.min(1, nat.w / width);
  const height = Math.max(200, Math.round(vh || nat.h / scale));
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false, scale, screenWidth: width, screenHeight: height });
  try { await cdp(tabId, 'Emulation.setScrollbarsHidden', { hidden: true }); } catch (e) { /* older chrome */ }
  await patchTab(tabId, { emulating: true, width });
  return { mode: 'emulate', scale, height };
}

async function releaseViewport(tabId) {
  if (!attached.has(tabId)) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) { /* not attached */ }
    await patchTab(tabId, { emulating: false });
    return;
  }
  try { await cdp(tabId, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ }
  try { await cdp(tabId, 'Emulation.setScrollbarsHidden', { hidden: false }); } catch (e) { /* ignore */ }
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* ignore */ }
  attached.delete(tabId);
  await patchTab(tabId, { emulating: false });
}

async function resizeWindow(tabId, width) {
  if (attached.has(tabId)) { try { await cdp(tabId, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* ignore */ } }
  const nat = await nativeSize(tabId);
  const win = await chrome.windows.get(nat.windowId);
  if (win.state !== 'normal') await chrome.windows.update(win.id, { state: 'normal' });
  const w0 = (await chrome.windows.get(win.id)).width;
  await chrome.windows.update(win.id, { width: Math.round(w0 + (width * nat.zoom - nat.tabW)) });
  await sleep(250);
  const m = await send(tabId, { type: 'parity:measure' }); // one correction pass (window chrome, scrollbar)
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
  return emulate(tabId, { width, vh });
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
