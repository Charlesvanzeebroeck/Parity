const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const core = require('../analyzer-core.js');
const VARIANT = process.env.VARIANT || `
header{padding:24px 48px}
.section h2{margin-bottom:28px}
.grid{gap:32px}
.btn{padding:16px 32px}
.card h3{font-size:24px}
.cta h2{color:#ffcf33}
`;
const W = +(process.env.W || 1440);
(async () => {
  const browser = await chromium.launch();
  const url = 'file://' + __dirname + '/' + (process.env.PAGE||'demo.html');
  // design
  const dctx = await browser.newContext({ viewport: { width: W, height: 900 }, deviceScaleFactor: 2 });
  const dp = await dctx.newPage();
  await dp.goto(url);
  await dp.addStyleTag({ content: VARIANT + '*{animation:none!important}' });
  if (process.env.VARJS) await dp.evaluate(process.env.VARJS);
  await dp.waitForTimeout(300);
  const fh = await dp.evaluate(() => document.documentElement.scrollHeight);
  if (process.env.SCOPE) await dp.locator(process.env.SCOPE).screenshot({ path: 'section.jpg', type: 'jpeg', quality: 85 });
  await dp.screenshot({ path: 'design.jpg', fullPage: true, clip: { x: 0, y: 0, width: W, height: fh }, type: 'jpeg', quality: 85 });
  // actual
  const ctx = await browser.newContext({ viewport: { width: W, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.addScriptTag({ path: require('path').join(__dirname, '../collect.js') });
  await page.evaluate(() => ParityCollect.prepare());
  const col = await page.evaluate(() => ParityCollect.collect());
  const cdp = await ctx.newCDPSession(page);
  const H = col.docHeight;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  fs.writeFileSync('actual.png', Buffer.from(shot.data, 'base64'));
  const vhAfter = await page.evaluate(() => [innerHeight, document.querySelector('.hero') && document.querySelector('.hero').getBoundingClientRect().height]);
  console.log('nodes', col.nodes.length, 'docH', H, 'vh/hero after capture', vhAfter);
  await browser.close();
  const a = await sharp('actual.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dmeta = await sharp('design.jpg').metadata();
  const dh = Math.round(dmeta.height * W / dmeta.width);
  const d = await sharp('design.jpg').resize(W, dh).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  console.log('actual', a.info.width, a.info.height, 'design', d.info.width, d.info.height);
  let scope = null, designIn = { w: d.info.width, h: d.info.height, rgba: d.data }, designIsSection = false;
  if (process.env.SCOPE) {
    scope = { selector: process.env.SCOPE, box: col.nodes.find((n) => n.sel === process.env.SCOPE).box };
    if (fs.existsSync('section.jpg') && process.env.SECTIONJPG) {
      const sm = await sharp('section.jpg').metadata();
      const sw = Math.round(sm.width / 2), shh = Math.round(sm.height / 2);
      const pad = 16;
      const canvas = await sharp({ create: { width: W, height: shh + 2 * pad, channels: 4, background: '#ffffff' } })
        .composite([{ input: await sharp('section.jpg').resize(sw, shh).toBuffer(), left: Math.round(scope.box.x), top: pad }]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      designIn = { w: canvas.info.width, h: canvas.info.height, rgba: canvas.data }; designIsSection = true;
    }
  }
  const t = Date.now();
  const input = { actual: { w: a.info.width, h: a.info.height, rgba: a.data }, design: designIn, nodes: col.nodes, meta: { tolerance: 2, debug: true, contentMode: process.env.MODE } };
  const rep = scope ? core.analyzeScoped({ ...input, scope, designIsSection }) : core.analyze(input);
  if (rep.scope) console.log('scope', JSON.stringify(rep.scope));
  console.log('ms', Date.now() - t, JSON.stringify(rep.stats));
  for (const i of rep.issues) console.log(`#${i.id}(${i.rank}) [${i.severity}] ${i.kind.join(',')} ${i.element.selector} :: ${i.summary} | d=${JSON.stringify(i.delta)} own=${JSON.stringify(i.ownShift && {x:i.ownShift.x,y:i.ownShift.y})} conf=${i.confidence}\n     -> ${(i.suggestions||[]).join(' / ')}${i.tailwind? ' TW:'+i.tailwind:''}`);
  fs.writeFileSync('report.json', JSON.stringify(rep, null, 1));
})();
