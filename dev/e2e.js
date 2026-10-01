const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '..');
(async () => {
  const ud = fs.mkdtempSync(require('os').tmpdir() + '/parity-ud-');
  const ctx = await chromium.launchPersistentContext(ud, {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1600,1000'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  console.log('ext', extId);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type()==='error') console.log('PAGE ERR', m.text()); });
  await page.goto('http://localhost:8765/demo.html');
  await page.waitForTimeout(500);
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:8765/*' }); await togglePanel(t); });
  await page.waitForTimeout(800);
  const panel = page.locator('parity-panel .panel');
  console.log('panel visible', await panel.isVisible());
  await page.screenshot({ path: 'shot-panel-empty.png' });
  // upload design (from earlier test: design.jpg is 2x of 1440 variant)
  await page.locator('parity-panel input[type=file]').setInputFiles([path.join(__dirname, 'design-1440.jpg'), path.join(__dirname, 'design-375.jpg')]);
  await page.waitForTimeout(1500);
  console.log('inner width after bp', await page.evaluate(() => innerWidth));
  await page.screenshot({ path: 'shot-panel-bp.png' });
  // click analyze
  const reportP = ctx.waitForEvent('page', { timeout: 60000 });
  console.log('chips', await page.locator('parity-panel .chip').allTextContents()); await page.locator('parity-panel button[data-act=analyze-all]').click();
  const report = await reportP;
  report.on('console', m => console.log('REPORT', m.type(), m.text()));
  report.on('pageerror', e => console.log('REPORT ERR', e.message));
  await report.waitForLoadState();
  await report.waitForFunction(() => document.getElementById('progress').hidden && document.querySelectorAll('.card').length > 0, null, { timeout: 120000 });
  await report.setViewportSize({ width: 1500, height: 950 });
  await report.waitForTimeout(800);
  await report.screenshot({ path: 'shot-report.png' });
  await report.waitForFunction(() => document.querySelectorAll('.tab .d.busy').length === 0, null, {timeout: 120000});
  console.log('tabs', await report.locator('.tab').allTextContents());
  await report.locator('.tab').nth(0).click(); await report.waitForTimeout(500); await report.screenshot({ path: 'shot-report-375.png' }); console.log('375 cards:\n' + (await report.locator('.card .sum').allTextContents()).join('\n')); await report.locator('.tab').nth(1).click(); await report.waitForTimeout(300);
  const cards = await report.locator('.card .sum').allTextContents();
  console.log(cards.join('\n'));
  await report.locator('.card').nth(0).click();
  await report.locator('#viewMode button[data-v=diff]').click();
  await report.waitForTimeout(500);
  await report.screenshot({ path: 'shot-report-diff.png' });
  // back to page, show issues
  await page.bringToFront();
  await page.waitForTimeout(800);
  const sw2 = page.locator('parity-panel [data-act=issues]');
  if (await sw2.count()) { await sw2.click(); await page.waitForTimeout(500); }
  await page.screenshot({ path: 'shot-page-issues.png' });
  // keyboard: switch to difference
  await page.keyboard.press('1'); await page.waitForTimeout(1200); console.log('width after key 1', await page.evaluate(() => innerWidth)); await page.screenshot({ path: 'shot-page-375.png' }); await page.keyboard.press('2'); await page.waitForTimeout(1200); await page.keyboard.press('d'); await page.waitForTimeout(300);
  await page.screenshot({ path: 'shot-page-diff.png' });
  const dl = await sw.evaluate(() => new Promise(r => chrome.downloads.search({}, r)));
  console.log('downloads', dl.map(d => d.filename + ' ' + d.state + ' ' + (d.error||'')));
  await ctx.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
