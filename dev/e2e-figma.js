const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '..');
(async () => {
  const ud = fs.mkdtempSync(require('os').tmpdir() + '/parity-ud-');
  const ctx = await chromium.launchPersistentContext(ud, { channel: 'chromium', headless: true, viewport: null, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1600,1000'] });
  const fake = { nodes: { '1:2': { document: { id: '1:2', name: 'Home 1440', type: 'FRAME', absoluteBoundingBox: { x: 1000, y: 500, width: 1440, height: 1987 }, children: [
    { id: '5:1', name: 'Grid', type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 32, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:9:1' } }, absoluteBoundingBox: { x: 1048, y: 500 + 1201, width: 1344, height: 208 }, children: [
      { id: '6:1', name: 'Card title', type: 'TEXT', characters: 'Brand identity', style: { fontSize: 24, lineHeightPx: 28.8, fontFamily: 'Arial', fontWeight: 700 }, styles: { text: 'S:abc' }, absoluteBoundingBox: { x: 1076, y: 500 + 1301, width: 159, height: 28 } } ] } ] }, styles: { 'S:abc': { name: 'H3 / Card' } } } } };
  await ctx.route('https://api.figma.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/variables/local')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ meta: { variables: { 'VariableID:9:1': { name: 'space/8' } } } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) });
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.goto('http://localhost:8765/demo.html');
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:8765/*' }); await togglePanel(t); });
  await page.waitForTimeout(600);
  await page.locator('parity-panel input[type=file]').setInputFiles([path.join(__dirname, 'design-1440.jpg')]);
  await page.waitForTimeout(1200);
  await page.locator('parity-panel [data-act=settings]').click();
  await page.locator('parity-panel [data-s=figmaToken]').fill('figd_test');
  await page.locator('parity-panel [data-s=figmaToken]').dispatchEvent('change');
  await page.locator('parity-panel [data-act=edit]').click();
  await page.locator('parity-panel [data-f=vh]').fill('900');
  await page.locator('parity-panel [data-f=figmaUrl]').fill('https://www.figma.com/design/AbC123xyz/Site?node-id=1-2&t=x');
  await page.locator('parity-panel [data-act=edit-save]').click();
  await page.waitForTimeout(500);
  const rp = ctx.waitForEvent('page', { timeout: 60000 });
  await page.locator('parity-panel button[data-act=analyze]').click();
  const report = await rp;
  await report.waitForFunction(() => document.getElementById('progress').hidden && document.querySelectorAll('.card').length > 0, null, { timeout: 120000 });
  const rep = await sw.evaluate(async () => { const all = await chrome.storage.local.get(null); return all[Object.keys(all).find((x) => x.startsWith('rep:'))]; });
  console.log('figma meta', JSON.stringify(rep.figma));
  for (const it of rep.issues.filter((i) => i.figma)) console.log(it.id, it.kind.join(), JSON.stringify(it.figma), '\n   ', it.suggestions[0], it.fontSize ? JSON.stringify(it.fontSize) : '');
  await ctx.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
