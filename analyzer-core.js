/*
 * Parity analyzer core.
 * Pure image/geometry code: runs in a Web Worker (report page) and in Node for tests.
 *
 * Coordinates are CSS px in document space at the analyzed viewport width.
 * delta = expected (design) − actual (site). Positive y = element must move down,
 * positive h = element must be taller.
 */
(function (root) {
  'use strict';

  // ---------- image helpers ----------

  function toGray(rgba, w, h) {
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return g;
  }

  // separable [1 2 1]/4 blur
  function blur(g, w, h) {
    const t = new Uint8ClampedArray(w * h);
    const o = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const a = g[r + (x > 0 ? x - 1 : x)], b = g[r + x], c = g[r + (x < w - 1 ? x + 1 : x)];
        t[r + x] = (a + 2 * b + c + 2) >> 2;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : y) * w, r = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        o[r + x] = (t[up + x] + 2 * t[r + x] + t[dn + x] + 2) >> 2;
      }
    }
    return o;
  }

  function half(g, w, h) {
    const W = w >> 1, H = h >> 1;
    const o = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) {
      const r0 = 2 * y * w, r1 = r0 + w;
      for (let x = 0; x < W; x++) {
        const c = 2 * x;
        o[y * W + x] = (g[r0 + c] + g[r0 + c + 1] + g[r1 + c] + g[r1 + c + 1] + 2) >> 2;
      }
    }
    return { g: o, w: W, h: H };
  }

  function boxBlur(g, w, h, r) {
    const t = new Uint8ClampedArray(w * h), o = new Uint8ClampedArray(w * h);
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += g[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        t[row + x] = s / n;
        s += g[row + Math.min(w - 1, x + r + 1)] - g[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += t[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        o[y * w + x] = s / n;
        s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
    return o;
  }

  // band-pass: small blur minus local mean -> structure only (ignores gradients / flat fills)
  function highpass(g, w, h) {
    const lo = boxBlur(g, w, h, 6);
    const o = new Uint8ClampedArray(w * h);
    for (let i = 0; i < o.length; i++) o[i] = 128 + 2 * (g[i] - lo[i]);
    return o;
  }

  function pyramid(gray, w, h, levels) {
    const base = [{ g: blur(gray, w, h), w, h }];
    for (let l = 1; l < levels; l++) {
      const prev = base[l - 1];
      if (prev.w < 32 || prev.h < 32) break;
      const src = l === 1 ? prev.g : blur(prev.g, prev.w, prev.h);
      base.push(half(src, prev.w, prev.h));
    }
    return base.map((lv) => ({ g: highpass(lv.g, lv.w, lv.h), w: lv.w, h: lv.h }));
  }

  // ---------- template matching (zero-mean NCC on sampled points) ----------

  function makeTemplate(lv, x, y, w, h, maxN) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(lv.w, Math.ceil(x + w)), y1 = Math.min(lv.h, Math.ceil(y + h));
    const tw = x1 - x0, th = y1 - y0;
    if (tw < 2 || th < 2) return null;
    const stride = Math.max(1, Math.ceil(Math.sqrt((tw * th) / maxN)));
    const nx = Math.ceil(tw / stride), ny = Math.ceil(th / stride);
    const n = nx * ny;
    const px = new Int32Array(n), py = new Int32Array(n), t = new Float32Array(n);
    let k = 0, sum = 0;
    // offset the grid by half a stride so we don't always sample on edges
    const s0 = stride > 1 ? (stride >> 1) : 0;
    for (let yy = 0; yy < ny; yy++) {
      const ry = Math.min(th - 1, yy * stride + s0);
      for (let xx = 0; xx < nx; xx++) {
        const rx = Math.min(tw - 1, xx * stride + s0);
        px[k] = rx; py[k] = ry;
        const v = lv.g[(y0 + ry) * lv.w + x0 + rx];
        t[k] = v; sum += v; k++;
      }
    }
    const mean = sum / n;
    let norm = 0;
    for (let i = 0; i < n; i++) { t[i] -= mean; norm += t[i] * t[i]; }
    return { x0, y0, tw, th, n, px, py, t, norm: Math.sqrt(norm), std: Math.sqrt(norm / n) };
  }

  // Returns array of candidates sorted by effective score: {ox, oy, score}
  function search(T, D, cx, cy, rx, ry, lam, keep) {
    const minOx = Math.max(cx - rx, -T.x0), maxOx = Math.min(cx + rx, D.w - (T.x0 + T.tw));
    const minOy = Math.max(cy - ry, -T.y0), maxOy = Math.min(cy + ry, D.h - (T.y0 + T.th));
    if (minOx > maxOx || minOy > maxOy || T.norm < 1e-6) return [];
    const n = T.n, t = T.t, g = D.g, W = D.w;
    const off = new Int32Array(n);
    for (let i = 0; i < n; i++) off[i] = T.py[i] * W + T.px[i];
    const gw = maxOx - minOx + 1, gh = maxOy - minOy + 1;
    const grid = new Float32Array(gw * gh);
    for (let oy = minOy; oy <= maxOy; oy++) {
      for (let ox = minOx; ox <= maxOx; ox++) {
        const base = (T.y0 + oy) * W + T.x0 + ox;
        let s = 0, s2 = 0, st = 0;
        for (let i = 0; i < n; i++) {
          const v = g[base + off[i]];
          s += v; s2 += v * v; st += t[i] * v;
        }
        const varD = s2 - (s * s) / n;
        const score = varD > n * 0.25 ? st / (T.norm * Math.sqrt(varD)) : 0;
        grid[(oy - minOy) * gw + (ox - minOx)] = score;
      }
    }
    // pick local maxima
    const cands = [];
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const v = grid[j * gw + i];
        if (v <= 0.2) continue;
        let isMax = true;
        for (let dj = -1; dj <= 1 && isMax; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
            const u = grid[jj * gw + ii];
            if (u > v || (u === v && (dj < 0 || (dj === 0 && di < 0)))) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        const ox = i + minOx, oy = j + minOy;
        const eff = v - lam * (Math.abs(ox - cx) + Math.abs(oy - cy));
        cands.push({ ox, oy, score: v, eff });
      }
    }
    cands.sort((a, b) => b.eff - a.eff);
    return cands.slice(0, keep || 3);
  }

  // Search with the template scaled by s around its top-left anchor (L0 only).
  function searchScaled(T, D, cx, cy, r, sc) {
    const n = T.n, t = T.t, g = D.g, W = D.w;
    const off = new Int32Array(n);
    let maxX = 0, maxY = 0;
    for (let i = 0; i < n; i++) {
      const X = Math.round(T.px[i] * sc), Y = Math.round(T.py[i] * sc);
      off[i] = Y * W + X;
      if (X > maxX) maxX = X;
      if (Y > maxY) maxY = Y;
    }
    let best = null;
    for (let oy = cy - r; oy <= cy + r; oy++) {
      const y0 = T.y0 + oy;
      if (y0 < 0 || y0 + maxY >= D.h) continue;
      for (let ox = cx - r; ox <= cx + r; ox++) {
        const x0 = T.x0 + ox;
        if (x0 < 0 || x0 + maxX >= W) continue;
        const base = y0 * W + x0;
        let s = 0, s2 = 0, st = 0;
        for (let i = 0; i < n; i++) {
          const v = g[base + off[i]];
          s += v; s2 += v * v; st += t[i] * v;
        }
        const varD = s2 - (s * s) / n;
        const score = varD > n * 0.25 ? st / (T.norm * Math.sqrt(varD)) : 0;
        if (!best || score > best.score) best = { ox, oy, score };
      }
    }
    return best;
  }

  function searchScaledY(T, D, cx, cy, rx, ry, sc) {
    let best = null;
    for (let dy = -ry; dy <= ry; dy += 3) {
      const m = searchScaled(T, D, cx, cy + dy, Math.max(rx, 1), sc);
      if (m && (!best || m.score > best.score)) best = m;
    }
    return best ? searchScaled(T, D, best.ox, best.oy, 2, sc) || best : null;
  }

  // Coarse-to-fine match of an L0 rect. prior {dx,dy}, R {x,y}
  function matchRect(PA, PD, rect, prior, R, opt) {
    opt = opt || {};
    const lam = opt.lam != null ? opt.lam : 0.0015;
    const minDim = Math.min(rect.w, rect.h);
    const maxL = Math.min(PA.length, PD.length) - 1;
    let L = 0;
    while (
      L < maxL &&
      minDim / (1 << (L + 1)) >= 7 &&
      ((2 * R.x) / (1 << L) + 1) * ((2 * R.y) / (1 << L) + 1) > 900
    ) L++;

    const tplCache = [];
    const tpl = (l) => {
      if (tplCache[l] === undefined) {
        const s = 1 << l;
        tplCache[l] = makeTemplate(PA[l], rect.x / s, rect.y / s, rect.w / s, rect.h / s, l === 0 ? 900 : 500);
      }
      return tplCache[l];
    };
    const T0 = tpl(0);
    if (!T0 || T0.std < (opt.minStd || 2.2)) return null;
    const TL = tpl(L);
    if (!TL) return null;
    const s = 1 << L;
    let cands = search(TL, PD[L], Math.round(prior.dx / s), Math.round(prior.dy / s),
      Math.max(1, Math.ceil(R.x / s)), Math.max(1, Math.ceil(R.y / s)), lam * s, 3);
    if (!cands.length) return null;
    const second = cands.length > 1 ? cands[1].score : 0;
    let best = null;
    for (const c of cands) {
      let ox = c.ox, oy = c.oy, sc = c.score, prev = c.score;
      for (let l = L - 1; l >= 0; l--) {
        const T = tpl(l);
        if (!T) break;
        const r = search(T, PD[l], ox * 2, oy * 2, 2, 2, 0, 1);
        if (!r.length) { sc = -1; break; }
        prev = sc;
        ox = r[0].ox; oy = r[0].oy; sc = r[0].score;
      }
      // acceptance is judged on the finest two levels (L1 is tolerant to rasterizer differences)
      const acc = L > 0 ? Math.max(sc, prev) : sc;
      const eff = acc - lam * (Math.abs(ox - prior.dx) + Math.abs(oy - prior.dy));
      if (!best || eff > best.eff) best = { dx: ox, dy: oy, score: acc, fine: sc, eff };
    }
    if (!best || best.score < 0) return null;
    best.scale = 1;
    if (opt.allowScale && best.score < 0.8 && rect.w >= 12 && rect.h >= 10) {
      let top = { score: best.fine, s: 1, ox: best.dx, oy: best.dy };
      const r = Math.max(3, Math.round(Math.min(10, 0.06 * Math.max(rect.w, rect.h))));
      for (const s of [0.84, 0.91, 1.07, 1.14, 1.22]) {
        const m = searchScaled(T0, PD[0], best.dx, best.dy, r, s);
        if (m && m.score > top.score) top = { score: m.score, s, ox: m.ox, oy: m.oy };
      }
      if (top.s !== 1 && top.score > best.fine + 0.06) {
        // refine scale
        for (const s of [top.s - 0.035, top.s - 0.0175, top.s + 0.0175, top.s + 0.035]) {
          const m = searchScaled(T0, PD[0], top.ox, top.oy, 3, s);
          if (m && m.score > top.score) top = { score: m.score, s, ox: m.ox, oy: m.oy };
        }
        best = { dx: top.ox, dy: top.oy, score: Math.max(top.score, best.score), fine: top.score, eff: top.score, scale: top.s };
      }
    }
    best.std = T0.std;
    best.ambiguity = cands.length > 1 ? Math.max(0, 1 - (cands[0].score - second) * 20) : 0;
    best.ambiguous = cands.length > 1 && cands[0].score - cands[1].score < 0.015 &&
      Math.max(Math.abs(cands[0].ox - cands[1].ox), Math.abs(cands[0].oy - cands[1].oy)) >= 2;
    return best;
  }

  // ---------- geometry ----------

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  function measureEdges(PA, PD, ink, base, tol, boxy) {
    const out = { top: null, bottom: null, left: null, right: null };
    const o = 6;
    // boxes (visible bg/border): look at the boundary only, not at the content inside
    const bh = boxy ? clamp(Math.round(ink.h * 0.3), 3, 8) : clamp(Math.round(ink.h * 0.45), 4, 32);
    const bw = boxy ? clamp(Math.round(ink.w * 0.3), 3, 8) : clamp(Math.round(ink.w * 0.45), 4, 32);
    const Ry = clamp(Math.round(ink.h * 0.35), 8, 160);
    const Rx = clamp(Math.round(ink.w * 0.35), 8, 160);
    const ok = (m, dim, baseV, v) => m && m.score >= 0.6 && m.std >= 4 && !m.ambiguous &&
      (Math.abs(v - baseV) <= Math.max(8, 0.3 * dim) || m.score >= 0.85);
    const opts = { lam: 0.004, minStd: 3 };

    const top = matchRect(PA, PD, { x: ink.x - 4, y: ink.y - o, w: ink.w + 8, h: bh + o }, base, { x: 2, y: Ry }, opts);
    if (ok(top, ink.h, base.dy, top && top.dy)) out.top = top;
    const tdy = out.top ? out.top.dy : base.dy;

    const bot = matchRect(PA, PD, { x: ink.x - 4, y: ink.y + ink.h - bh, w: ink.w + 8, h: bh + o }, { dx: base.dx, dy: tdy }, { x: 2, y: Ry }, opts);
    if (ok(bot, ink.h, tdy, bot && bot.dy)) out.bottom = bot;

    const lh = Math.min(ink.h, 400);
    const left = matchRect(PA, PD, { x: ink.x - o, y: ink.y - 2, w: bw + o, h: lh + 4 }, { dx: base.dx, dy: tdy }, { x: Rx, y: 2 }, opts);
    if (ok(left, ink.w, base.dx, left && left.dx)) out.left = left;
    const ldx = out.left ? out.left.dx : base.dx;

    const right = matchRect(PA, PD, { x: ink.x + ink.w - bw, y: ink.y - 2, w: bw + o, h: lh + 4 }, { dx: ldx, dy: tdy }, { x: Rx, y: 2 }, opts);
    if (ok(right, ink.w, ldx, right && right.dx)) out.right = right;
    return out;
  }

  // ---------- color sampling ----------

  function sampleRGB(img, rect, maxN) {
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(img.w, Math.ceil(rect.x + rect.w)), y1 = Math.min(img.h, Math.ceil(rect.y + rect.h));
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return [];
    const stride = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxN)));
    const out = [];
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        const j = (y * img.w + x) * 4;
        out.push([img.rgba[j], img.rgba[j + 1], img.rgba[j + 2]]);
      }
    }
    return out;
  }
  function median3(px) {
    const m = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = px.map((p) => p[c]).sort((x, y) => x - y);
      m[c] = a[a.length >> 1];
    }
    return m;
  }
  const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  function inkColor(px, bg) {
    const far = px.map((p) => [cdist(p, bg), p]).filter((e) => e[0] > 55).sort((a, b) => b[0] - a[0]);
    if (far.length < 6) return null;
    const top = far.slice(0, Math.max(3, Math.floor(far.length / 3)));
    const m = [0, 0, 0];
    for (const [, p] of top) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
    return m.map((v) => v / top.length);
  }

  // ---------- tailwind hints ----------

  const TW = {
    'margin-top': /^(?:[\w-]+:)*-?(?:mt|my|m)-/,
    'margin-bottom': /^(?:[\w-]+:)*-?(?:mb|my|m)-/,
    'margin-left': /^(?:[\w-]+:)*-?(?:ml|mx|m|ms)-/,
    'padding-top': /^(?:[\w-]+:)*(?:pt|py|p)-/,
    'padding-bottom': /^(?:[\w-]+:)*(?:pb|py|p)-/,
    'padding-left': /^(?:[\w-]+:)*(?:pl|px|p|ps)-/,
    'gap-y': /^(?:[\w-]+:)*(?:gap|gap-y|space-y)-/,
    'gap-x': /^(?:[\w-]+:)*(?:gap|gap-x|space-x)-/,
    width: /^(?:[\w-]+:)*(?:w|min-w|max-w|basis|size)-/,
    height: /^(?:[\w-]+:)*(?:h|min-h|max-h|size)-/,
    'font-size': /^(?:[\w-]+:)*text-(?:xs|sm|base|lg|\d?xl|\[[\d.]+(?:px|rem)\])/,
    'line-height': /^(?:[\w-]+:)*(?:leading-|text-[\w[\].-]+\/)/,
    'letter-spacing': /^(?:[\w-]+:)*tracking-/,
    'top/left': /^(?:[\w-]+:)*-?(?:top|left|right|bottom|inset|translate-[xy])-/,
  };
  function twMatch(cls, families) {
    if (!cls) return [];
    const list = cls.split(/\s+/).filter(Boolean);
    const out = new Set();
    for (const f of families) {
      const re = TW[f];
      if (!re) continue;
      for (const c of list) if (re.test(c)) out.add(c);
    }
    return [...out].slice(0, 12);
  }
  const tw = (px) => {
    const u = px / 4;
    return Number.isInteger(u) ? String(u) : `[${Math.round(px)}px]`;
  };

  // ---------- typography: cap top / baseline from an ink row profile ----------

  // Measures the text line nearest to `guess` (cap top / baseline in doc px) inside a column range.
  function lineProfile(G, w, h, x0, x1, y0, y1, guess, capH) {
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(w, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h, Math.ceil(y1));
    const cw = x1 - x0, rh = y1 - y0;
    if (cw < 4 || rh < 4) return null;
    // background = median of the region (text is sparse)
    const hist = new Uint32Array(256);
    const step = Math.max(1, Math.floor((cw * rh) / 20000));
    let cnt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x += step) { hist[G[y * w + x]]++; cnt++; }
    let acc = 0, bg = 0;
    for (; bg < 256; bg++) { acc += hist[bg]; if (acc >= cnt / 2) break; }
    const dens = new Float32Array(rh);
    const cols = new Uint32Array(cw);
    for (let r = 0; r < rh; r++) {
      const row = (y0 + r) * w;
      let c = 0;
      for (let x = x0; x < x1; x++) if (Math.abs(G[row + x] - bg) > 48) c++;
      dens[r] = c / cw;
    }
    let max = 0;
    for (let r = 0; r < rh; r++) max = Math.max(max, dens[r]);
    if (max < 0.01) return null;
    // runs of inked rows (bridging 1-row gaps)
    const thr = Math.max(0.004, max * 0.04);
    const bands = [];
    let cur = null;
    for (let r = 0; r < rh; r++) {
      if (dens[r] > thr) { if (cur && r - cur.e <= 2) cur.e = r; else { cur = { s: r, e: r }; bands.push(cur); } }
    }
    let best = null;
    for (const b of bands) {
      let peak = 0;
      for (let r = b.s; r <= b.e; r++) peak = Math.max(peak, dens[r]);
      let top = b.s, base = b.e;
      for (let r = b.s; r <= b.e; r++) if (dens[r] >= peak * 0.1) { top = r; break; }
      for (let r = b.e; r >= b.s; r--) if (dens[r] >= peak * 0.3) { base = r; break; }
      const ch = base + 1 - top;
      if (capH && (ch < capH * 0.55 || ch > capH * 1.9)) continue;
      const capTop = y0 + top, baseline = y0 + base + 1;
      const dist = guess ? Math.abs(capTop - guess.capTop) + Math.abs(baseline - guess.baseline) : 0;
      if (!best || dist < best.dist) best = { capTop, baseline, capH: baseline - capTop, dist, s: b.s, e: b.e };
    }
    if (!best) return null;
    // horizontal extent of ink inside the chosen band
    for (let r = best.s; r <= best.e; r++) {
      const row = (y0 + r) * w;
      for (let x = x0; x < x1; x++) if (Math.abs(G[row + x] - bg) > 48) cols[x - x0]++;
    }
    let l = 0, rr = cw - 1;
    while (l < cw && !cols[l]) l++;
    while (rr > l && !cols[rr]) rr--;
    best.left = x0 + l; best.right = x0 + rr + 1;
    return best;
  }

  function hashId(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36).padStart(6, '0').slice(-6);
  }

  // ---------- main ----------

  function analyze(input) {
    const { actual, design, nodes } = input;
    const meta = input.meta || {};
    const tol = meta.tolerance != null ? meta.tolerance : 2;
    const progress = input.onProgress || (() => {});
    const W = actual.w;
    const Hs = actual.h, Hd = design.h;
    const t0 = Date.now();

    const tolerant = meta.contentMode === 'tolerant';
    progress(0.02, 'Preparing images');
    const GA = toGray(actual.rgba, actual.w, actual.h);
    const GD = toGray(design.rgba, design.w, design.h);
    const PA = pyramid(GA, actual.w, actual.h, 4);
    const PD = pyramid(GD, design.w, design.h, 4);

    // --- choose which nodes to match
    const byIdx = new Map();
    for (const n of nodes) byIdx.set(n.i, n);
    const kids = new Map();
    for (const n of nodes) {
      if (n.p >= 0) {
        if (!kids.has(n.p)) kids.set(n.p, []);
        kids.get(n.p).push(n);
      }
    }
    const sameRect = (a, b) => a && b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;

    const R = new Map(); // idx -> result
    const aliasOf = new Map();
    const matchable = (n) => !n.ig && n.ink && n.ink.w >= 4 && n.ink.h >= 4 && n.ink.x < W - 2 && n.ink.x + n.ink.w > 2 && n.ink.y < Hs - 2;

    const list = nodes.filter(matchable);
    const total = list.length;
    let done = 0;
    let lastRootDy = 0;
    const heightSlack = Math.abs(Hd - Hs);
    const vh = meta.vh || 900;
    for (const n of nodes) n._vh = meta.vh;

    // matched ancestor lookup (walking p chain)
    const matchedAncestor = (n) => {
      let p = n.p;
      while (p >= 0) {
        if (R.has(p)) return p;
        const pn = byIdx.get(p);
        p = pn ? pn.p : -1;
      }
      return -1;
    };

    // typography of a text node: site from the capture, design measured near the match
    const measureTypo = (n, d, wide) => {
      const tm = n.tm;
      if (!tm || !n.st || !n.st.fs) return null;
      const capH = tm.capH;
      const nextGap = tm.lineBox ? tm.lineBox - capH - 1 : capH;
      const site = lineProfile(GA, actual.w, actual.h, tm.x0 - 2, tm.x1 + 2, tm.capTop - 0.45 * capH, tm.baseline + Math.min(0.45 * capH, nextGap), tm, capH);
      if (!site) return null;
      const g = { capTop: site.capTop + d.y, baseline: site.baseline + d.y };
      const ext = Math.max(8, 0.15 * (tm.x1 - tm.x0));
      const vr = wide ? Math.max(3 * capH, 40) : 0.7 * capH + 6;
      const des = lineProfile(GD, design.w, design.h, tm.x0 + d.x - ext, tm.x1 + d.x + (d.w || 0) + ext, g.capTop - vr, g.baseline + (wide ? vr : Math.min(0.7 * capH, nextGap) + 6), g, capH);
      if (!des) return { site };
      const out = { site, design: des, ratio: des.capH / site.capH };
      if (wide) {
        // block extent: follow the lines down in both images (content-agnostic height)
        const pitch = tm.lineBox || capH * 1.6;
        const follow = (G, img, first, x0, x1, maxLines) => {
          let last = first, k = 1;
          while (k < maxLines) {
            const gs = { capTop: last.capTop + pitch, baseline: last.baseline + pitch };
            const b = lineProfile(G, img.w, img.h, x0, x1, gs.capTop - 0.35 * pitch, gs.baseline + 0.35 * pitch, gs, capH);
            if (!b || Math.abs(b.baseline - gs.baseline) > 0.35 * pitch) break;
            last = b; k++;
          }
          return { last, lines: k };
        };
        const sx0 = Math.min(tm.x0, n.tink ? n.tink.x : tm.x0) - 2, sx1 = Math.max(tm.x1, n.tink ? n.tink.x + n.tink.w : tm.x1) + 2;
        const sb = follow(GA, actual, site, sx0, sx1, tm.lines + 1);
        const db = follow(GD, design, des, sx0 + d.x - ext, sx1 + d.x + ext, 40);
        out.block = { siteLines: sb.lines, designLines: db.lines, dh: (db.last.baseline - des.baseline) - (sb.last.baseline - site.baseline) };
      }
      return out;
    };

    // precise font scale of the first text line: NCC over scaled templates (sub-pixel, content-wide).
    // When the whole-element match was weak, also try left/center/right anchoring around the parent's offset.
    const textScale = (n, d, alt, wide) => {
      const tm = n.tm;
      if (!tm) return null;
      const pad = Math.max(2, tm.capH * 0.35);
      const rect = { x: tm.x0 - 1, y: tm.capTop - pad, w: tm.x1 - tm.x0 + 2, h: tm.baseline - tm.capTop + 2 * pad };
      if (rect.w < 8 || rect.h < 6) return null;
      const T = makeTemplate(PA[0], rect.x, rect.y, rect.w, rect.h, 1200);
      if (!T || T.std < 3) return null;
      const centers = [{ x: Math.round(d.x), y: Math.round(d.y) }];
      if (alt && (Math.abs(alt.dx - d.x) > 2 || Math.abs(alt.dy - d.y) > 2)) centers.push({ x: Math.round(alt.dx), y: Math.round(d.y) });
      const tryScale = (sc, r) => {
        let b = null;
        for (const c of centers) {
          const anchors = wide ? [0, 0.5, 1] : [0];
          for (const a of anchors) {
            const cx = Math.round(c.x + a * T.tw * (1 - sc));
            const m = wide ? searchScaledY(T, PD[0], cx, c.y, 3, 12, sc) : searchScaled(T, PD[0], cx, c.y, r, sc);
            if (m && (!b || m.score > b.score)) b = { ...m, s: sc };
          }
        }
        return b;
      };
      const oneM = tryScale(1, 4);
      if (!oneM) return null;
      let best = oneM;
      for (let sc = 0.8; sc <= 1.26; sc += 0.03) {
        if (Math.abs(sc - 1) < 0.01) continue;
        const m = tryScale(sc, 4);
        if (m && m.score > best.score) best = m;
      }
      const s0 = best.s;
      for (let sc = s0 - 0.025; sc <= s0 + 0.0251; sc += 0.005) {
        const m = searchScaled(T, PD[0], best.ox, best.oy, 2, sc);
        if (m && m.score > best.score) best = { ...m, s: sc };
      }
      if (best.score < 0.55) return null;
      if (best.s !== 1 && best.score < oneM.score + 0.02) best = oneM;
      const sc = Math.round(best.s * 1000) / 1000;
      return { scale: sc, score: best.score, ox: best.ox, oy: best.oy, x0: T.x0, y0: T.y0 };
    };

    const finalize = (n, res, mp) => {
      const ink = n.ink;
      const edges = measureEdges(PA, PD, ink, { dx: res.dx, dy: res.dy }, tol, n.bv && !n.media);
      // the design frame has the same width and origin: full-bleed stays full-bleed, top-of-page stays at 0
      const fullBleed = ink.x <= 1 && ink.x + ink.w >= W - 1;
      if (fullBleed) {
        edges.left = { dx: 0, dy: res.dy, score: 1 };
        edges.right = { dx: 0, dy: res.dy, score: 1 };
        res.dx = 0;
      }
      if (ink.y <= 1) { edges.top = { dx: res.dx, dy: 0, score: 1 }; }
      if (res.profileOnly || res.firstLine) {
        edges.left = { dx: res.dx, score: res.score };
        edges.top = { dy: res.dy, score: res.score };
        edges.right = null;
        // height of a re-worded text block = its line count in the design (content-agnostic)
        edges.bottom = res.blockDh != null ? { dy: res.dy + res.blockDh, score: res.score } : null;
      }
      const L = edges.left ? edges.left.dx : res.dx;
      const T = edges.top ? edges.top.dy : res.dy;
      const sc = res.scale || 1;
      const Rr = edges.right ? edges.right.dx : L + (sc !== 1 ? ink.w * (sc - 1) : 0);
      const B = edges.bottom ? edges.bottom.dy : T + (sc !== 1 ? ink.h * (sc - 1) : 0);
      const out = {
        dx: res.dx, dy: res.dy, score: res.score, ambiguity: res.ambiguity,
        L, T, R: Rr, B,
        scale: sc,
        measured: { l: !!edges.left || sc !== 1, t: !!edges.top || sc !== 1, r: !!edges.right || sc !== 1, b: !!edges.bottom || sc !== 1 },
        edgeScore: Math.min(...['top', 'bottom', 'left', 'right'].map((k) => (edges[k] ? edges[k].score : 1))),
        contentDiffers: !!res.contentDiffers,
        profileOnly: !!res.profileOnly,
        firstLine: !!res.firstLine,
      };
      out.delta = { x: L, y: T, w: Rr - L, h: B - T };
      if (n.text && n.tm) {
        out.typo = res.typo || measureTypo(n, out.delta);
        const alt = mp >= 0 && R.has(mp) ? R.get(mp) : null;
        if (!res.profileOnly && !res.firstLine) out.tscale = textScale(n, out.delta, alt, res.score < 0.75);
        // single-line text that is uniformly scaled: position + size follow the scaled glyph match exactly
        const ts = out.tscale;
        if (ts && n.tm.lines === 1 && !n.bv && ts.scale === 1 && ts.score >= 0.75) {
          // same glyphs at the same size: a single line of identical text cannot change size
          out.delta = { x: ts.ox, y: ts.oy, w: 0, h: 0 };
          out.dx = ts.ox; out.dy = ts.oy;
          out.measured = { l: true, t: true, r: true, b: true };
        } else if (ts && n.tm.lines === 1 && !n.bv && Math.abs(ts.scale - 1) >= 0.015) {
          const s1 = ts.scale;
          out.delta = {
            x: ts.ox + (ink.x - ts.x0) * (s1 - 1),
            y: ts.oy + (ink.y - ts.y0) * (s1 - 1),
            w: ink.w * (s1 - 1),
            h: ink.h * (s1 - 1),
          };
          out.dx = out.delta.x; out.dy = out.delta.y;
          out.score = Math.max(out.score, ts.score);
          out.measured = { l: true, t: true, r: true, b: true };
        }
        // text whose glyphs don't correlate even though the box/line was found: different copy
        if (n.text && !out.contentDiffers && res.score < 0.62 && sc === 1) out.contentDiffers = true;
      }
      if (out.contentDiffers && tolerant) {
        // keep box edges / position / type only
        out.measured.r = false;
        out.delta.w = 0;
        if (!n.bv && !(res.profileOnly && res.blockDh != null)) { out.measured.b = false; out.delta.h = 0; }
      }
      return out;
    };

    const matchOne = (n, forcedPrior, forcedR) => {
      // alias: identical ink to its direct parent chain
      const parent = byIdx.get(n.p);
      if (parent && sameRect(parent.ink, n.ink) && (R.has(parent.i) || aliasOf.has(parent.i))) {
        const root = aliasOf.has(parent.i) ? aliasOf.get(parent.i) : parent.i;
        aliasOf.set(n.i, root);
        return;
      }
      const ink = n.ink;
      const hasKids = kids.has(n.i);
      const isContainer = hasKids && (ink.h > Math.max(1.6 * vh, 1400) || (ink.h > 0.5 * Hs && ink.w >= 0.9 * W));
      if ((isContainer && !n.bv) || (ink.w >= 0.95 * W && ink.h >= 0.9 * Hs && hasKids)) { n._pass = true; return; }
      const rect = { x: ink.x - 3, y: ink.y - 3, w: ink.w + 6, h: Math.min(ink.h, isContainer ? 160 : 600) + 6 };
      const mp = matchedAncestor(n);
      const leafish = !(kids.get(n.i) || []).some((c) => c.ink && c.ink.w * c.ink.h > 0.15 * ink.w * ink.h);
      const mo = { allowScale: leafish && ink.h <= 240 };
      let res = null;
      const prior0 = forcedPrior || (mp >= 0 ? { dx: R.get(mp).dx, dy: R.get(mp).dy } : { dx: 0, dy: lastRootDy });
      if (forcedPrior) {
        res = matchRect(PA, PD, rect, prior0, forcedR || { x: 16, y: 16 }, mo);
      } else if (mp >= 0) {
        res = matchRect(PA, PD, rect, prior0, { x: 24, y: 24 }, mo);
        if (!res || res.score < 0.72) {
          const wide = matchRect(PA, PD, rect, prior0, { x: 96, y: Math.min(400, 120 + heightSlack) }, mo);
          if (wide && (!res || wide.score > res.score + 0.03)) res = wide;
        }
      } else {
        res = matchRect(PA, PD, rect, prior0, { x: 64, y: Math.min(1200, 300 + heightSlack) }, mo);
      }
      // text glyphs only correlate when the copy is the same: weak text matches are spurious, not offsets
      if (res && n.text && !n.bv && !res.boxOnly && res.score < 0.66) {
        // same copy but wrapped differently? the first line still matches on its own
        const ts = n.tm ? textScale(n, { x: res.dx, y: res.dy }, mp >= 0 && R.has(mp) ? R.get(mp) : prior0, true) : null;
        if (ts && ts.score >= 0.72 && n.tm.lines > 1 && Math.abs(ts.scale - 1) < 0.015) {
          const typo = measureTypo(n, { x: ts.ox, y: ts.oy, w: 0, h: 0 }, true);
          res = { dx: ts.ox, dy: ts.oy, score: ts.score, ambiguity: 0, firstLine: true, typo, blockDh: typo && typo.block ? typo.block.dh : null };
        } else if (ts && ts.score >= 0.72) {
          // same copy, different font size: the scaled glyph match is the reliable one
          res = { dx: ts.ox, dy: ts.oy, score: ts.score, ambiguity: 0 };
        } else res = { ...res, score: Math.min(res.score, 0.49), weakText: true };
      }
      if ((!res || res.score < 0.5) && n.bv && (!n.media || tolerant)) {
        // content differs: fall back to the box outline only (visible bg/border edges)
        const eb = measureEdges(PA, PD, ink, prior0, tol, true);
        const fb = ink.x <= 1 && ink.x + ink.w >= W - 1;
        if (eb.top && (eb.bottom || ink.h > 600) && (fb || eb.left)) {
          res = { dx: fb ? 0 : eb.left.dx, dy: eb.top.dy, score: Math.min(eb.top.score, eb.bottom ? eb.bottom.score : 1, fb ? 1 : eb.left.score), ambiguity: 0, boxOnly: true, contentDiffers: true };
        }
      }
      if ((!res || res.score < 0.5) && tolerant && n.text && n.tm) {
        // different copy: find the text line by its ink profile (cap top / baseline), content-agnostic
        const typo = measureTypo(n, { x: prior0.dx, y: prior0.dy, w: 0, h: 0 }, true);
        if (typo && typo.design) {
          res = { dx: typo.design.left - typo.site.left, dy: typo.design.capTop - typo.site.capTop, score: 0.5, ambiguity: 0, profileOnly: true, contentDiffers: true, typo, blockDh: typo.block ? typo.block.dh : null };
        }
      }
      if (!res) { n._blank = true; return; }
      if (res.score < 0.5) { n._unmatched = res.score; return; }
      delete n._unmatched;
      R.set(n.i, finalize(n, res, mp));
      if (mp < 0 && ink.w >= W * 0.5) lastRootDy = res.dy;
    };

    for (const n of nodes) {
      if (!matchable(n)) continue;
      done++;
      if (done % 25 === 0) progress(0.05 + 0.75 * (done / total), `Matching elements ${done}/${total}`);
      matchOne(n);
    }

    // --- repeated look-alike siblings must keep reading order (monotonic assignment)
    progress(0.82, 'Checking repeated elements');
    const subtree = (n) => {
      const out = [];
      for (let k = n.i + 1; k < nodes.length && nodes[k].d > n.d; k++) out.push(nodes[k]);
      return out;
    };
    const rematchSubtree = (n) => {
      for (const c of subtree(n)) {
        R.delete(c.i); aliasOf.delete(c.i); delete c._unmatched; delete c._blank;
        if (matchable(c)) matchOne(c);
      }
    };
    const orderBroken = (arr) => {
      for (let k = 1; k < arr.length; k++) {
        const a = arr[k - 1], b = arr[k];
        const ra = R.get(a.i), rb = R.get(b.i);
        if (!ra || !rb) continue;
        const sameRow = Math.abs(a.ink.y - b.ink.y) < Math.min(a.ink.h, b.ink.h) / 2;
        const ea = { x: a.ink.x + ra.delta.x, y: a.ink.y + ra.delta.y }, eb = { x: b.ink.x + rb.delta.x, y: b.ink.y + rb.delta.y };
        if (sameRow ? eb.x <= ea.x + 2 : eb.y <= ea.y + Math.min(a.ink.h, b.ink.h) / 2) return true;
      }
      return false;
    };
    const repeatGroups = [];
    for (const [pi, ks] of kids) {
      const cand = ks.filter((c) => R.has(c.i) && c.ink && c.ink.w * c.ink.h > 200);
      const used = new Set();
      for (const a of cand) {
        if (used.has(a.i)) continue;
        const g = cand.filter((b) => !used.has(b.i) && b.tag === a.tag && (b.cls || '') === (a.cls || '') &&
          Math.abs(b.ink.w - a.ink.w) <= 0.1 * a.ink.w + 2 && Math.abs(b.ink.h - a.ink.h) <= 0.15 * a.ink.h + 2);
        if (g.length < 2) continue;
        g.forEach((b) => used.add(b.i));
        g.sort((x, y) => x.ink.y - y.ink.y || x.ink.x - y.ink.x);
        repeatGroups.push(g);
      }
    }
    const median = (a) => { const s2 = a.slice().sort((x, y) => x - y); return s2[s2.length >> 1]; };
    for (const g of repeatGroups) {
      const mdx = median(g.map((c) => R.get(c.i).delta.x)), mdy = median(g.map((c) => R.get(c.i).delta.y));
      const odd = g.filter((c) => {
        const d = R.get(c.i).delta;
        return Math.abs(d.x - mdx) > Math.max(12, 0.2 * c.ink.w) || Math.abs(d.y - mdy) > Math.max(12, 0.2 * c.ink.h);
      });
      if (!odd.length && !orderBroken(g)) continue;
      // re-match the outliers around the group's consensus displacement
      for (const c of odd.length ? odd : g) {
        const old = R.get(c.i);
        const keep = { ...old };
        R.delete(c.i);
        matchOne(c, { dx: Math.round(mdx), dy: Math.round(mdy) }, { x: 16, y: 16 });
        const nu = R.get(c.i);
        if (!nu || nu.score < old.score - 0.08) { R.set(c.i, keep); delete c._unmatched; delete c._blank; }
        else if (nu !== keep) rematchSubtree(c);
      }
      if (orderBroken(g)) for (const c of g) { const r = R.get(c.i); if (r) { r.orderAmbiguous = true; r.score = Math.min(r.score, 0.55); } }
    }

    progress(0.87, 'Resolving root causes');

    // Transparent containers have no visible edges of their own: their expected box is the
    // union of their matched children's expected boxes. Children have larger indices (pre-order).
    // unmatched transparent wrappers (e.g. a grid of look-alike cards) still get a derived box from their kids
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      if (R.has(n.i) || n.bv || n.ig || n._pass || !n.ink || n.text) continue;
      const ks = (kids.get(n.i) || []).filter((c) => R.has(c.i));
      if (!ks.length) continue;
      R.set(n.i, { dx: 0, dy: 0, score: Math.max(...ks.map((c) => R.get(c.i).score)), edgeScore: 1, scale: 1, measured: { l: true, t: true, r: true, b: true }, delta: { x: 0, y: 0, w: 0, h: 0 }, synthetic: true });
      delete n._unmatched;
    }
    const directMatchedKids = new Map();
    for (const n of nodes) {
      if (!R.has(n.i)) continue;
      const mp = matchedAncestor(n);
      if (mp < 0) continue;
      if (!directMatchedKids.has(mp)) directMatchedKids.set(mp, []);
      directMatchedKids.get(mp).push(n);
    }
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      if (!R.has(n.i) || n.bv) continue;
      const ks = directMatchedKids.get(n.i);
      if (!ks || !ks.length) continue;
      let a = null, e = null;
      for (const c of ks) {
        const cd = R.get(c.i).delta;
        const ca = c.ink, ce = { x: c.ink.x + cd.x, y: c.ink.y + cd.y, w: c.ink.w + cd.w, h: c.ink.h + cd.h };
        a = a ? { x0: Math.min(a.x0, ca.x), y0: Math.min(a.y0, ca.y), x1: Math.max(a.x1, ca.x + ca.w), y1: Math.max(a.y1, ca.y + ca.h) } : { x0: ca.x, y0: ca.y, x1: ca.x + ca.w, y1: ca.y + ca.h };
        e = e ? { x0: Math.min(e.x0, ce.x), y0: Math.min(e.y0, ce.y), x1: Math.max(e.x1, ce.x + ce.w), y1: Math.max(e.y1, ce.y + ce.h) } : { x0: ce.x, y0: ce.y, x1: ce.x + ce.w, y1: ce.y + ce.h };
      }
      // only trust it if the children cover the container's ink reasonably
      const cover = ((a.x1 - a.x0) * (a.y1 - a.y0)) / Math.max(1, n.ink.w * n.ink.h);
      if (cover < 0.6 && !n.text) continue;
      if (n.text) continue; // own text is matched directly
      const r = R.get(n.i);
      r.delta = { x: e.x0 - a.x0, y: e.y0 - a.y0, w: (e.x1 - e.x0) - (a.x1 - a.x0), h: (e.y1 - e.y0) - (a.y1 - a.y0) };
      r.derived = true;
      r.measured = { l: true, t: true, r: true, b: true };
    }

    // --- relations
    const mParent = new Map();
    const mKids = new Map();
    for (const n of nodes) {
      if (!R.has(n.i)) continue;
      const mp = matchedAncestor(n);
      mParent.set(n.i, mp);
      if (!mKids.has(mp)) mKids.set(mp, []);
      mKids.get(mp).push(n);
    }
    const zero = { x: 0, y: 0, w: 0, h: 0 };
    const deltaOf = (i) => (i >= 0 && R.has(i) ? R.get(i).delta : zero);
    const rel = new Map();
    for (const [i] of R) {
      const d = deltaOf(i), pd = deltaOf(mParent.get(i));
      rel.set(i, { x: d.x - pd.x, y: d.y - pd.y });
    }

    const issues = [];
    const info = new Map(); // idx -> {vp, hp, gapX, gapY}
    for (const [pi, group] of mKids) {
      const sorted = group.slice().sort((a, b) => a.ink.y - b.ink.y || a.ink.x - b.ink.x);
      for (let k = 0; k < sorted.length; k++) {
        const n = sorted[k];
        let vp = null, hp = null;
        for (let j = 0; j < k; j++) {
          const q = sorted[j];
          const qb = q.ink.y + q.ink.h, qr = q.ink.x + q.ink.w;
          const xOverlap = Math.min(qr, n.ink.x + n.ink.w) - Math.max(q.ink.x, n.ink.x);
          const yOverlap = Math.min(qb, n.ink.y + n.ink.h) - Math.max(q.ink.y, n.ink.y);
          if (qb <= n.ink.y + 1 && xOverlap > 0) {
            if (!vp || qb > vp.ink.y + vp.ink.h) vp = q;
          } else if (qr <= n.ink.x + 1 && yOverlap > 0.5 * Math.min(q.ink.h, n.ink.h)) {
            if (!hp || qr > hp.ink.x + hp.ink.w) hp = q;
          }
        }
        const r = rel.get(n.i), d = R.get(n.i).delta;
        let gapY = r.y - (vp ? rel.get(vp.i).y + R.get(vp.i).delta.h : 0);
        let gapX = r.x - (hp ? rel.get(hp.i).x + R.get(hp.i).delta.w : 0);
        let alignX = null, alignY = null;
        if (Math.abs(gapX) > tol && Math.abs(d.w) > tol && !hp) {
          if (Math.abs(r.x + d.w / 2) <= tol) { alignX = 'center'; gapX = 0; }
          else if (Math.abs(r.x + d.w) <= tol) { alignX = 'end'; gapX = 0; }
        }
        // first child inside a parent whose size changed: centered / end-aligned content moves by half / all of it
        const pdd = deltaOf(pi);
        if (!vp && Math.abs(gapY) > tol && Math.abs(pdd.h) > tol) {
          if (Math.abs(gapY - pdd.h / 2) <= tol + 1) { alignY = 'centered in parent'; gapY = 0; }
          else if (Math.abs(gapY - pdd.h) <= tol) { alignY = 'end of parent'; gapY = 0; }
        }
        if (!hp && Math.abs(gapX) > tol && Math.abs(pdd.w) > tol) {
          if (Math.abs(gapX - pdd.w / 2) <= tol + 1) { alignX = 'centered in parent'; gapX = 0; }
          else if (Math.abs(gapX - pdd.w) <= tol) { alignX = 'end of parent'; gapX = 0; }
        }
        if (Math.abs(gapY) > tol && Math.abs(d.h) > tol && !vp) {
          if (Math.abs(r.y + d.h / 2) <= tol) { alignY = 'center'; gapY = 0; }
          else if (Math.abs(r.y + d.h) <= tol) { alignY = 'end'; gapY = 0; }
        }
        info.set(n.i, { vp, hp, gapX, gapY, alignX, alignY, parent: pi });
      }
    }

    const childBottomShift = (i) => {
      const ks = mKids.get(i);
      if (!ks || !ks.length) return null;
      let a = -Infinity, e = -Infinity;
      for (const c of ks) {
        const cd = R.get(c.i).delta;
        a = Math.max(a, c.ink.y + c.ink.h);
        e = Math.max(e, c.ink.y + c.ink.h + cd.y + cd.h);
      }
      return e - a;
    };
    const childRightShift = (i) => {
      const ks = mKids.get(i);
      if (!ks || !ks.length) return null;
      let a = -Infinity, e = -Infinity;
      for (const c of ks) {
        const cd = R.get(c.i).delta;
        a = Math.max(a, c.ink.x + c.ink.w);
        e = Math.max(e, c.ink.x + c.ink.w + cd.x + cd.w);
      }
      return e - a;
    };

    const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    let exact = 0, inherited = 0;
    const describe = (n) => {
      const t = n.text || n.label;
      return `<${n.tag}${n.id ? '#' + n.id : ''}>${t ? ` "${t.slice(0, 40)}"` : ''}`;
    };
    const brief = (n) => (n ? { selector: n.sel, tag: n.tag, text: (n.text || n.label || '').slice(0, 60) || undefined } : undefined);
    // nearest source location (Astro dev attributes) / CMS block / astro scoped-style ids
    const upChain = (n, f) => { let a = n; while (a) { const v = f(a); if (v) return v; a = byIdx.get(a.p); } return null; };
    const sourceOf = (n) => upChain(n, (a) => a.src);
    const blockOf = (n) => upChain(n, (a) => (a.blk ? { selector: a.sel, tag: a.tag, id: a.id || undefined, label: (a.label || a.text || '').slice(0, 50) || undefined, attrs: Object.keys(a.blk).length ? a.blk : undefined } : null));
    const cidOf = (n) => upChain(n, (a) => { const k = a.attrs && Object.keys(a.attrs).filter((x) => x.startsWith('data-astro-cid-')); return k && k.length ? k.map((x) => x.slice(15)) : null; });
    const ctxOf = (n) => {
      const src = sourceOf(n), blk = blockOf(n), cid = cidOf(n);
      return { source: src || undefined, block: blk || undefined, astroCid: cid || undefined };
    };
    const typoOut = (n, t, ts) => {
      if (!t || !t.site) return undefined;
      const o = {
        frame: 'first text line, document px; capTop = top of capitals, baseline = alphabetic baseline',
        site: { capTop: t.site.capTop, baseline: t.site.baseline, capHeight: t.site.capH },
      };
      if (t.design) {
        o.design = { capTop: t.design.capTop, baseline: t.design.baseline, capHeight: t.design.capH };
        o.delta = { capTop: t.design.capTop - t.site.capTop, baseline: t.design.baseline - t.site.baseline };
        if (n.st && n.st.fs) {
          o.fontSize = ts
            ? { site: n.st.fs, design: Math.round(n.st.fs * ts.scale * 2) / 2, ratio: ts.scale, method: 'glyph scale match of the first line (NCC over scaled templates)', capHeightRatio: Math.round(t.ratio * 1000) / 1000 }
            : { site: n.st.fs, design: Math.round(n.st.fs * t.ratio * 2) / 2, ratio: Math.round(t.ratio * 1000) / 1000, method: 'cap-height ratio (design cap height ÷ site cap height × computed font-size)' };
        }
      }
      return o;
    };

    for (const n of nodes) {
      if (!R.has(n.i)) continue;
      const res = R.get(n.i);
      const d = res.delta;
      const inf = info.get(n.i) || {};
      const p = byIdx.get(mParent.get(n.i));
      const pd = deltaOf(mParent.get(n.i));
      const allZero = Math.abs(d.x) <= tol && Math.abs(d.y) <= tol && Math.abs(d.w) <= tol && Math.abs(d.h) <= tol;
      if (allZero) { exact++; continue; }

      const kinds = [];
      const why = [];
      if (res.orderAmbiguous) why.push('repeated sibling matched out of reading order: verify visually');
      if (res.profileOnly) why.push('content differs: located by its text line only');
      const conf = Math.min(res.score, res.edgeScore);
      if (Math.abs(inf.gapY) > tol) kinds.push('position-y');
      if (Math.abs(inf.gapX) > tol) kinds.push('position-x');

      let ownW = !res.derived && res.measured.l && res.measured.r && Math.abs(d.w) > tol;
      let ownH = !res.derived && res.measured.t && res.measured.b && Math.abs(d.h) > tol;
      if (res.derived && (Math.abs(d.w) > tol || Math.abs(d.h) > tol)) why.push('size follows its children');
      if (tolerant && res.contentDiffers && (ownW || ownH)) { ownW = false; ownH = false; why.push('size follows its (different) content'); }
      if (ownH) {
        const cb = childBottomShift(n.i);
        if (cb !== null && Math.abs(cb - (d.y + d.h)) <= tol) { ownH = false; why.push('height follows its content'); }
      }
      if (ownW) {
        if (p && Math.abs(pd.w) > tol && Math.abs(pd.w - d.w) <= tol) { ownW = false; why.push('width follows its parent'); }
        else {
          const cr = childRightShift(n.i);
          if (cr !== null && Math.abs(cr - (d.x + d.w)) <= tol && /inline|flex|grid/.test((n.st && n.st.display) || '')) {
            ownW = false; why.push('width follows its content');
          }
        }
      }
      if (ownW) kinds.push('size-w');
      if (ownH) kinds.push('size-h');
      if (!kinds.length) { inherited++; continue; }

      const expected = { x: n.ink.x + d.x, y: n.ink.y + d.y, w: n.ink.w + d.w, h: n.ink.h + d.h };
      const mag = Math.max(
        kinds.includes('position-y') ? Math.abs(inf.gapY) : 0,
        kinds.includes('position-x') ? Math.abs(inf.gapX) : 0,
        ownW ? Math.abs(d.w) : 0,
        ownH ? Math.abs(d.h) : 0
      );
      const severity = mag > 12 ? 'high' : mag > 4 ? 'medium' : 'low';
      const sug = suggest(n, p, inf, d, kinds, tol, res.derived);
      const summaryBits = [];
      const bits = {};
      if (kinds.includes('position-y')) bits['position-y'] = (`${Math.abs(Math.round(inf.gapY))}px too ${inf.gapY > 0 ? 'high (move down)' : 'low (move up)'}`);
      if (kinds.includes('position-x')) bits['position-x'] = `${Math.abs(Math.round(inf.gapX))}px too far ${inf.gapX > 0 ? 'left (move right)' : 'right (move left)'}`;
      if (ownW) bits['size-w'] = `${Math.abs(Math.round(d.w))}px too ${d.w > 0 ? 'narrow' : 'wide'}`;
      if (ownH) bits['size-h'] = `${Math.abs(Math.round(d.h))}px too ${d.h > 0 ? 'short' : 'tall'}`;

      issues.push({
        severity,
        kind: kinds,
        _bits: bits,
        _desc: describe(n),
        element: {
          selector: n.sel,
          tag: n.tag,
          id: n.id || undefined,
          classes: n.cls || undefined,
          text: n.text || undefined,
          label: n.label || undefined,
          attrs: n.attrs && Object.keys(n.attrs).length ? n.attrs : undefined,
          aliases: [...aliasOf].filter(([, r]) => r === n.i).map(([a]) => byIdx.get(a).sel).slice(0, 5),
        },
        ...ctxOf(n),
        deltaFrame: n.text && !n.bv ? 'text line boxes (Range rects); see typography for cap/baseline' : 'visible box (border box incl. background/border)',
        actual: round(n.ink),
        expected: round(expected),
        box: n.box ? round(n.box) : undefined,
        elementBox: n.box ? round(n.box) : undefined,
        typography: typoOut(n, res.typo, res.tscale),
        contentDiffers: res.contentDiffers || undefined,
        delta: { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) },
        ownShift: {
          x: Math.round(inf.gapX || 0),
          y: Math.round(inf.gapY || 0),
          relativeTo: {
            y: inf.vp ? 'previous sibling (above)' : p ? 'parent top' : 'page top',
            x: inf.hp ? 'previous sibling (left)' : p ? 'parent left' : 'page left',
          },
        },
        notes: why.length ? why : undefined,
        alignment: inf.alignX || inf.alignY ? { x: inf.alignX || undefined, y: inf.alignY || undefined } : undefined,
        confidence: Math.round(conf * 100) / 100,
        computed: n.st,
        parent: p ? { selector: p.sel, tag: p.tag, display: p.st && p.st.display, gap: p.st && p.st.gap, padding: p.st && p.st.pd, flexDirection: p.st && p.st.fd, classes: p.cls || undefined } : undefined,
        previousSibling: brief(inf.vp || inf.hp),
        suggestions: sug.text,
        tailwind: sug.tw.length ? sug.tw : undefined,
        _i: n.i,
      });
    }

    // --- group repeated sibling offsets into one parent-level issue (gap or padding)
    const buckets = new Map();
    for (const it of issues) {
      for (const axis of ['x', 'y']) {
        if (!it.kind.includes('position-' + axis)) continue;
        const inf = info.get(it._i);
        if (!inf) continue;
        const rr = R.get(it._i);
        if (rr && rr.orderAmbiguous) continue;
        const pred = !!(axis === 'x' ? inf.hp : inf.vp);
        const key = inf.parent + ':' + axis + ':' + (pred ? 'gap' : 'pad');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ it, g: axis === 'x' ? inf.gapX : inf.gapY });
      }
    }
    const extra = [];
    for (const [key, arr] of buckets) {
      const [pi, axis, type] = key.split(':');
      const p = byIdx.get(+pi);
      if (!p) continue;
      arr.sort((a, b) => a.g - b.g);
      const clusters = [];
      for (const e of arr) {
        const c = clusters[clusters.length - 1];
        if (c && Math.abs(e.g - c[0].g) <= Math.max(2, tol) + 0.5) c.push(e); else clusters.push([e]);
      }
      for (const c of clusters) {
        if (c.length < 2) continue;
        const g = Math.round(c.reduce((a, e) => a + e.g, 0) / c.length);
        const pst = p.st || {};
        for (const { it } of c) {
          it.kind = it.kind.filter((k) => k !== 'position-' + axis);
          delete it._bits['position-' + axis];
          it.groupedInto = (type === 'gap' ? 'gap-' : 'padding-') + axis + ' on ' + p.sel;
        }
        let suggestion, kind, summary, twc;
        if (type === 'gap') {
          const prop = axis === 'y' ? 'row-gap' : 'column-gap';
          const cur = pst.gap ? pst.gap[axis === 'y' ? 0 : 1] : 0;
          kind = 'gap-' + axis;
          summary = `${describe(p)}: space between its children is ${Math.abs(g)}px too ${g > 0 ? 'small' : 'large'} (${axis === 'y' ? 'vertical' : 'horizontal'})`;
          suggestion = /flex|grid/.test(pst.display || '')
            ? `${prop} ${cur}px → ${cur + g}px`
            : `Children are spaced with margins: change margin-${axis === 'y' ? 'top' : 'left'} of each child by ${g > 0 ? '+' : ''}${g}px (or use ${prop}).`;
          twc = twMatch(p.cls, [axis === 'y' ? 'gap-y' : 'gap-x']);
          // fluid tracks (1fr / flex:1) shrink when the gap grows: those size changes are consequences
          const sibs = mKids.get(+pi) || [];
          const dim = axis === 'x' ? 'w' : 'h';
          for (const it of issues) {
            if (!it.kind.includes('size-' + dim) || !sibs.some((k) => k.i === it._i)) continue;
            // tracks = siblings sharing this member's row (x) or column (y)
            const me = byIdx.get(it._i);
            const nTracks = Math.max(2, sibs.filter((q) => axis === 'x'
              ? Math.min(q.ink.y + q.ink.h, me.ink.y + me.ink.h) - Math.max(q.ink.y, me.ink.y) > 0.5 * Math.min(q.ink.h, me.ink.h)
              : Math.min(q.ink.x + q.ink.w, me.ink.x + me.ink.w) - Math.max(q.ink.x, me.ink.x) > 0.5 * Math.min(q.ink.w, me.ink.w)).length);
            const shrink = (g * (nTracks - 1)) / nTracks;
            if (Math.abs(it.delta[dim] + shrink) <= tol + 0.5) {
              it.kind = it.kind.filter((k) => k !== 'size-' + dim);
              delete it._bits['size-' + dim];
              it.suggestions = it.suggestions.filter((t) => !/^Width|^Height/.test(t));
              (it.notes = it.notes || []).push(`size follows the ${kind} change on the parent (fluid tracks)`);
            }
          }
        } else {
          const side = axis === 'y' ? 'top' : 'left';
          const cur = pst.pd ? pst.pd[axis === 'y' ? 0 : 3] : 0;
          kind = 'padding-' + axis;
          summary = `${describe(p)}: its content starts ${Math.abs(g)}px too ${axis === 'y' ? (g > 0 ? 'high' : 'low') : (g > 0 ? 'far left' : 'far right')} (padding-${side})`;
          suggestion = `padding-${side} ${cur}px → ${cur + g}px${axis === 'y' && pst.ai && /center/.test(pst.ai) ? ' (children are vertically centered: this may instead be the container height/padding on both sides)' : ''}`;
          twc = twMatch(p.cls, [axis === 'y' ? 'padding-top' : 'padding-left']);
        }
        extra.push({
          severity: Math.abs(g) > 12 ? 'high' : Math.abs(g) > 4 ? 'medium' : 'low',
          kind: [kind],
          summary,
          element: { selector: p.sel, tag: p.tag, id: p.id || undefined, classes: p.cls || undefined, label: p.label || undefined, attrs: p.attrs },
          actual: round(p.ink),
          expected: round(p.ink),
          delta: { [kind]: g },
          confidence: Math.min(...c.map((e) => e.it.confidence)),
          computed: pst,
          suggestions: [suggestion],
          tailwind: twc.length ? twc : undefined,
          children: c.map((e) => e.it.element.selector),
          _i: p.i,
        });
      }
    }
    // --- type scale: text that shares a computed style and is scaled by the same factor = one type issue
    const typeGroups = new Map();
    for (const n of nodes) {
      const r = R.get(n.i);
      if (!r || !n.text || !n.st || !n.st.fs) continue;
      const key = `${n.st.fs}|${n.st.ff}|${n.st.fw}|${n.st.lh}`;
      if (!typeGroups.has(key)) typeGroups.set(key, []);
      // NCC scale of the whole first line is the precise estimate; cap-height ratio only for large type
      const ratio = r.tscale ? r.tscale.scale : r.typo && r.typo.ratio && n.tm && n.tm.capH >= 18 ? r.typo.ratio : null;
      typeGroups.get(key).push({ n, r, ratio });
    }
    const typeClassesOf = (cls) => (cls || '').split(' ').filter((c) => /^(?:[\w-]+:)*(?:text-|font-|leading-|tracking-|type-|heading|h\d)/.test(c) && !/^(?:[\w-]+:)*text-(?:left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|transparent|current|inherit)$/.test(c));
    const issueByIdx = new Map(issues.map((it) => [it._i, it]));
    for (const [key, members] of typeGroups) {
      const withRatio = members.filter((m) => m.ratio);
      if (!withRatio.length) continue;
      const fs = members[0].n.st.fs;
      const med = median(withRatio.map((m) => m.ratio));
      const px = fs * (med - 1);
      const agree = withRatio.filter((m) => Math.abs(m.ratio - med) <= 0.03);
      const off = Math.abs(px) >= Math.max(1, tol / 2) && Math.abs(med - 1) >= 0.02;
      if (!off) continue;
      const designFs = Math.round(fs * med * 2) / 2;
      if (agree.length >= 2 && agree.length >= 0.6 * withRatio.length) {
        // shared classes among the group = the type style to edit
        let shared = null;
        for (const m of agree) {
          const tc = typeClassesOf(m.n.cls);
          shared = shared ? shared.filter((c) => tc.includes(c)) : tc;
        }
        const st0 = members[0].n.st;
        const label = shared && shared.length ? shared.join(' ') : `${fs}px ${st0.ff} ${st0.fw}`;
        const lhRatio = st0.lh / fs;
        for (const m of agree) {
          const it = issueByIdx.get(m.n.i);
          if (!it) continue;
          it.kind = it.kind.filter((k) => k !== 'size-w' && k !== 'size-h');
          if (it._bits) { delete it._bits['size-w']; delete it._bits['size-h']; }
          it.suggestions = (it.suggestions || []).filter((t) => !/^Text|^Height|^Width/.test(t));
          it.groupedInto = 'type-scale ' + label;
        }
        const first = agree[0].n;
        issues.push({
          severity: Math.abs(px) > 4 ? 'high' : Math.abs(px) > 1.5 ? 'medium' : 'low',
          kind: ['type-scale'],
          summary: `${label}: font-size ${fs} → ${designFs}px (${agree.length} element${agree.length > 1 ? 's' : ''}, all ${med.toFixed(3)}×)`,
          element: { selector: first.sel, tag: first.tag, classes: first.cls || undefined, text: first.text || undefined },
          ...ctxOf(first),
          actual: round(first.ink),
          expected: round(first.ink),
          typeStyle: { classes: shared && shared.length ? shared : undefined, computed: { fontSize: fs, lineHeight: st0.lh, fontFamily: st0.ff, fontWeight: st0.fw, letterSpacing: st0.ls } },
          fontSize: { site: fs, design: designFs, ratio: Math.round(med * 1000) / 1000, method: 'median glyph-scale ratio across the group (NCC over scaled first lines)' },
          delta: { fontSize: Math.round((designFs - fs) * 10) / 10 },
          members: agree.map((m) => m.n.sel).slice(0, 30),
          confidence: Math.round(Math.min(0.95, 0.6 + agree.length * 0.05) * 100) / 100,
          computed: st0,
          suggestions: [
            `Change the type style${shared && shared.length ? ` (${shared.join(' ')})` : ''}: font-size ${fs}px → ${designFs}px${lhRatio > 0.5 && lhRatio < 3 ? `; line-height ${st0.lh}px → ~${Math.round(st0.lh * med)}px if it is not relative` : ''}.`,
            'Edit the shared style/token rather than each element; the member issues are grouped into this one.',
          ],
          tailwind: shared && shared.length ? shared : undefined,
          _i: first.i,
        });
      } else {
        // single element (or no consensus): put the exact value on the element's own issue
        for (const m of withRatio) {
          const it = issueByIdx.get(m.n.i);
          if (!it || Math.abs(m.ratio - 1) < 0.02) continue;
          const exactFs = Math.round(fs * m.ratio * 2) / 2;
          it.suggestions = (it.suggestions || []).filter((t) => !/font-size .* → ~/.test(t));
          it.suggestions.unshift(`font-size ${fs}px → ${exactFs}px (from the design's cap height)`);
          if (!it.kind.includes('type-size')) it.kind.push('type-size');
          if (it._bits) it._bits['type-size'] = `set in ${fs}px instead of ${exactFs}px`;
        }
      }
    }

    for (let k = issues.length - 1; k >= 0; k--) if (!issues[k].kind.length) issues.splice(k, 1);
    for (const it of issues) {
      if (it._bits) {
        it.summary = `${it._desc} is ${Object.values(it._bits).join(', ')}`;
        if (it.groupedInto) it.suggestions = it.suggestions.filter((t) => !/space above|horizontal space|First in its|Left edge is off|Tailwind scale/.test(t));
        delete it._bits; delete it._desc;
      }
    }
    issues.push(...extra);

    // --- colors (only for well matched elements)
    progress(0.93, 'Checking colors');
    const colorIssues = [];
    for (const n of nodes) {
      const res = R.get(n.i);
      if (!res || res.score < 0.8) continue;
      if (tolerant && res.contentDiffers) continue;
      const d = res.delta;
      if (n.bv && n.st && n.ink.w * n.ink.h >= 400) {
        const inset = (r) => ({ x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 });
        const a = sampleRGB(actual, inset(n.box || n.ink), 121);
        const e = sampleRGB(design, inset({ x: (n.box || n.ink).x + d.x, y: (n.box || n.ink).y + d.y, w: (n.box || n.ink).w + d.w, h: (n.box || n.ink).h + d.h }), 121);
        if (a.length > 8 && e.length > 8) {
          const ma = median3(a), me = median3(e);
          if (cdist(ma, me) > 20) colorIssues.push({ n, what: 'background-color', actual: hex(ma), expected: hex(me), dist: cdist(ma, me) });
        }
      }
      if (n.text && n.tink && n.tink.w * n.tink.h >= 60) {
        const ra = n.tink;
        const a = sampleRGB(actual, ra, 900);
        const e = sampleRGB(design, { x: ra.x + d.x, y: ra.y + d.y, w: ra.w + d.w, h: ra.h + d.h }, 900);
        if (a.length > 20 && e.length > 20) {
          const ba = median3(a), be = median3(e);
          const ca = inkColor(a, ba), ce = inkColor(e, be);
          if (ca && ce && cdist(ca, ce) > 45) colorIssues.push({ n, what: 'color', actual: hex(ca), expected: hex(ce), dist: cdist(ca, ce) });
        }
      }
    }
    for (const c of colorIssues) {
      const n = c.n;
      issues.push({
        severity: c.dist > 90 ? 'medium' : 'low',
        kind: [c.what === 'color' ? 'text-color' : 'background-color'],
        summary: `${describe(n)} ${c.what} looks ${c.actual}, design shows ~${c.expected}`,
        element: { selector: n.sel, tag: n.tag, id: n.id || undefined, classes: n.cls || undefined, text: n.text || undefined, label: n.label || undefined },
        ...ctxOf(n),
        actual: round(n.ink),
        expected: round(n.ink),
        color: { property: c.what, actual: c.actual, expected: c.expected, computed: c.what === 'color' ? n.st && n.st.color : n.st && n.st.bg },
        confidence: 0.6,
        computed: n.st,
        suggestions: [`Set ${c.what} closer to ${c.expected} (sampled from the JPEG, so match it to the nearest design token; currently ${c.what === 'color' ? n.st && n.st.color : n.st && n.st.bg}).`],
        _i: n.i,
      });
    }

    // --- unmatched (not found in design)
    const unmatched = [];
    for (const n of nodes) {
      if (!n._unmatched) continue;
      if (n.ink.w * n.ink.h < 150) continue;
      const mp = matchedAncestor(n);
      if (mp < 0 && nodes.length > 1) {
        // top-level: only report big ones
        if (n.ink.w * n.ink.h < 5000) continue;
      }
      // skip if any descendant matched (then the problem is local to the descendants)
      let anyKidMatched = false;
      const stack = [...(kids.get(n.i) || [])];
      while (stack.length && !anyKidMatched) {
        const c = stack.pop();
        if (R.has(c.i)) anyKidMatched = true;
        else stack.push(...(kids.get(c.i) || []));
      }
      if (anyKidMatched) continue;
      // skip if an ancestor was already reported as unmatched
      let a = byIdx.get(n.p), covered = false;
      while (a) { if (a._reportedUnmatched) { covered = true; break; } a = byIdx.get(a.p); }
      if (covered) continue;
      n._reportedUnmatched = true;
      unmatched.push({
        severity: n.ink.w * n.ink.h > 20000 ? 'high' : 'medium',
        kind: ['not-found'],
        summary: `${describe(n)} could not be located in the design (looks different, is missing there, or is far from its expected spot)`,
        element: { selector: n.sel, tag: n.tag, id: n.id || undefined, classes: n.cls || undefined, text: n.text || undefined, label: n.label || undefined },
        ...ctxOf(n),
        actual: round(n.ink),
        bestScore: Math.round(n._unmatched * 100) / 100,
        computed: n.st,
        suggestions: ['Compare this element visually with the design: font family/weight/size, image crop or colors likely differ, or it sits much further away than the search window.'],
        _i: n.i,
      });
    }

    // one summary line per block instead of a not-found issue per element
    const nfByBlock = new Map();
    for (const it of unmatched) {
      const key = (it.block && it.block.selector) || '(page)';
      if (!nfByBlock.has(key)) nfByBlock.set(key, []);
      nfByBlock.get(key).push(it);
    }
    const notFound = [];
    for (const [key, arr] of nfByBlock) {
      if (arr.length < 3) { notFound.push(...arr); continue; }
      const ux = Math.min(...arr.map((a) => a.actual.x)), uy = Math.min(...arr.map((a) => a.actual.y));
      const ux1 = Math.max(...arr.map((a) => a.actual.x + a.actual.w)), uy1 = Math.max(...arr.map((a) => a.actual.y + a.actual.h));
      notFound.push({
        severity: tolerant ? 'low' : arr.some((a) => a.severity === 'high') ? 'high' : 'medium',
        kind: ['not-found'],
        summary: `${arr.length} elements in ${key} could not be located in the design${tolerant ? ' (content differs — expected in content-tolerant mode)' : ''}`,
        element: { selector: key, tag: (arr[0].block && arr[0].block.tag) || 'body' },
        block: arr[0].block,
        actual: { x: ux, y: uy, w: ux1 - ux, h: uy1 - uy },
        members: arr.slice(0, 15).map((a) => ({ selector: a.element.selector, text: (a.element.text || a.element.label || '').slice(0, 50) || undefined })),
        suggestions: ['These elements look different from the design (copy, image, font) or are missing there. Check them visually; nothing to change if the content is intentionally different.'],
        _i: arr[0]._i,
      });
    }
    if (tolerant) for (const it of notFound) it.severity = 'low';

    const sevRank = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.actual.y - b.actual.y || a.actual.x - b.actual.x);
    const all = issues.concat(notFound);
    // stable ids: hash of selector + kinds, so "#k3f9a2" means the same thing across runs
    const seen = new Map();
    all.forEach((it, k) => {
      let id = hashId((it.element && it.element.selector) + '|' + it.kind.slice().sort().join(','));
      const c = seen.get(id) || 0;
      seen.set(id, c + 1);
      if (c) id += '-' + (c + 1);
      it.id = id;
      it.rank = k + 1;
    });

    // --- vertical ledger: full-width bands top to bottom, where does the y-drift come from?
    const bandCand = nodes.filter((n) => R.has(n.i) && n.ink.w >= 0.6 * W && n.ink.h >= 32 && !n.ig);
    const candSet = new Set(bandCand.map((n) => n.i));
    const bands = bandCand.filter((n) => !upChain(byIdx.get(n.p), (a) => (candSet.has(a.i) && a.ink.h > n.ink.h + 4 ? a : null)))
      .sort((a, b) => a.ink.y - b.ink.y);
    const ledger = [];
    let prevBottomShift = 0;
    for (const n of bands) {
      const d = R.get(n.i).delta;
      if (ledger.length && n.ink.y < ledger[ledger.length - 1].site.bottom - 4) continue; // overlapping, skip
      const own = Math.round(d.y - prevBottomShift);
      const inside = all.filter((it) => it.actual && it.actual.y >= n.ink.y - 1 && it.actual.y < n.ink.y + n.ink.h && it._i !== n.i);
      ledger.push({
        band: describe(n),
        selector: n.sel,
        block: n.blk ? (Object.keys(n.blk).length ? n.blk : true) : undefined,
        site: { top: Math.round(n.ink.y), bottom: Math.round(n.ink.y + n.ink.h), height: Math.round(n.ink.h) },
        design: { top: Math.round(n.ink.y + d.y), bottom: Math.round(n.ink.y + d.y + n.ink.h + d.h), height: Math.round(n.ink.h + d.h) },
        ownTopDelta: own,
        heightDelta: Math.round(d.h),
        cumulativeBottomDelta: Math.round(d.y + d.h),
        issueIds: inside.slice(0, 20).map((it) => it.id),
      });
      prevBottomShift = d.y + d.h;
    }

    const matchedCount = R.size;

    progress(1, 'Done');
    return {
      page: { width: W, actualHeight: Hs, designHeight: Hd, heightDelta: Hd - Hs },
      stats: {
        elements: nodes.length,
        analyzed: total,
        matched: matchedCount,
        aliases: aliasOf.size,
        exact: exact,
        exactPct: matchedCount ? Math.round((exact / matchedCount) * 1000) / 10 : 0,
        inheritedShifts: inherited,
        ignored: nodes.filter((n) => n.ig).length,
        contentDiffers: [...R.values()].filter((r) => r.contentDiffers).length,
        issues: all.length,
        bySeverity: {
          high: all.filter((x) => x.severity === 'high').length,
          medium: all.filter((x) => x.severity === 'medium').length,
          low: all.filter((x) => x.severity === 'low').length,
        },
        ms: Date.now() - t0,
      },
      contentMode: tolerant ? 'tolerant' : 'same',
      _debug: meta.debug ? [...R].map(([i, r]) => ({ i, sel: byIdx.get(i).sel, ink: byIdx.get(i).ink, d: r.delta, s: Math.round(r.score * 100) / 100, ts: r.tscale, m: r.measured, der: r.derived })) : undefined,
      ledger,
      issues: all,
    };
  }

  function suggest(n, p, inf, d, kinds, tol, derived) {
    const text = [];
    const twc = [];
    const st = n.st || {};
    const pst = (p && p.st) || {};
    const px = (v) => `${Math.round(v * 10) / 10}px`;
    const pGapY = pst.gap ? pst.gap[0] : 0, pGapX = pst.gap ? pst.gap[1] : 0;
    const pFlexish = pst.display && /flex|grid/.test(pst.display);
    const pCol = pst.display && (/grid/.test(pst.display) || (/flex/.test(pst.display) && /column/.test(pst.fd || '')));
    const pRow = pst.display && (/grid/.test(pst.display) || (/flex/.test(pst.display) && !/column/.test(pst.fd || '')));

    if (derived && (kinds.includes('position-y') || kinds.includes('position-x'))) {
      // transparent wrapper: its "position" is really where its content starts
      if (kinds.includes('position-y')) text.push(`This wrapper has no visible box, so this is where its content starts: its own padding-top ${px(st.pd ? st.pd[0] : 0)} → ${px((st.pd ? st.pd[0] : 0) + inf.gapY)} (or margin-top ${px(st.m ? st.m[0] : 0)} → ${px((st.m ? st.m[0] : 0) + inf.gapY)}).`);
      if (kinds.includes('position-x')) text.push(`Content starts ${Math.abs(Math.round(inf.gapX))}px too far ${inf.gapX > 0 ? 'left' : 'right'}: its own padding-left ${px(st.pd ? st.pd[3] : 0)} → ${px((st.pd ? st.pd[3] : 0) + inf.gapX)}${st.maxW ? ` or max-width (${st.maxW})` : ''}.`);
      twc.push(...twMatch(n.cls, ['padding-top', 'padding-left', 'margin-top', 'width']));
      kinds = kinds.filter((k) => !k.startsWith('position'));
    }
    if (kinds.includes('position-y')) {
      const g = inf.gapY;
      const dir = g > 0 ? 'more' : 'less';
      if (inf.vp) {
        const opts = [];
        if (pFlexish && pCol && pGapY > 0) opts.push(`parent row-gap ${px(pGapY)} → ${px(pGapY + g)}`);
        opts.push(`margin-top ${px(st.m ? st.m[0] : 0)} → ${px((st.m ? st.m[0] : 0) + g)}`);
        const vpm = inf.vp.st && inf.vp.st.m ? inf.vp.st.m[2] : 0;
        opts.push(`or previous sibling margin-bottom ${px(vpm)} → ${px(vpm + g)}`);
        const vpp = inf.vp.st && inf.vp.st.pd ? inf.vp.st.pd[2] : 0;
        if (vpp > 0 && !inf.vp.bv) opts.push(`or previous sibling padding-bottom ${px(vpp)} → ${px(vpp + g)}`);
        text.push(`Needs ${Math.abs(Math.round(g))}px ${dir} space above (after ${inf.vp.sel}): ${opts.join('; ')}.`);
        twc.push(...twMatch(n.cls, ['margin-top']), ...twMatch(inf.vp.cls, ['margin-bottom', 'padding-bottom']), ...(p ? twMatch(p.cls, ['gap-y']) : []));
        text.push(`Tailwind scale: ${Math.abs(Math.round(g))}px = ${tw(Math.abs(g))} units.`);
      } else {
        const ppt = pst.pd ? pst.pd[0] : 0;
        const opts = [];
        if (p) opts.push(`parent padding-top ${px(ppt)} → ${px(ppt + g)}`);
        opts.push(`margin-top ${px(st.m ? st.m[0] : 0)} → ${px((st.m ? st.m[0] : 0) + g)}`);
        if (st.position && st.position !== 'static' && st.position !== 'relative') opts.push(`top ${st.top || 'auto'} (+${Math.round(g)}px)`);
        text.push(`First in its column: needs ${Math.abs(Math.round(g))}px ${dir} offset from ${p ? 'the parent top' : 'the page top'}: ${opts.join('; ')}.`);
        twc.push(...twMatch(n.cls, ['margin-top', 'top/left']), ...(p ? twMatch(p.cls, ['padding-top']) : []));
      }
    }
    if (kinds.includes('position-x')) {
      const g = inf.gapX;
      if (inf.hp) {
        const opts = [];
        if (pFlexish && pRow && pGapX > 0) opts.push(`parent column-gap ${px(pGapX)} → ${px(pGapX + g)}`);
        opts.push(`margin-left ${px(st.m ? st.m[3] : 0)} → ${px((st.m ? st.m[3] : 0) + g)}`);
        text.push(`Needs ${Math.abs(Math.round(g))}px ${g > 0 ? 'more' : 'less'} horizontal space after ${inf.hp.sel}: ${opts.join('; ')}.`);
        twc.push(...twMatch(n.cls, ['margin-left']), ...(p ? twMatch(p.cls, ['gap-x']) : []));
      } else {
        const ppl = pst.pd ? pst.pd[3] : 0;
        text.push(`Left edge is off by ${Math.round(g)}px relative to ${p ? 'the parent' : 'the page'}: ${p ? `parent padding-left ${px(ppl)} → ${px(ppl + g)}; ` : ''}margin-left ${px(st.m ? st.m[3] : 0)} → ${px((st.m ? st.m[3] : 0) + g)}${p && pst.jc && pst.jc !== 'normal' ? `; check parent justify-content (${pst.jc})` : ''}. If the container is centered, check its max-width.`);
        twc.push(...twMatch(n.cls, ['margin-left', 'top/left']), ...(p ? twMatch(p.cls, ['padding-left', 'width']) : []));
      }
    }
    const isText = !!n.text && !n.bv;
    const tH = n.tink ? n.tink.h : n.ink.h;
    if (kinds.includes('size-h')) {
      const eh = n.ink.h + d.h;
      if (isText && st.lh) {
        const lines = Math.max(1, Math.round(tH / st.lh));
        const expLines = Math.max(1, Math.round((tH + d.h) / st.lh));
        if (lines !== expLines) {
          text.push(`Text wraps to ~${lines} line(s); design shows ~${expLines}. Check width/max-width, font-size (${px(st.fs)}), letter-spacing (${st.ls}).`);
          twc.push(...twMatch(n.cls, ['width', 'font-size', 'letter-spacing']));
        } else {
          const perLine = eh / lines;
          text.push(`Text block height ${Math.round(n.ink.h)} → ${Math.round(eh)}px (${lines} line${lines > 1 ? 's' : ''}): line-height ${px(st.lh)} → ~${px(perLine)}${lines === 1 ? `, or font-size ${px(st.fs)} → ~${px(st.fs * eh / n.ink.h)}` : ''}.`);
          twc.push(...twMatch(n.cls, ['line-height', 'font-size']));
        }
      } else {
        const pv = st.pd ? st.pd[0] + st.pd[2] : 0;
        const vh = n._vh;
        if (vh && (Math.abs(n.box ? n.box.h - vh : n.ink.h - vh) <= 2 || Math.abs(parseFloat(st.minH) - vh) <= 2 || Math.abs(parseFloat(st.h) - vh) <= 2)) {
          text.push(`This element is ${Math.round(vh)}px tall = the viewport height used for the capture (100vh). If the design frame assumes a ${Math.round(vh + d.h)}px-tall screen, set this breakpoint's "Viewport height" to ${Math.round(vh + d.h)} in Parity instead of changing CSS.`);
        }
        text.push(`Height ${Math.round(n.ink.h)} → ${Math.round(eh)}px (${d.h > 0 ? '+' : ''}${Math.round(d.h)}). Check height/min-height (${st.h}) or vertical padding (${px(pv)} total → ${px(pv + d.h)}).`);
        twc.push(...twMatch(n.cls, ['height', 'padding-top']));
      }
    }
    if (kinds.includes('size-w')) {
      const ew = n.ink.w + d.w;
      if (isText) {
        text.push(`Text is ${Math.round(n.ink.w)}px wide vs ${Math.round(ew)}px in design (${d.w > 0 ? '+' : ''}${Math.round(d.w)}): font-size ${px(st.fs)} → ~${px(st.fs * ew / n.ink.w)}, or letter-spacing ${st.ls}, or font-weight ${st.fw} / family "${st.ff}" differs.`);
        twc.push(...twMatch(n.cls, ['font-size', 'letter-spacing']));
      } else {
        const ph = st.pd ? st.pd[1] + st.pd[3] : 0;
        text.push(`Width ${Math.round(n.ink.w)} → ${Math.round(ew)}px (${d.w > 0 ? '+' : ''}${Math.round(d.w)}). Check width/max-width (${st.w}${st.maxW ? ', max ' + st.maxW : ''}) or horizontal padding (${px(ph)} total → ${px(ph + d.w)}).`);
        twc.push(...twMatch(n.cls, ['width', 'padding-left']));
      }
    }
    return { text, tw: [...new Set(twc)] };
  }

  // ---------- section scope: analyze one subtree with its top aligned to the same section in the design ----------

  function analyzeScoped(input) {
    const { actual, design, nodes, scope } = input;
    const meta = input.meta || {};
    const W = actual.w;
    const b = scope.box;
    const near = (a, c) => Math.abs(a - c) <= 1.5;
    const root = nodes.find((n) => n.sel === scope.selector && n.box && near(n.box.y, b.y) && near(n.box.x, b.x)) ||
      nodes.find((n) => n.box && near(n.box.x, b.x) && near(n.box.y, b.y) && near(n.box.w, b.w) && near(n.box.h, b.h));
    if (!root) throw new Error(`Scope element ${scope.selector} was not found in the captured DOM`);
    const sub = [root];
    for (let k = root.i + 1; k < nodes.length && nodes[k].d > root.d; k++) sub.push(nodes[k]);

    const pad = 16;
    const y0 = Math.max(0, Math.floor(b.y) - pad);
    const y1 = Math.min(actual.h, Math.ceil(b.y + b.h) + pad);
    const h = y1 - y0;
    if (h < 8) throw new Error('Scope element has no height');

    // locate the section in the design (whole design: global vertical search; section JPEG: small window)
    const PA = pyramid(toGray(actual.rgba, actual.w, actual.h), actual.w, actual.h, 4);
    const PD = pyramid(toGray(design.rgba, design.w, design.h), design.w, design.h, 4);
    // align on the section's own visible content (its box edge if it has a background), never on what's above it
    const ri = root.ink || root.box;
    const band = root.bv ? { x: 0, y: Math.max(0, b.y - 4), w: W, h: Math.min(b.h, 260) + 4 } : { x: ri.x - 4, y: ri.y - 4, w: ri.w + 8, h: Math.min(ri.h, 260) + 8 };
    const fromSection = !!input.designIsSection;
    // section JPEG is drawn with its top at row `pad` of the design canvas
    const prior = { dx: 0, dy: fromSection ? Math.round(pad - b.y) : 0 };
    const Ry = fromSection ? Math.max(48, Math.round(0.15 * h)) : Math.max(design.h, actual.h);
    const loc = matchRect(PA, PD, band, prior, { x: 2, y: Ry }, { lam: fromSection ? 0.002 : 0.0001 });
    if (!loc || loc.score < 0.4) {
      throw new Error(fromSection
        ? 'Could not align the section JPEG with the page section (is it the right export?)'
        : 'Could not find this section in the full design. Drop a section-only JPEG for it in the panel.');
    }
    // a section JPEG starts exactly at the section's top edge: trust that, the match is only a sanity check
    const dy0 = fromSection ? prior.dy : loc.dy;
    const yd0 = Math.max(0, y0 + dy0);
    const hd = Math.max(8, Math.min(design.h - yd0, h + Math.max(160, Math.round(0.4 * h))));
    const crop = (img, ys, hh) => ({ w: img.w, h: hh, rgba: img.rgba.subarray(ys * img.w * 4, (ys + hh) * img.w * 4) });

    // remap the subtree into crop coordinates
    const map = new Map(sub.map((n, k) => [n.i, k]));
    const sh = (r) => (r ? { ...r, y: r.y - y0 } : r);
    const local = sub.map((n, k) => {
      const m = { ...n, i: k, p: n === root ? -1 : map.has(n.p) ? map.get(n.p) : -1, box: sh(n.box), ink: sh(n.ink), tink: sh(n.tink) };
      if (n.tm) m.tm = { ...n.tm, capTop: n.tm.capTop - y0, baseline: n.tm.baseline - y0, lastBaseline: n.tm.lastBaseline - y0 };
      return m;
    });
    const res = analyze({ actual: crop(actual, y0, h), design: crop(design, yd0, hd), nodes: local, meta, onProgress: input.onProgress });

    // back to page coordinates; expected boxes are "where it should be with the section top aligned"
    const up = (r) => (r && r.y != null ? { ...r, y: r.y + y0 } : r);
    for (const it of res.issues) {
      for (const k of ['actual', 'expected', 'box', 'elementBox']) if (it[k]) it[k] = up(it[k]);
      if (it.typography) {
        for (const side of ['site', 'design']) {
          const t = it.typography[side];
          if (t) it.typography[side] = { ...t, capTop: t.capTop + y0, baseline: t.baseline + y0 };
        }
      }
    }
    for (const l of res.ledger || []) {
      l.site = { ...l.site, top: l.site.top + y0, bottom: l.site.bottom + y0 };
      l.design = { ...l.design, top: l.design.top + y0, bottom: l.design.bottom + y0 };
    }
    res.page = { ...res.page, scope: true, sectionHeight: Math.round(b.h), designSectionHeightApprox: hd - 2 * pad };
    res.scope = {
      selector: scope.selector,
      label: scope.label,
      source: fromSection ? 'section JPEG' : 'located in the full design',
      site: { top: Math.round(b.y), bottom: Math.round(b.y + b.h) },
      designTop: fromSection ? undefined : Math.round(b.y + dy0),
      offsetRemoved: fromSection ? undefined : Math.round(dy0),
      locateScore: Math.round(loc.score * 100) / 100,
      crop: { site: { y: y0, h }, design: { y: yd0, h: hd } },
      note: 'Coordinates are page px with the section top aligned to the design section top: vertical drift from content above the section is excluded.',
    };
    return res;
  }

  const api = { analyze, analyzeScoped, _internals: { toGray, pyramid, makeTemplate, search, matchRect, measureEdges } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ParityCore = api;
})(typeof self !== 'undefined' ? self : this);
