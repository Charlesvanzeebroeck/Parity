const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const EXT = path.resolve(__dirname, '..');
(async () => {
  const ud = fs.mkdtempSync(require('os').tmpdir() + '/parity-ud-');
  const ctx = await chromium.launchPersistentContext(ud, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  let clicked = 0; await page.exposeFunction('noteClick', () => clicked++);
  await page.goto('http://localhost:8765/demo.html');
  await page.evaluate(() => document.querySelector('.btn').addEventListener('click', (e) => { e.preventDefault(); window.noteClick(); }));
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: 'http://localhost:8765/*' }); await togglePanel(t); });
  await page.waitForTimeout(600);
  await page.keyboard.press('c');
  await page.locator('.card h3').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(200); const h = await page.locator('.card h3').first().boundingBox();
  await page.mouse.move(h.x + 10, h.y + 8); await page.waitForTimeout(150);
  await page.screenshot({ path: 'shot-pick.png' }); console.log('tip:', await page.locator('parity-panel .ptip').textContent());
  await page.mouse.click(h.x + 10, h.y + 8); await page.waitForTimeout(300);
  console.log('clip (h3, no class → selector):', await page.evaluate(() => navigator.clipboard.readText()));
  const c = await page.locator('.card').nth(1).boundingBox();
  await page.mouse.move(c.x + 5, c.y + c.height - 6); await page.mouse.click(c.x + 5, c.y + c.height - 6); await page.waitForTimeout(300);
  console.log('clip (card):', await page.evaluate(() => navigator.clipboard.readText()));
  await page.screenshot({ path: 'shot-pick-copied.png' });
  // arrow up to parent then click
  await page.mouse.move(h.x + 10, h.y + 8); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(200); await page.screenshot({path:'shot-pick-parent.png'});
  console.log('clip after ↑↑ (moving mouse resets) :', await page.evaluate(() => navigator.clipboard.readText()));
  await page.evaluate(() => scrollTo(0,0)); await page.waitForTimeout(200); const b = await page.locator('.btn').first().boundingBox(); console.log('btn box', b);
  await page.mouse.move(b.x + 80, b.y + 23); await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Shift'); await page.waitForTimeout(300);
  console.log('clip shift (selector):', await page.evaluate(() => navigator.clipboard.readText()), 'page click handlers fired:', clicked);
  await page.keyboard.press('Escape');
  await page.mouse.click(b.x + 80, b.y + 23); await page.waitForTimeout(300);
  console.log('after Esc page click fired:', clicked);
  await ctx.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
