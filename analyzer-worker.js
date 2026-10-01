/* Parity — analysis worker: decodes the capture + design JPEG, runs ParityCore.analyze. */
importScripts('analyzer-core.js');

async function toBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

self.onmessage = async (e) => {
  const { id, cap, designUrl, sectionUrl, bp, tolerance, contentMode } = e.data;
  const post = (type, extra) => self.postMessage({ id, type, ...extra });
  try {
    post('progress', { p: 0, label: 'Decoding screenshot' });
    const W = cap.width;
    const H = cap.shots.reduce((m, s) => Math.max(m, s.y + s.h), 0);
    const ca = new OffscreenCanvas(W, H);
    const cx = ca.getContext('2d', { willReadFrequently: true });
    for (const s of cap.shots) {
      const bmp = await toBitmap(s.data);
      cx.drawImage(bmp, 0, s.y, W, s.h);
      bmp.close();
    }
    const actual = { w: W, h: H, rgba: cx.getImageData(0, 0, W, H).data };

    post('progress', { p: 0.01, label: 'Decoding design' });
    const dbmp = await toBitmap(cap.scope && sectionUrl ? sectionUrl : designUrl);
    let design, designIsSection = false;
    if (cap.scope && sectionUrl) {
      // section-only export: drawn at the section's x/width, its top at row 16 (see analyzeScoped)
      const box = cap.scope.box, pad = 16;
      const sh = Math.round((dbmp.height * box.w) / dbmp.width);
      const cd = new OffscreenCanvas(W, sh + 2 * pad);
      const dx = cd.getContext('2d', { willReadFrequently: true });
      dx.fillStyle = '#fff';
      dx.fillRect(0, 0, W, sh + 2 * pad);
      dx.imageSmoothingQuality = 'high';
      dx.drawImage(dbmp, box.x, pad, box.w, sh);
      design = { w: W, h: sh + 2 * pad, rgba: dx.getImageData(0, 0, W, sh + 2 * pad).data };
      designIsSection = true;
    } else {
      const dh = Math.round((dbmp.height * W) / dbmp.width) + Math.max(0, bp.offsetY || 0);
      const cd = new OffscreenCanvas(W, dh);
      const dx = cd.getContext('2d', { willReadFrequently: true });
      dx.fillStyle = '#fff';
      dx.fillRect(0, 0, W, dh);
      dx.imageSmoothingEnabled = true;
      dx.imageSmoothingQuality = 'high';
      dx.drawImage(dbmp, bp.offsetX || 0, bp.offsetY || 0, W, Math.round((dbmp.height * W) / dbmp.width));
      design = { w: W, h: dh, rgba: dx.getImageData(0, 0, W, dh).data };
    }
    const designNatural = { w: dbmp.width, h: dbmp.height };
    dbmp.close();

    const args = {
      actual,
      design,
      nodes: cap.nodes,
      meta: { tolerance, vh: cap.vh, contentMode },
      onProgress: (p, label) => post('progress', { p, label }),
    };
    const result = cap.scope ? ParityCore.analyzeScoped({ ...args, scope: cap.scope, designIsSection }) : ParityCore.analyze(args);
    if (result.scope) {
      // aligned crops for the report viewer (row 0 = section top in both)
      const toUrl = (img, y, h, type) => {
        const c = new OffscreenCanvas(img.w, h);
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset + y * img.w * 4, h * img.w * 4), img.w, h), 0, 0);
        return c.convertToBlob({ type, quality: 0.9 }).then((b) => new FileReaderSync().readAsDataURL(b));
      };
      const cs = result.scope.crop;
      result.cropImages = {
        site: await toUrl(actual, cs.site.y, cs.site.h, 'image/png'),
        design: await toUrl(design, cs.design.y, cs.design.h, 'image/jpeg'),
      };
    }
    result.designNatural = designNatural;
    post('done', { result });
  } catch (err) {
    post('error', { error: String((err && err.stack) || err) });
  }
};
