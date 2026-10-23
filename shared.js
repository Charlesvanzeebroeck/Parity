/*
 * Parity — helpers shared by every extension context. Plain script, no DOM.
 * Loaded by background.js (importScripts) and injected first into tabs.
 */
(function (root) {
  'use strict';
  if (root.ParityShared) return; // re-injection into the same tab

  const SETTINGS_KEY = 'parity:settings';
  const DEFAULT_SETTINGS = Object.freeze({ folder: 'parity', keys: true });

  // Bands of the design JPEG (design CSS px). Cuts split it into horizontal bands that slide
  // vertically on their own: band 0 is drawn bp.offsetY down, band i at bp.slices[i-1].dy
  // (absolute, not relative to the band above).
  function segmentsOf(bp, cssH) {
    const out = [];
    let y0 = 0, dy = bp.offsetY || 0;
    for (const c of bp.slices || []) {
      if (c.y <= y0 || c.y >= cssH) continue;
      out.push({ y0, y1: c.y, dy });
      y0 = c.y;
      dy = c.dy || 0;
    }
    out.push({ y0, y1: cssH, dy });
    return out;
  }

  const api = { SETTINGS_KEY, DEFAULT_SETTINGS, segmentsOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ParityShared = api;
})(typeof self !== 'undefined' ? self : globalThis);
