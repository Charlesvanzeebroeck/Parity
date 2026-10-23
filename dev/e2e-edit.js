// End-to-end: the live editor on dev/edit.html (strict CSP), driven with the real mouse and keyboard.
// Needs: a static server on :8765 serving dev/ (npm run serve), Playwright (npm i in dev/).
// Run: node dev/e2e-edit.js   (SHOTS=1 saves screenshots to dev/shot-edit-*.png)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Core = require('../edits-core.js');

const EXT = path.resolve(__dirname, '..');
const URL = process.env.URL || 'http://localhost:8765/edit.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

(async () => {
  const ud = fs.mkdtempSync(require('os').tmpdir() + '/parity-ud-');
  const ctx = await chromium.launchPersistentContext(ud, {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1440,1000', '--silent-debugger-extension-api'],
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL);
  await sleep(300);
  const pristine = await page.evaluate(() => document.body.outerHTML);

  const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(__dirname, `shot-edit-${name}.png`) }); };
  const P = (sel) => page.locator('parity-panel ' + sel);
  const rect = (sel, i = 0) => page.evaluate(([s, k]) => { const r = document.querySelectorAll(s)[k].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.right, b: r.bottom }; }, [sel, i]);
  const css = (sel, prop, i = 0) => page.evaluate(([s, p, k]) => getComputedStyle(document.querySelectorAll(s)[k]).getPropertyValue(p), [sel, prop, i]);
  const proj = () => sw.evaluate(async () => { const all = await chrome.storage.local.get(null); return Object.entries(all).find(([k]) => k.startsWith('proj:'))[1]; });
  const edits = async () => { await sleep(250); const p = await proj(); return p.breakpoints.find((b) => b.id === p.activeId).edits; };
  async function drag(x0, y0, x1, y1, { mod, steps = 12, tab = 0 } = {}) {
    await page.mouse.move(x0, y0);
    if (mod) await page.keyboard.down(mod);
    await page.mouse.down();
    await page.mouse.move(x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, { steps: 4 });
    for (let i = 0; i < tab; i++) { await page.keyboard.press('Tab'); await sleep(50); }
    await page.mouse.move(x1, y1, { steps });
    await sleep(60);
    await page.mouse.up();
    if (mod) await page.keyboard.up(mod);
    await sleep(200);
  }
  const step = (s) => console.log('·', s);

  // open, edit without a design at the current width
  await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u + '*' }); await togglePanel(t); }, URL);
  await sleep(700);
  await P('[data-act=add-live]').click();
  await sleep(500);
  // keep the panel out of the way of the page's right edge: collapse it, keys still work
  await P('[data-act=collapse]').click();
  await page.keyboard.press('e');
  await sleep(200);
  assert(await page.locator('parity-edit .bar').count(), 'edit bar visible');

  step('click selects, drag of the first child moves via parent padding-top');
  let h1 = await rect('.hero h1');
  await page.mouse.click(h1.x + 40, h1.cy);
  await sleep(150);
  assert(await page.locator('parity-edit .sel').count(), 'selection drawn');
  await drag(h1.x + 40, h1.cy, h1.x + 40, h1.cy + 20);
  let h1b = await rect('.hero h1');
  assert(Math.abs(h1b.y - h1.y - 20) <= 1, `h1 moved 20px (moved ${h1b.y - h1.y})`);
  let E = await edits();
  assert.deepStrictEqual(E.map((e) => [e.prop, e.from, e.to]), [['padding-top', '80px', '100px']]);
  assert(E[0].sel.includes('hero'), 'edit is on the parent section');
  assert.strictEqual(E[0].src, 'src/components/Hero.astro:2');
  await shot('move');

  step('grid: dragging card B → column-gap; cards follow the cursor whatever the gap/position ratio');
  let b = await rect('.card', 1);
  await page.mouse.click(b.x + 12, b.y + 12); // card padding area? click picks the card itself
  await sleep(100);
  await drag(b.x + 12, b.y + 12, b.x + 24, b.y + 12);
  E = await edits();
  assert.strictEqual(E[1].prop, 'column-gap');
  const b1 = await rect('.card', 1);
  assert(Math.abs(b1.x - b.x - 12) <= 1.5, `card B followed the cursor (${b1.x - b.x}px, gap ${E[1].to}: 1fr columns shrink as the gap grows)`);
  let c0 = await rect('.card', 2);
  await page.mouse.click(c0.x + 12, c0.y + 12);
  await drag(c0.x + 12, c0.y + 12, c0.x + 32, c0.y + 12, { steps: 20 });
  let c1 = await rect('.card', 2);
  E = await edits();
  assert.strictEqual(E.filter((e) => e.prop === 'column-gap').length, 1, 'same gap edit updated');
  assert(Math.abs(c1.x - c0.x - 20) <= 2, `card C followed the cursor (${c1.x - c0.x}px)`);
  assert.strictEqual(E[1].from, '24px');

  step('Tab while dragging switches the property');
  const s1 = await rect('.stack p', 1);
  await page.mouse.click(s1.x + 20, s1.cy);
  await drag(s1.x + 20, s1.cy, s1.x + 20, s1.cy + 10, { tab: 1 });
  E = await edits();
  assert.strictEqual(E.length, 3, 'stack drag recorded');
  const tabbed = E[2];
  assert.strictEqual(tabbed.prop, 'margin-top', 'Tab moved from previous margin-bottom to own margin-top');
  console.log('   stack p → ' + Core.describe(tabbed));
  await page.keyboard.press(`${MOD}+z`);
  E = await edits();
  assert(E.length === 2 && !E.some((e) => e.prop === 'margin-top'), 'undo removed it');

  step('padding strip: drag top padding of card A down 8px');
  const a = await rect('.card', 0);
  await page.mouse.click(a.x + 12, a.y + 12);
  await sleep(150);
  await drag(a.cx, a.y + 12, a.cx, a.y + 20);
  E = await edits();
  const pad = E.find((e) => e.prop === 'padding-top' && !e.sel.includes('hero'));
  assert(pad && pad.from === '24px' && pad.to === '32px', 'card padding-top 24 → 32');

  step('size: drag the right edge of the h1');
  h1 = await rect('.hero h1');
  await page.mouse.click(h1.x + 40, h1.cy);
  await drag(h1.r - 1, h1.cy, h1.r - 201, h1.cy);
  E = await edits();
  const w = E.find((e) => e.prop === 'width');
  assert(w && Math.abs(parseFloat(w.to) - (h1.w - 200)) <= 1, 'h1 width shrank by 200');

  step('keys: A = all similar, ] = font-size +1');
  const t0 = await rect('.card-title', 0);
  await page.mouse.click(t0.x + 5, t0.cy);
  await page.keyboard.press('a');
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  assert.strictEqual(await css('.card-title', 'font-size', 2), '24px', 'third title follows');
  E = await edits();
  const fs1 = E.find((e) => e.prop === 'font-size');
  assert.strictEqual(fs1.n, 3);
  assert.strictEqual(fs1.exact, 2);
  await page.keyboard.press('a');

  step('⌥ measure draws distances');
  await page.keyboard.down('Alt');
  const t1 = await rect('.card-title', 1);
  await page.mouse.move(t1.cx, t1.cy);
  await sleep(150);
  assert(await page.locator('parity-edit .ml').count() > 0, 'measure labels');
  await shot('measure');
  await page.keyboard.up('Alt');

  step('⌘-drag reorders cards');
  const ca = await rect('.card', 0), cb = await rect('.card', 1);
  await page.mouse.click(ca.x + 10, ca.y + 10);
  await drag(ca.x + 10, ca.y + 10, cb.r - 10, cb.cy, { mod: MOD });
  E = await edits();
  const ord = E.find((e) => e.kind === 'order');
  assert(ord, 'order edit');
  assert.deepStrictEqual(ord.to.map((x) => x.split(' ')[0]), ['#2', '#1', '#3']);
  const aAfter = await rect('.card', 0);
  assert(aAfter.x > cb.x - 5, 'card A now second');

  step('⌫ hides; B shows before');
  const badge = await rect('.badge');
  await page.mouse.click(badge.cx, badge.cy);
  await page.keyboard.press('Backspace');
  assert.strictEqual(await css('.badge', 'display'), 'none');
  await page.keyboard.press('b');
  await sleep(100);
  assert.strictEqual(await css('.badge', 'display'), 'block', 'before = original (absolute → block)');
  assert.strictEqual(await css('.hero', 'padding-top'), '80px');
  await page.keyboard.press('b');
  assert.strictEqual(await css('.hero', 'padding-top'), '100px');

  step('page re-render (hot reload) → edits re-applied');
  await page.evaluate(() => { const s = document.querySelector('#cards'); s.outerHTML = s.outerHTML.replace(/style="[^"]*"/g, ''); });
  await sleep(400);
  const gapNow = (await edits()).find((e) => e.prop === 'column-gap').to;
  assert.strictEqual(await css('#cards', 'column-gap'), gapNow);
  assert.strictEqual(await css('.card-title', 'font-size', 1), '24px');

  step('panel: inspector + export');
  await page.locator('parity-panel .pillbar').click();
  await sleep(200);
  const t2 = await rect('.card-title', 0);
  await page.mouse.click(t2.x + 5, t2.cy);
  await sleep(250);
  assert(await P('.ins2').count(), 'inspector shown');
  // scrub the line-height label: +12px drag right ≈ +6px
  const lab = P('.ins2 [data-scrub=line-height]');
  const lb = await lab.boundingBox();
  await drag(lb.x + lb.width / 2, lb.y + lb.height / 2, lb.x + lb.width / 2 + 12, lb.y + lb.height / 2, { steps: 6 });
  E = await edits();
  assert(E.find((e) => e.prop === 'line-height'), 'scrub recorded line-height');
  // type a value
  const inp = P('.ins2 input[data-p=letter-spacing]');
  await inp.click();
  await inp.fill('0.5');
  await inp.press('Enter');
  E = await edits();
  assert.strictEqual(E.find((e) => e.prop === 'letter-spacing').to, '0.5px');
  await shot('panel');
  await P('[data-e=copy-md]').click();
  await sleep(300);
  const md = await page.evaluate(() => navigator.clipboard.readText());
  console.log('\n' + md);
  assert(md.startsWith('# Parity edits · localhost:8765/edit.html'));
  assert(md.includes('padding-top 80 → 100px'));
  assert(md.includes('column-gap 24 → '));
  assert(md.includes('src/components/Hero.astro:2'));
  assert(md.includes('`text-[22px]` → `lg:text-2xl`') || md.includes('`text-[22px]` → `text-2xl`'));

  step('reload: edits come back');
  await page.reload();
  await sleep(1500);
  assert.strictEqual(await css('.hero', 'padding-top'), '100px');
  assert.strictEqual(await css('.badge', 'display'), 'none');

  step('close: page left untouched');
  await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u + '*' }); await togglePanel(t); }, URL);
  await sleep(500);
  const after = await page.evaluate(() => document.body.outerHTML);
  assert.strictEqual(after.replace(/\s+/g, ' '), pristine.replace(/\s+/g, ' '), 'DOM identical after close');
  assert.strictEqual(await css('.hero', 'padding-top'), '80px');
  assert.strictEqual(await page.locator('[data-parity]').count(), 0, 'no Parity nodes left');

  step('design overlay: JPEG, difference, move mode pauses editing');
  await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u + '*' }); await togglePanel(t); }, URL);
  await sleep(700);
  if (await P('.pillbar').count()) await P('.pillbar').click();
  await P('[data-act=add-menu]').click();
  await P('input[type=file]').setInputFiles(path.join(__dirname, 'design-1440.jpg'));
  await sleep(900);
  assert(await page.locator('parity-overlay').evaluate((h) => h.shadowRoot.querySelectorAll('canvas').length) > 0, 'overlay canvas drawn');
  await P('[data-act=tab][data-v=overlay]').click();
  await page.keyboard.press('d');
  assert.strictEqual(await page.locator('parity-overlay').evaluate((h) => h.style.mixBlendMode), 'difference');
  await page.keyboard.press('e');
  await sleep(150);
  assert(await page.locator('parity-edit .bar').count(), 'editing');
  await page.keyboard.press('m');
  await sleep(100);
  assert.strictEqual(await page.locator('parity-edit .bar').count(), 0, 'move mode stops editing');
  await page.keyboard.press('Escape');
  await shot('overlay');
  await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u + '*' }); await togglePanel(t); }, URL);
  await sleep(400);
  assert.strictEqual(await page.locator('[data-parity]').count(), 0, 'closed again');

  assert.deepStrictEqual(errors, [], 'no page errors');
  console.log('\nall e2e steps passed');
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
