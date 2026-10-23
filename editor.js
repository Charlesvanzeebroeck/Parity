/*
 * Parity — live layout editor. Select page elements, drag them, drag their edges and spacing,
 * scrub values in the inspector. Every gesture becomes a real CSS property change (margin, gap,
 * padding, width, font-size…) recorded per breakpoint, applied as inline `!important` styles and
 * removed again on close. Exposes globalThis.ParityEditor; content.js owns the panel and calls in.
 */
(function () {
  if (globalThis.ParityEditor) return;
  const Core = globalThis.ParityEdits;
  const Pg = globalThis.ParityPage;
  const { uniqueSelector, labelOf, srcOf, similarOf, toHex, isOurs } = Pg;

  const Z = 2147483646;
  const LIME = '#c8ff3d';
  const E = {
    ctx: null, on: false, sel: null, selSel: null, hover: null, all: false, before: false, measure: false,
    drag: null, pend: null, undo: [], redo: [], lastTag: null, lastPush: 0, via: new Map(), theme: undefined,
    mountEl: null, raf: 0, reT: 0, mouse: { x: 0, y: 0 },
  };

  // ---------- small helpers ----------

  const px = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const fmt = (v) => r2(v) + 'px';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (v) => { const m = /^(-?[\d.]+)px$/.exec(String(v)); return m ? String(r2(+m[1])) : String(v); };
  const docRect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, r: r.right + scrollX, b: r.bottom + scrollY }; };
  const fromUs = (e) => (e.composedPath ? e.composedPath() : []).some((n) => n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-parity'));
  const COLOR = /color$/;
  const PXP = /^(width|height|min-|max-|margin|padding|top|right|bottom|left|row-gap|column-gap|gap|font-size|line-height|letter-spacing|border-radius|flex-basis)/;

  const bp = () => E.ctx && E.ctx.bp();
  const list = () => (bp() && bp().edits) || [];

  // current computed value, canonical (px rounded, colours as hex)
  function cur(el, prop) {
    const cs = getComputedStyle(el);
    if (prop === 'translate') {
      const t = cs.translate;
      if (!t || t === 'none') return '0px 0px';
      const [x, y] = t.split(/\s+/);
      return `${fmt(px(x))} ${fmt(px(y || 0))}`;
    }
    const v = cs.getPropertyValue(prop).trim();
    if (COLOR.test(prop)) return toHex(v);
    if (/^-?[\d.]+px$/.test(v)) return fmt(px(v));
    return v;
  }

  // ---------- apply engine ----------

  const orig = new Map(); // el → Map(prop → [value, priority])
  const hadStyle = new Map();

  function setProp(el, prop, val) {
    let m = orig.get(el);
    if (!m) { m = new Map(); orig.set(el, m); hadStyle.set(el, el.hasAttribute('style')); }
    if (!m.has(prop)) m.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, val, 'important');
  }
  function unapplyAll() {
    for (const [el, m] of orig) {
      for (const [p, [v, pr]] of m) { if (v) el.style.setProperty(p, v, pr); else el.style.removeProperty(p); }
      if (!hadStyle.get(el) && !el.getAttribute('style')) el.removeAttribute('style');
    }
    orig.clear();
    hadStyle.clear();
  }
  function targets(ed) {
    let els = [];
    try { els = [...document.querySelectorAll(ed.sel)]; } catch (e) { return []; }
    if (ed.exact) els = els.filter((x) => x.classList.length === ed.exact);
    return els.filter((x) => !isOurs(x));
  }
  function applyAll() {
    unapplyAll();
    if (!E.ctx || E.before) return;
    for (const ed of list()) {
      if (ed.kind === 'order') {
        (ed.kids || []).forEach((s, i) => { try { const k = document.querySelector(s); if (k) setProp(k, 'order', String(i)); } catch (e) { /* bad selector */ } });
      } else for (const el of targets(ed)) setProp(el, ed.prop, ed.to);
    }
  }

  // re-apply after the page re-renders (hot reload, client-side rendering)
  const obs = new MutationObserver((muts) => {
    const real = muts.some((m) => [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && !isOurs(n) && !(n.hasAttribute && n.hasAttribute('data-parity'))));
    if (!real) return;
    clearTimeout(E.reT);
    E.reT = setTimeout(() => {
      if (E.drag) return;
      applyAll();
      if (E.sel && !E.sel.isConnected) { let el = null; try { el = E.selSel && document.querySelector(E.selSel); } catch (e) { /* ignore */ } E.sel = el; }
      paint();
      renderPanel();
    }, 90);
  });

  function setList(l) {
    const b = bp();
    if (!b) return;
    b.edits = l;
    E.ctx.save();
    applyAll();
    paint();
    renderPanel();
    E.ctx.changed();
  }

  // ---------- undo ----------

  function pushUndo(tag) {
    const b = bp();
    if (!b) return;
    const now = Date.now();
    if (tag && tag === E.lastTag && now - E.lastPush < 900) { E.lastPush = now; return; }
    E.undo.push({ bpId: b.id, edits: JSON.stringify(b.edits || []) });
    if (E.undo.length > 150) E.undo.shift();
    E.redo = [];
    E.lastTag = tag || null;
    E.lastPush = now;
  }
  function restore(from, to) {
    const snap = from.pop();
    if (!snap) return E.ctx.toast('Nothing to ' + (from === E.undo ? 'undo' : 'redo'));
    const b = E.ctx.bps().find((x) => x.id === snap.bpId);
    if (!b) return;
    to.push({ bpId: b.id, edits: JSON.stringify(b.edits || []) });
    b.edits = JSON.parse(snap.edits);
    E.lastTag = null;
    if (b !== bp()) E.ctx.toast(`Changed the ${b.width}px edits`);
    E.ctx.save();
    applyAll();
    paint();
    renderPanel();
    E.ctx.changed();
  }
  const undo = () => restore(E.undo, E.redo);
  const redo = () => restore(E.redo, E.undo);

  // ---------- recording ----------

  function scopeFor(el) {
    if (E.all) { const s = similarOf(el); if (s) return s; }
    return { sel: uniqueSelector(el), n: 1, els: [el] };
  }
  // changes: [{ el, prop, from, to }] — from = value before the gesture started
  function commit(changes, tag) {
    if (!bp()) return E.ctx.toast('Add a breakpoint first', true);
    changes = changes.filter((c) => c.to != null);
    if (!changes.length) return;
    pushUndo(tag);
    let l = list();
    for (const c of changes) {
      const t = scopeFor(c.el);
      l = Core.upsert(l, { sel: t.sel, exact: t.exact || undefined, n: t.n, label: labelOf(c.el), src: srcOf(c.el) || undefined, cls: c.el.getAttribute('class') || undefined, prop: c.prop, from: c.from, to: c.to });
    }
    setList(l);
  }
  function preview(el, prop, val) { for (const x of scopeFor(el).els) setProp(x, prop, val); }

  // ---------- what a gesture changes ----------

  const inFlow = (x) => { const cs = getComputedStyle(x); return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed' && !isOurs(x); };
  function prevInFlow(el) { let p = el.previousElementSibling; while (p && !inFlow(p)) p = p.previousElementSibling; return p; }
  function firstOnAxis(el, V) {
    const r = el.getBoundingClientRect();
    for (const s of el.parentElement ? el.parentElement.children : []) {
      if (s === el || !inFlow(s)) continue;
      const q = s.getBoundingClientRect();
      if (!q.width && !q.height) continue;
      if (V ? q.bottom <= r.top + 1 : q.right <= r.left + 1 && q.bottom > r.top && q.top < r.bottom) return false;
    }
    return true;
  }
  const isFlexGrid = (cs) => cs && /flex|grid/.test(cs.display);

  // Ranked properties that move `el` along an axis. The first is the default; Tab cycles.
  function moveCands(el, axis) {
    const V = axis === 'y';
    const cs = getComputedStyle(el);
    const p = el.parentElement;
    const pcs = p && getComputedStyle(p);
    const out = [];
    const add = (c) => { if (c.el && !out.some((o) => o.el === c.el && o.prop === c.prop)) out.push(c); };
    const tr = { el, prop: 'translate', sign: 1, label: 'translate (visual only)' };
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const [a, b] = V ? ['top', 'bottom'] : ['left', 'right'];
      const va = cs[a] === 'auto' ? null : px(cs[a]), vb = cs[b] === 'auto' ? null : px(cs[b]);
      if (vb != null && (va == null || vb < va)) add({ el, prop: b, sign: -1, label: b }); else add({ el, prop: a, sign: 1, label: a });
      add(tr);
      return out;
    }
    if (cs.position === 'relative' && (px(cs.top) || px(cs.left))) add({ el, prop: V ? 'top' : 'left', sign: 1, label: V ? 'top (relative)' : 'left (relative)' });
    const fg = isFlexGrid(pcs);
    const first = p ? firstOnAxis(el, V) : true;
    const gapProp = V ? 'row-gap' : 'column-gap';
    const gapOK = fg && (pcs.display.includes('grid') || pcs.flexWrap !== 'nowrap' || (V ? pcs.flexDirection.startsWith('column') : pcs.flexDirection.startsWith('row')));
    const padProp = V ? 'padding-top' : 'padding-left';
    const marProp = V ? 'margin-top' : 'margin-left';
    const prev = prevInFlow(el);
    const prevMar = V ? 'margin-bottom' : 'margin-right';
    const gap = { el: p, prop: gapProp, sign: 1, label: `${gapProp} · parent` };
    const pad = { el: p, prop: padProp, sign: 1, label: `${padProp} · parent` };
    const mar = { el, prop: marProp, sign: 1, label: marProp };
    const pm = prev && { el: prev, prop: prevMar, sign: 1, label: `${prevMar} · previous` };
    if (gapOK && !first && px(pcs[V ? 'rowGap' : 'columnGap']) > 0) add(gap);
    if (first && p && px(pcs[V ? 'paddingTop' : 'paddingLeft']) > 0) add(pad);
    if (px(cs[V ? 'marginTop' : 'marginLeft'])) add(mar);
    if (!first && pm && px(getComputedStyle(prev)[V ? 'marginBottom' : 'marginRight']) > 0) add(pm);
    if (gapOK && !first) add(gap);
    if (first && p && p !== document.body) add(pad);
    add(mar);
    add(tr);
    return out;
  }

  function sizeCands(el, axis) {
    const V = axis === 'y';
    const cs = getComputedStyle(el);
    const pcs = el.parentElement && getComputedStyle(el.parentElement);
    const out = [];
    const dim = V ? 'height' : 'width';
    const maxP = V ? 'max-height' : 'max-width';
    const maxV = cs.getPropertyValue(maxP);
    if (maxV !== 'none' && Math.abs(px(maxV) - px(cs[dim])) < 1) out.push({ el, prop: maxP, sign: 1, label: maxP });
    out.push({ el, prop: dim, sign: 1, label: dim });
    out.push({ el, prop: V ? 'min-height' : 'min-width', sign: 1, label: V ? 'min-height' : 'min-width' });
    if (pcs && pcs.display.includes('flex') && (V ? pcs.flexDirection.startsWith('column') : pcs.flexDirection.startsWith('row'))) out.push({ el, prop: 'flex-basis', sign: 1, label: 'flex-basis' });
    return out;
  }

  function preferred(cands, el, axis, kind) {
    const k = E.via.get(kind + axis + '|' + uniqueSelector(el));
    const i = k ? cands.findIndex((c) => c.label === k) : -1;
    return i > 0 ? i : 0;
  }

  // ---------- drags ----------

  function candBase(c) { return cur(c.el, c.prop); }
  function candValue(c, base, dv, axis) {
    if (c.prop === 'translate') {
      const [x, y] = base.split(' ').map(px);
      return axis === 'y' ? `${fmt(x)} ${fmt(y + dv)}` : `${fmt(x + dv)} ${fmt(y)}`;
    }
    let b = px(base);
    if (!/px$/.test(base) && (base === 'auto' || base === 'none' || base === 'normal')) b = px(cur(c.el, c.prop === 'max-width' || c.prop === 'min-width' || c.prop === 'flex-basis' ? 'width' : c.prop === 'max-height' || c.prop === 'min-height' ? 'height' : c.prop));
    let v = b + dv;
    if (/^(width|height|min-|max-|padding|row-gap|column-gap|flex-basis)/.test(c.prop)) v = Math.max(0, v);
    return fmt(v);
  }

  function axisState(el, axis, cands, meas, ci) {
    const st = { axis, cands, ci: ci || 0, meas, e: null, cal: false, active: false, noEffect: false };
    resetAxis(st, el);
    return st;
  }
  function resetAxis(st, el) {
    const c = st.cands[st.ci];
    st.base = candBase(c);
    st.e = c.sign;
    st.cal = !st.meas;
    st.noEffect = false;
    st.pos0 = st.meas ? st.meas(el.getBoundingClientRect()) : 0;
    st.value = st.base;
  }

  function startDrag(kind, opts) {
    const el = E.sel;
    if (!el) return;
    const D = { kind, el, x0: opts.x, y0: opts.y, sx0: scrollX, sy0: scrollY, lastX: opts.x, lastY: opts.y, axes: {}, auto: 0, raf: 0 };
    if (kind === 'move') {
      D.axes.x = axisState(el, 'x', moveCands(el, 'x'), (r) => r.left, preferred(moveCands(el, 'x'), el, 'x', 'move'));
      D.axes.y = axisState(el, 'y', moveCands(el, 'y'), (r) => r.top, preferred(moveCands(el, 'y'), el, 'y', 'move'));
      D.dead = 6;
    } else if (kind === 'size') {
      if (opts.side.includes('r')) D.axes.x = axisState(el, 'x', sizeCands(el, 'x'), (r) => r.right, preferred(sizeCands(el, 'x'), el, 'x', 'size'));
      if (opts.side.includes('b')) D.axes.y = axisState(el, 'y', sizeCands(el, 'y'), (r) => r.bottom, preferred(sizeCands(el, 'y'), el, 'y', 'size'));
      D.dead = 0;
    } else if (kind === 'space') {
      const axis = /top|bottom|row-gap/.test(opts.prop) ? 'y' : 'x';
      D.axes[axis] = axisState(opts.target || el, axis, [{ el: opts.target || el, prop: opts.prop, sign: 1, label: opts.prop }], null, 0);
      D.dead = 0;
    } else if (kind === 'order') {
      const p = el.parentElement;
      const pcs = p && getComputedStyle(p);
      if (!isFlexGrid(pcs)) { E.ctx.toast('⌘-drag reorders items of a flex or grid row — this parent is neither', true); return; }
      D.parent = p;
      D.kids = [...p.children].filter(inFlow);
      D.order0 = D.kids.slice().sort((a, b) => px(getComputedStyle(a).order) - px(getComputedStyle(b).order) || D.kids.indexOf(a) - D.kids.indexOf(b));
      D.idx = D.order0.indexOf(el);
    }
    E.drag = D;
    E.hover = null;
    Pg.pageStyle('drag', `*{cursor:${kind === 'order' ? 'grabbing' : kind === 'move' ? 'move' : 'crosshair'}!important;user-select:none!important}`);
    window.addEventListener('pointermove', dragMove, true);
    window.addEventListener('pointerup', dragUp, true);
    window.addEventListener('pointercancel', dragCancel, true);
    const tick = () => {
      if (E.drag !== D) return;
      if (D.auto) { window.scrollBy(0, D.auto); dragApply(); }
      D.raf = requestAnimationFrame(tick);
    };
    D.raf = requestAnimationFrame(tick);
    paint();
  }

  function dragMove(e) {
    const D = E.drag;
    if (!D) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    D.lastX = e.clientX;
    D.lastY = e.clientY;
    D.shift = e.shiftKey;
    const edge = 40, vh = window.innerHeight;
    D.auto = e.clientY < edge ? -Math.ceil((edge - e.clientY) / 3) : e.clientY > vh - edge ? Math.ceil((e.clientY - vh + edge) / 3) : 0;
    dragApply();
  }

  function dragApply() {
    const D = E.drag;
    if (!D) return;
    const d = { x: D.lastX + scrollX - (D.x0 + D.sx0), y: D.lastY + scrollY - (D.y0 + D.sy0) };
    if (D.kind === 'order') { D.drop = dropIndex(D, D.lastX, D.lastY); paint(); return; }
    for (const axis of ['x', 'y']) {
      const st = D.axes[axis];
      if (!st) continue;
      if (!st.active) { if (Math.abs(d[axis]) <= D.dead) continue; st.active = true; }
      const c = st.cands[st.ci];
      let dv = d[axis] / st.e;
      if (D.shift && c.prop !== 'translate') { const target = px(st.base) + dv; dv = Math.round(target / 4) * 4 - px(st.base); } else dv = Math.round(dv);
      st.value = candValue(c, st.base, dv, axis);
      preview(c.el, c.prop, st.value);
      if (!st.cal && st.meas && Math.abs(dv) >= 3) {
        const s = st.meas(D.el.getBoundingClientRect()) - st.pos0;
        if (Math.abs(s) >= 1) {
          const e = s / dv;
          st.e = Math.sign(e) * Math.min(5, Math.max(0.2, Math.abs(e)));
          st.cal = true;
        } else if (Math.abs(dv) >= 8) st.noEffect = true;
      }
    }
    paint();
  }

  function cycleCand(dir) {
    const D = E.drag;
    if (!D || D.kind === 'order' || D.kind === 'space') return;
    const st = Object.values(D.axes).filter(Boolean).find((s) => s.active) || D.axes.y || D.axes.x;
    if (!st || st.cands.length < 2) return;
    applyAll();
    st.ci = (st.ci + dir + st.cands.length) % st.cands.length;
    resetAxis(st, D.el);
    for (const o of Object.values(D.axes)) if (o && o !== st) { resetAxis(o, D.el); }
    E.via.set(D.kind + st.axis + '|' + uniqueSelector(D.el), st.cands[st.ci].label);
    dragApply();
  }

  function endDrag() {
    const D = E.drag;
    if (!D) return;
    cancelAnimationFrame(D.raf);
    window.removeEventListener('pointermove', dragMove, true);
    window.removeEventListener('pointerup', dragUp, true);
    window.removeEventListener('pointercancel', dragCancel, true);
    Pg.pageStyle('drag', null);
    E.drag = null;
    return D;
  }
  function dragUp(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const D = endDrag();
    if (!D) return;
    if (D.kind === 'order') return commitOrder(D);
    const changes = [];
    for (const st of Object.values(D.axes)) {
      if (!st || !st.active || st.value === st.base) continue;
      const c = st.cands[st.ci];
      changes.push({ el: c.el, prop: c.prop, from: st.base, to: st.value });
    }
    applyAll();
    if (changes.length) commit(changes);
    else paint();
  }
  function dragCancel() { endDrag(); applyAll(); paint(); }

  // ---------- reorder (flex / grid) ----------

  function dropIndex(D, cx, cy) {
    const others = D.order0.filter((k) => k !== D.el);
    for (let i = 0; i < others.length; i++) {
      const q = others[i].getBoundingClientRect();
      if (cy < q.top || (cy <= q.bottom && cx < q.left + q.width / 2)) return i;
    }
    return others.length;
  }
  function commitOrder(D) {
    const others = D.order0.filter((k) => k !== D.el);
    const i = D.drop == null ? D.idx : D.drop;
    const seq = [...others.slice(0, i), D.el, ...others.slice(i)];
    const tag = (k) => '#' + (D.kids.indexOf(k) + 1) + ' ' + labelOf(k);
    const sel = uniqueSelector(D.parent);
    const ex = list().find((e) => e.kind === 'order' && e.sel === sel);
    pushUndo();
    const l = Core.upsert(list(), {
      kind: 'order', sel, n: 1, label: labelOf(D.parent), src: srcOf(D.parent) || undefined, prop: 'order',
      from: ex ? ex.from : D.kids.map(tag), to: seq.map(tag), kids: seq.map((k) => uniqueSelector(k)),
    });
    setList(l);
  }

  // ---------- selection, hover, page events ----------

  function pickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || isOurs(el) || el === document.documentElement) return null;
    return el;
  }
  function select(el) {
    E.sel = el;
    E.selSel = el ? uniqueSelector(el) : null;
    paint();
    renderPanel();
  }

  const BLOCK = ['mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart'];
  function block(e) {
    if (!E.on || fromUs(e)) return;
    if (e.type === 'pointerup' && (E.pend || E.drag)) return; // pendUp / dragUp handle (and stop) it
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onDown(e) {
    if (!E.on || fromUs(e) || E.drag || E.ctx.blocked()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.button !== 0) return;
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) { select(null); return; }
    const inSel = E.sel && E.sel.contains(hit);
    E.pend = { x: e.clientX, y: e.clientY, hit, el: inSel ? E.sel : hit, meta: e.metaKey || e.ctrlKey };
    window.addEventListener('pointerup', pendUp, true);
  }
  function pendUp(e) {
    window.removeEventListener('pointerup', pendUp, true);
    const P = E.pend;
    E.pend = null;
    if (!P || E.drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    select(P.hit);
  }
  function onHover(e) {
    if (!E.on || E.ctx.blocked()) return;
    E.mouse = { x: e.clientX, y: e.clientY };
    if (E.pend && !E.drag && Math.hypot(e.clientX - E.pend.x, e.clientY - E.pend.y) > 3) {
      const P = E.pend;
      E.pend = null;
      window.removeEventListener('pointerup', pendUp, true);
      if (P.el !== E.sel) select(P.el);
      startDrag(P.meta ? 'order' : 'move', { x: P.x, y: P.y });
      dragMove(e);
      return;
    }
    if (E.drag) return;
    if (fromUs(e)) { if (E.hover) { E.hover = null; paint(); } return; }
    const el = pickAt(e.clientX, e.clientY);
    if (el !== E.hover) { E.hover = el; paint(); }
  }
  function onKeyUp(e) { if (e.key === 'Alt' && E.measure) { E.measure = false; paint(); } }
  function onBlur() { if (E.measure) { E.measure = false; paint(); } if (E.drag) dragCancel(); }

  function setMode(on) {
    if (!E.ctx || on === E.on) return;
    E.on = on;
    if (on) {
      window.addEventListener('pointerdown', onDown, true);
      for (const t of BLOCK) window.addEventListener(t, block, true);
      window.addEventListener('pointermove', onHover, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onBlur);
      Pg.pageStyle('edit', '*{cursor:default!important}');
      if (E.sel && !E.sel.isConnected) E.sel = null;
    } else {
      if (E.drag) dragCancel();
      window.removeEventListener('pointerdown', onDown, true);
      for (const t of BLOCK) window.removeEventListener(t, block, true);
      window.removeEventListener('pointermove', onHover, true);
      window.removeEventListener('pointerup', pendUp, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      Pg.pageStyle('edit', null);
      E.hover = null;
      E.pend = null;
      E.measure = false;
    }
    paint();
    renderPanel();
    E.ctx.changed();
  }

  // ---------- keyboard ----------

  function nudge(axis, step) {
    const el = E.sel;
    const cands = moveCands(el, axis);
    const c = cands[preferred(cands, el, axis, 'move')];
    const base = candBase(c);
    commit([{ el: c.el, prop: c.prop, from: base, to: candValue(c, base, step * c.sign, axis) }], 'nudge' + axis + c.prop);
    E.ctx.toast(`${c.label} ${short(base)} → ${short(candValue(c, base, step * c.sign, axis))}`);
  }
  function bump(prop, d) {
    const el = E.sel;
    const base = cur(el, prop);
    let b = px(base);
    if (prop === 'line-height' && base === 'normal') b = Math.round(px(cur(el, 'font-size')) * 1.2);
    commit([{ el, prop, from: base, to: fmt(Math.max(0, b + d)) }], 'bump' + prop);
  }
  function relatives(dir) {
    const el = E.sel;
    if (dir === 'parent') return el.parentElement && el.parentElement !== document.documentElement ? el.parentElement : null;
    if (dir === 'child') return [...el.children].find((c) => !isOurs(c) && c.getBoundingClientRect().width > 0) || null;
    let s = dir === 'next' ? el.nextElementSibling : el.previousElementSibling;
    while (s && (isOurs(s) || !s.getBoundingClientRect().width)) s = dir === 'next' ? s.nextElementSibling : s.previousElementSibling;
    return s;
  }
  function resetElement(el) {
    const t = scopeFor(el);
    const sel = uniqueSelector(el);
    const keep = list().filter((e) => !(e.sel === t.sel || e.sel === sel || targets(e).includes(el)));
    if (keep.length === list().length) return E.ctx.toast('No edits on this element');
    pushUndo();
    setList(keep);
    E.ctx.toast('Element reset');
  }
  function toggleHidden(el) {
    const t = scopeFor(el);
    const ex = list().find((e) => e.sel === t.sel && e.prop === 'display');
    if (ex && ex.to === 'none') { pushUndo(); setList(list().filter((e) => e !== ex)); return; }
    commit([{ el, prop: 'display', from: cur(el, 'display'), to: 'none' }]);
    E.ctx.toast('Hidden — select it in the list to bring it back (or ⌘Z)');
    select(null);
  }
  function toggleBefore() {
    E.before = !E.before;
    applyAll();
    paint();
    renderPanel();
    E.ctx.toast(E.before ? 'Before: your edits are off' : 'After: edits on');
  }

  function onKey(e) {
    if (!E.ctx) return false;
    const k = e.key;
    if (!E.on) return false;
    if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); return true; }
    if (e.metaKey || e.ctrlKey) return false;
    if (k === 'Alt') { if (!E.measure) { E.measure = true; paint(); } return false; }
    if (E.drag) {
      if (k === 'Escape') { dragCancel(); return true; }
      if (k === 'Tab') { cycleCand(e.shiftKey ? -1 : 1); return true; }
      return k !== 'Shift';
    }
    if (k === 'Escape') { if (E.sel) select(null); else setMode(false); return true; }
    if (k === 'b' || k === 'B') { toggleBefore(); return true; }
    if (k === 'a' || k === 'A') { E.all = !E.all; paint(); renderPanel(); E.ctx.toast(E.all ? 'Edits apply to all similar elements' : 'Edits apply to this element only'); return true; }
    if (!E.sel) return false;
    const step = e.shiftKey ? 10 : 1;
    if (k === 'Enter') { const r = relatives(e.shiftKey ? 'parent' : 'child'); if (r) select(r); return true; }
    if (k === 'Tab') { const r = relatives(e.shiftKey ? 'prev' : 'next'); if (r) select(r); return true; }
    if (!e.altKey && /^Arrow(Up|Down|Left|Right)$/.test(k)) { nudge(/Up|Down/.test(k) ? 'y' : 'x', /Up|Left/.test(k) ? -step : step); return true; }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') { bump(e.shiftKey ? 'line-height' : 'font-size', e.code === 'BracketLeft' ? -1 : 1); return true; }
    if (k === 'Backspace' || k === 'Delete') { toggleHidden(E.sel); return true; }
    if (k === 'r' || k === 'R') { resetElement(E.sel); return true; }
    return false;
  }

  // ---------- page layer ----------

  let host = null, root = null;
  function ensureHost() {
    if (host && host.isConnected) return;
    if (!host) {
      host = document.createElement('parity-edit');
      host.setAttribute('data-parity', '');
      host.style.cssText = `all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:${Z};pointer-events:none;display:block;`;
      root = host.attachShadow({ mode: 'open' });
      root.addEventListener('pointerdown', onZone);
    }
    document.documentElement.appendChild(host);
  }

  function onZone(e) {
    const z = e.target.closest && e.target.closest('[data-z]');
    if (!z || !E.sel || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [kind, a] = z.dataset.z.split(':');
    if (kind === 'size') startDrag('size', { x: e.clientX, y: e.clientY, side: a });
    else if (kind === 'gap') startDrag('space', { x: e.clientX, y: e.clientY, prop: a });
    else startDrag('space', { x: e.clientX, y: e.clientY, prop: a });
  }

  const LAYER_CSS = `
    *{box-sizing:border-box}
    .bx{position:absolute;pointer-events:none}
    .hov{outline:1px dashed rgba(200,255,61,.85);outline-offset:-1px}
    .sel{outline:1.5px solid ${LIME};outline-offset:-1px}
    .sim{outline:1px dashed rgba(200,255,61,.5);outline-offset:-1px}
    .mg{background:rgba(255,159,26,.22)}
    .pd{background:rgba(110,231,140,.24)}
    .gp{background:repeating-linear-gradient(45deg,rgba(255,61,139,.32) 0 4px,rgba(255,61,139,.08) 4px 8px)}
    .z{position:absolute;pointer-events:auto}
    .z:hover{background:rgba(200,255,61,.18)}
    .pill{border-radius:5px;box-shadow:0 0 0 1.5px #111;opacity:.9}
    .pill.m{background:#ff9f1a}.pill.p{background:#6ee78c}.pill.g{background:#ff3d8b}
    .pill:hover{background:${LIME};opacity:1}
    .h{position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;background:#111;border:1.5px solid ${LIME};border-radius:2px;pointer-events:none}
    .tag{position:absolute;pointer-events:none;white-space:nowrap;padding:2px 6px;border-radius:4px;font:600 10.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:${LIME};color:#111}
    .tag.dim{background:rgba(17,18,20,.92);color:${LIME};border:1px solid rgba(200,255,61,.4)}
    .tag i{font-style:normal;opacity:.6;margin-left:6px}
    .dot{position:absolute;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:${LIME};box-shadow:0 0 0 1.5px #111;pointer-events:none}
    .ms{position:absolute;background:#ff3d8b;pointer-events:none}
    .ml{position:absolute;pointer-events:none;transform:translate(-50%,-50%);padding:1px 5px;border-radius:4px;background:#ff3d8b;color:#fff;font:700 10px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap}
    .ins{position:absolute;background:${LIME};pointer-events:none;box-shadow:0 0 0 1px #111}
    .badge{position:absolute;pointer-events:none;padding:7px 9px;border-radius:9px;background:rgba(13,14,16,.97);color:#e9e9ec;border:1px solid rgba(200,255,61,.45);box-shadow:0 8px 24px rgba(0,0,0,.45);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
    .badge b{color:${LIME}}
    .badge s{text-decoration:none;color:#8b8d94}
    .badge .w{color:#ffc36b}
    .bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:calc(100vw - 28px);overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:12px;background:rgba(13,14,16,.96);color:#a3a5ad;border:1px solid rgba(200,255,61,.35);box-shadow:0 10px 30px -8px rgba(0,0,0,.6);font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;white-space:nowrap;pointer-events:none}
    .bar b{color:${LIME};font-weight:700;letter-spacing:.06em;font-size:10.5px}
    .bar kbd{font:600 9.5px ui-monospace,Menlo,monospace;padding:1px 4px;border-radius:4px;background:rgba(255,255,255,.1);color:#e9e9ec}
    .bar .bf{color:#111;background:#ffc36b;padding:1px 6px;border-radius:5px;font-weight:700}
  `;

  const box = (r, cls, extra) => `<div class="bx ${cls}" style="left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w)}px;height:${Math.max(0, r.h)}px${extra || ''}"></div>`;
  const zone = (r, z, cursor) => `<div class="z" data-z="${z}" title="${z.split(':')[1]}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;cursor:${cursor}"></div>`;

  function selectionHtml(el) {
    const r = docRect(el);
    const cs = getComputedStyle(el);
    const m = { t: px(cs.marginTop), r: px(cs.marginRight), b: px(cs.marginBottom), l: px(cs.marginLeft) };
    const p = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
    const bw = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth), b: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
    const ix = r.x + bw.l, iy = r.y + bw.t, iw = r.w - bw.l - bw.r, ih = r.h - bw.t - bw.b;
    let vis = '', hit = '';
    // margins (outside)
    if (m.t > 0) vis += box({ x: r.x, y: r.y - m.t, w: r.w, h: m.t }, 'mg');
    if (m.b > 0) vis += box({ x: r.x, y: r.b, w: r.w, h: m.b }, 'mg');
    if (m.l > 0) vis += box({ x: r.x - m.l, y: r.y, w: m.l, h: r.h }, 'mg');
    if (m.r > 0) vis += box({ x: r.r, y: r.y, w: m.r, h: r.h }, 'mg');
    // spacing handles: small pills centred in each strip, so the element body stays draggable
    const pill = (cx, cy, horiz, z, kind) => {
      const w = horiz ? 26 : 8, h = horiz ? 8 : 26;
      hit += `<div class="z pill ${kind}" data-z="${z}" title="${z.split(':')[1]}" style="left:${cx - w / 2}px;top:${cy - h / 2}px;width:${w}px;height:${h}px;cursor:${horiz ? 'ns-resize' : 'ew-resize'}"></div>`;
    };
    const mid = (v, min) => Math.max(v / 2, min);
    pill(r.x + r.w / 2, r.y - mid(m.t, 7), true, 'space:margin-top', 'm');
    pill(r.x + r.w / 2, r.b + mid(m.b, 7), true, 'space:margin-bottom', 'm');
    pill(r.x - mid(m.l, 7), r.y + r.h / 2, false, 'space:margin-left', 'm');
    pill(r.r + mid(m.r, 7), r.y + r.h / 2, false, 'space:margin-right', 'm');
    // padding (inside)
    if (p.t > 0) vis += box({ x: ix, y: iy, w: iw, h: p.t }, 'pd');
    if (p.b > 0) vis += box({ x: ix, y: iy + ih - p.b, w: iw, h: p.b }, 'pd');
    if (p.l > 0) vis += box({ x: ix, y: iy + p.t, w: p.l, h: ih - p.t - p.b }, 'pd');
    if (p.r > 0) vis += box({ x: ix + iw - p.r, y: iy + p.t, w: p.r, h: ih - p.t - p.b }, 'pd');
    // padding handles only where they fit inside the box without covering it
    if (ih >= 40 && iw >= 60) {
      pill(ix + iw / 2, iy + mid(p.t, 6), true, 'space:padding-top', 'p');
      pill(ix + iw / 2, iy + ih - mid(p.b, 6), true, 'space:padding-bottom', 'p');
    }
    if (iw >= 60 && ih >= 44) {
      pill(ix + mid(p.l, 6), iy + ih / 2, false, 'space:padding-left', 'p');
      pill(ix + iw - mid(p.r, 6), iy + ih / 2, false, 'space:padding-right', 'p');
    }
    // gaps between children of a flex / grid container
    const gapPills = [];
    if (isFlexGrid(cs)) {
      const kids = [...el.children].filter((k) => inFlow(k) && k.getBoundingClientRect().width > 0).map(docRect);
      const rows = [];
      for (const k of kids.slice().sort((a, b) => a.y - b.y)) {
        const row = rows.find((rw) => k.y < rw.b - 1 && k.b > rw.y + 1);
        if (row) { row.y = Math.min(row.y, k.y); row.b = Math.max(row.b, k.b); row.items.push(k); } else rows.push({ y: k.y, b: k.b, items: [k] });
      }
      rows.sort((a, b) => a.y - b.y);
      for (let i = 1; i < rows.length; i++) {
        const g = { x: ix + p.l, y: rows[i - 1].b, w: iw - p.l - p.r, h: rows[i].y - rows[i - 1].b };
        if (g.h > 0) vis += box(g, 'gp');
        gapPills.push([g.x + g.w / 2, g.y + g.h / 2, true, 'gap:row-gap', 'g']);
      }
      if (rows[0]) {
        const its = rows[0].items.sort((a, b) => a.x - b.x);
        for (let i = 1; i < its.length; i++) {
          const g = { x: its[i - 1].r, y: rows[0].y, w: its[i].x - its[i - 1].r, h: rows[0].b - rows[0].y };
          if (g.w > 0) vis += box(g, 'gp');
          gapPills.push([g.x + g.w / 2, g.y + g.h / 2, false, 'gap:column-gap', 'g']);
        }
      }
    }
    // size: right / bottom edges and the corner (pills sit on top of them)
    const edges = zone({ x: r.r - 4, y: r.y, w: 8, h: r.h }, 'size:r', 'ew-resize') + zone({ x: r.x, y: r.b - 4, w: r.w, h: 8 }, 'size:b', 'ns-resize') + zone({ x: r.r - 7, y: r.b - 7, w: 14, h: 14 }, 'size:rb', 'nwse-resize');
    for (const g of gapPills) pill(...g);
    let html = vis + box(r, 'sel') + edges + hit;
    html += `<div class="h" style="left:${r.r}px;top:${r.y + r.h / 2}px"></div><div class="h" style="left:${r.x + r.w / 2}px;top:${r.b}px"></div><div class="h" style="left:${r.r}px;top:${r.b}px"></div>`;
    const sim = E.all ? similarOf(el) : null;
    if (sim) for (const o of sim.els.slice(0, 60)) if (o !== el) html += box(docRect(o), 'sim');
    const below = r.b + 24 < scrollY + innerHeight;
    html += `<div class="tag" style="left:${r.x}px;top:${below ? r.b + 6 : r.y - 22}px">${esc(labelOf(el))}<i>${r2(r.w)} × ${r2(r.h)}${sim ? ` · all ${sim.n}` : ''}</i></div>`;
    return html;
  }

  // distance lines between the selection (a) and the hovered element or the parent (b)
  function measureHtml(a, b) {
    const A = docRect(a), B = docRect(b);
    let h = '';
    const line = (x1, y1, x2, y2) => {
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      if (len < 0.5) return '';
      const horiz = y1 === y2;
      return `<div class="ms" style="left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${horiz ? len : 1}px;height:${horiz ? 1 : len}px"></div><div class="ml" style="left:${(x1 + x2) / 2}px;top:${(y1 + y2) / 2}px">${r2(len)}</div>`;
    };
    const inside = (p, q) => p.x >= q.x - 0.5 && p.y >= q.y - 0.5 && p.r <= q.r + 0.5 && p.b <= q.b + 0.5;
    if (inside(A, B) || inside(B, A)) {
      const [I, O] = inside(A, B) ? [A, B] : [B, A];
      const cy = I.y + I.h / 2, cx = I.x + I.w / 2;
      h += line(O.x, cy, I.x, cy) + line(I.r, cy, O.r, cy) + line(cx, O.y, cx, I.y) + line(cx, I.b, cx, O.b);
    } else {
      const cy = (Math.max(A.y, B.y) + Math.min(A.b, B.b)) / 2;
      const yy = Math.max(A.y, B.y) < Math.min(A.b, B.b) ? cy : A.y + A.h / 2;
      if (B.x >= A.r) h += line(A.r, yy, B.x, yy); else if (B.r <= A.x) h += line(B.r, yy, A.x, yy);
      const cx = (Math.max(A.x, B.x) + Math.min(A.r, B.r)) / 2;
      const xx = Math.max(A.x, B.x) < Math.min(A.r, B.r) ? cx : A.x + A.w / 2;
      if (B.y >= A.b) h += line(xx, A.b, xx, B.y); else if (B.b <= A.y) h += line(xx, B.b, xx, A.y);
    }
    return box(B, 'hov') + h;
  }

  function badgeHtml() {
    const D = E.drag;
    if (!D) return '';
    let rows = '';
    if (D.kind === 'order') rows = '<b>reorder</b> <s>drop where it should go · Esc cancels</s>';
    else {
      for (const st of Object.values(D.axes)) {
        if (!st || (!st.active && D.kind === 'move')) continue;
        const c = st.cands[st.ci];
        const others = st.cands.filter((_, i) => i !== st.ci).map((o) => o.label.split(' ')[0] + (o.label.includes('parent') ? '↑' : o.label.includes('previous') ? '←' : '')).join(' · ');
        rows += `<div><b>${esc(c.label)}</b> ${esc(short(st.base))} → <b>${esc(short(st.value))}</b>${others ? ` <s>⇥ ${esc(others)}</s>` : ''}${st.noEffect ? ' <span class="w">no visible effect — try ⇥</span>' : ''}</div>`;
      }
      if (!rows) rows = '<s>drag ↕ or ↔ · ⇥ switches property · ⇧ 4px grid</s>';
    }
    return `<div class="badge" style="left:${D.lastX + scrollX + 16}px;top:${D.lastY + scrollY + 18}px">${rows}</div>`;
  }

  function orderHtml() {
    const D = E.drag;
    if (!D || D.kind !== 'order' || D.drop == null) return '';
    const others = D.order0.filter((k) => k !== D.el);
    const pr = docRect(D.parent);
    const row = getComputedStyle(D.parent).flexDirection.startsWith('row') || getComputedStyle(D.parent).display.includes('grid');
    let at;
    if (D.drop < others.length) { const q = docRect(others[D.drop]); at = row ? { x: q.x - 2, y: q.y, w: 3, h: q.h } : { x: q.x, y: q.y - 2, w: q.w, h: 3 }; }
    else { const q = docRect(others[others.length - 1] || D.el); at = row ? { x: q.r - 1, y: q.y, w: 3, h: q.h } : { x: q.x, y: q.b - 1, w: q.w, h: 3 }; }
    return box(pr, 'hov') + `<div class="ins" style="left:${at.x}px;top:${at.y}px;width:${at.w}px;height:${at.h}px"></div>`;
  }

  function paint() {
    if (E.raf) return;
    E.raf = requestAnimationFrame(() => { E.raf = 0; paintNow(); });
  }
  function paintNow() {
    if (!E.ctx) return;
    ensureHost();
    if (E.before || E.ctx.blocked()) { root.innerHTML = `<style>${LAYER_CSS}</style>${E.before && E.on ? '<div class="bar"><span class="bf">BEFORE</span> edits are off · <kbd>B</kbd> back to after</div>' : ''}`; return; }
    let html = `<style>${LAYER_CSS}</style>`;
    // dots on edited elements (current breakpoint)
    if (E.on) {
      let n = 0;
      for (const ed of list()) for (const el of ed.kind === 'order' ? [] : targets(ed)) {
        if (n++ > 150) break;
        const r = docRect(el);
        if (r.w || r.h) html += `<div class="dot" style="left:${r.x}px;top:${r.y}px"></div>`;
      }
    }
    if (E.on && E.hover && E.hover !== E.sel && !E.drag && !(E.measure && E.sel)) {
      const r = docRect(E.hover);
      html += box(r, 'hov') + `<div class="tag dim" style="left:${r.x}px;top:${Math.max(scrollY + 2, r.y - 22)}px">${esc(labelOf(E.hover))}<i>${r2(r.w)} × ${r2(r.h)}</i></div>`;
    }
    if (E.on && E.sel && E.sel.isConnected) {
      html += selectionHtml(E.sel);
      if (E.measure && E.on && !E.drag) {
        const other = E.hover && E.hover !== E.sel ? E.hover : E.sel.parentElement;
        if (other && other !== document.documentElement) html += measureHtml(E.sel, other);
      }
    }
    html += orderHtml() + badgeHtml();
    if (E.on && !E.drag) html += `<div class="bar"><b>EDIT</b><span>drag to move · edges size · pills spacing · <kbd>⇥</kbd> while dragging: other property · <kbd>⌘</kbd>drag reorder · <kbd>⌥</kbd> measure · <kbd>A</kbd> all similar${E.all ? ' ✓' : ''} · <kbd>B</kbd> before · <kbd>Esc</kbd></span></div>`;
    root.innerHTML = html;
  }

  // ---------- panel (Edit tab), mounted by content.js ----------

  const PANEL_CSS = `
    .ed .edbar{display:flex;gap:6px}
    .ed .edbar .btn.pri{flex:1;display:flex;justify-content:center;align-items:center;gap:8px;padding:8px 10px;font-size:12.5px}
    .ed .edbar .btn.pri.live{background:#111;color:#c8ff3d;box-shadow:inset 0 0 0 1.5px #c8ff3d}
    .ed .edbar .btn.pri.live kbd{background:rgba(200,255,61,.16)}
    .ed .hint{margin-top:10px}
    .ins2{margin-top:10px;padding:10px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07)}
    .ihead{display:flex;align-items:center;gap:6px;min-width:0}
    .ihead code{font:600 11.5px ui-monospace,Menlo,monospace;color:#c8ff3d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
    .ihead .icon{width:22px;height:22px}
    .isrc{margin-top:3px;font:10.5px ui-monospace,Menlo,monospace;color:#8b8d94;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:text}
    .iscope{display:flex;margin-top:8px;padding:2px;border-radius:8px;background:rgba(255,255,255,.05)}
    .iscope button{flex:1;padding:4px;border-radius:6px;color:#a3a5ad;font-weight:600;font-size:11px}
    .iscope button.on{background:rgba(255,255,255,.12);color:#fff}
    .iscope button[disabled]{opacity:.35;cursor:default}
    .ig{margin-top:10px}
    .ig > span{display:block;color:#6f7179;font-size:9.5px;text-transform:uppercase;letter-spacing:.09em;font-weight:650;margin-bottom:5px}
    .fr{display:grid;grid-template-columns:1fr 1fr;gap:5px}
    .fr.three{grid-template-columns:1fr 1fr 1fr}
    .f{display:flex;align-items:center;gap:0;border-radius:7px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);min-width:0;position:relative}
    .f > i{font-style:normal;color:#6f7179;font-size:10px;font-weight:600;padding:0 0 0 7px;cursor:ew-resize;white-space:nowrap}
    .f input{all:unset;flex:1;min-width:0;width:100%;padding:5px 7px 5px 5px;font:11.5px ui-monospace,Menlo,monospace;color:#e9e9ec;cursor:ew-resize}
    .f input:focus{cursor:text;color:#fff}
    .f:focus-within{border-color:#c8ff3d}
    .f.ed{border-color:rgba(200,255,61,.5)}
    .f.ed > i{color:#c8ff3d}
    .f .x{position:absolute;right:-5px;top:-6px;width:13px;height:13px;border-radius:50%;background:#2a2c31;color:#c9cad0;font-size:9px;line-height:13px;text-align:center;display:none}
    .f.ed:hover .x{display:block}
    .f .sw{width:14px;height:14px;border-radius:4px;margin-left:6px;flex:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
    .f .dp{all:unset;cursor:pointer;color:#8b8d94;padding:0 6px;font-size:11px}
    .f .dp:hover{color:#c8ff3d}
    .bm{position:relative;display:grid;grid-template-columns:44px 1fr 44px;grid-template-rows:auto 1fr auto;gap:3px;padding:16px 4px 4px;border-radius:9px;border:1px dashed rgba(255,159,26,.45);background:rgba(255,159,26,.06)}
    .bm.p{border-color:rgba(110,231,140,.5);background:rgba(110,231,140,.07);padding:16px 4px 4px}
    .bm > b{position:absolute;left:7px;top:3px;font-size:9px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#8b8d94}
    .bm .f{background:transparent;border-color:transparent}
    .bm .f:hover{border-color:rgba(255,255,255,.15)}
    .bm .f.ed{border-color:rgba(200,255,61,.5)}
    .bm .f input{text-align:center;padding:3px 2px}
    .bm .t{grid-column:2;grid-row:1}.bm .l{grid-column:1;grid-row:2;align-self:center}.bm .r{grid-column:3;grid-row:2;align-self:center}.bm .b{grid-column:2;grid-row:3}
    .bm .c{grid-column:2;grid-row:2}
    .bm .core{display:grid;place-items:center;height:28px;border-radius:6px;background:rgba(255,255,255,.06);font:10.5px ui-monospace,Menlo,monospace;color:#a3a5ad}
    .elist{margin-top:12px}
    .elist .lh{display:flex;align-items:center;justify-content:space-between;color:#8b8d94;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:6px}
    .erows{max-height:190px;overflow:auto;border-radius:9px;background:rgba(0,0,0,.2)}
    .er{display:flex;gap:6px;align-items:flex-start;padding:6px 6px 6px 9px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer}
    .er:hover{background:rgba(255,255,255,.05)}
    .er.on{background:rgba(200,255,61,.08)}
    .er .t{flex:1;min-width:0;font-size:11px;color:#d6d7db;line-height:1.4}
    .er .t code{display:block;font:600 10.5px ui-monospace,Menlo,monospace;color:#c8ff3d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .er .t small{display:block;color:#6f7179;font:10px ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .er.miss .t code{color:#8b8d94;text-decoration:line-through}
    .er .icon{width:20px;height:20px;flex:none}
    .exp{display:flex;gap:6px;margin-top:10px}
    .exp .btn{flex:1;padding:8px 6px}
    .exp .btn.pri{flex:1.4}
    .tot{margin-top:6px;color:#6f7179;font-size:10.5px;text-align:center}
  `;

  const FIELDS = {
    size: [['width', 'W'], ['height', 'H']],
    layout: [['row-gap', 'Row gap'], ['column-gap', 'Col gap']],
    type: [['font-size', 'Size'], ['line-height', 'Line'], ['letter-spacing', 'Track'], ['font-weight', 'Weight']],
    fill: [['border-radius', 'Radius'], ['opacity', 'Opacity']],
    pos: [['top', 'Top'], ['left', 'Left'], ['bottom', 'Bottom'], ['right', 'Right']],
  };
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || (el.innerText || '').trim().length > 0;

  function editOf(el, prop) {
    const t = scopeFor(el);
    return list().find((e) => e.sel === t.sel && (e.exact || 0) === (t.exact || 0) && e.prop === prop);
  }
  function field(el, prop, lab, cls) {
    const ed = editOf(el, prop);
    const v = cur(el, prop);
    const isColor = COLOR.test(prop);
    const val = isColor ? v : short(v);
    return `<label class="f ${ed ? 'ed' : ''} ${cls || ''}" title="${esc(prop)}${ed ? ` — was ${esc(ed.from)}` : ''}">${lab ? `<i data-scrub="${prop}">${esc(lab)}</i>` : ''}${isColor ? `<span class="sw" style="background:${esc(v)}"></span>` : ''}<input data-p="${prop}" value="${esc(val)}" spellcheck="false">${isColor && 'EyeDropper' in window ? `<button class="dp" data-e="drop" data-p="${prop}" title="Pick from screen (design overlay included)">◉</button>` : ''}${ed ? `<button class="x" data-e="unset" data-p="${prop}" title="Back to ${esc(ed.from)}">×</button>` : ''}</label>`;
  }

  function inspectorHtml(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const sim = similarOf(el);
    const src = srcOf(el);
    const sides = (k) => ['top', 'right', 'bottom', 'left'].map((s) => field(el, `${k}-${s}`, '', s[0]));
    const [mt, mr, mb, ml] = sides('margin');
    const [pt, pr, pb, pl] = sides('padding');
    let h = `<div class="ins2">
      <div class="ihead"><code title="${esc(uniqueSelector(el))}">${esc(labelOf(el))}</code>
        <button class="icon" data-e="nav" data-v="parent" title="Parent (⇧↵)">↑</button><button class="icon" data-e="nav" data-v="child" title="First child (↵)">↓</button>
        <button class="icon" data-e="copy" title="Copy the class list">⧉</button><button class="icon" data-e="reset" title="Reset this element (R)">↺</button></div>
      <div class="isrc" title="${esc(src || uniqueSelector(el))}">${esc(src || uniqueSelector(el))}</div>
      <div class="iscope"><button class="${E.all && sim ? '' : 'on'}" data-e="scope" data-v="one">This element</button><button class="${E.all && sim ? 'on' : ''}" data-e="scope" data-v="all" ${sim ? '' : 'disabled title="No other element has exactly these classes"'}>All similar${sim ? ' ×' + sim.n : ''} <kbd>A</kbd></button></div>
      <div class="ig"><span>Size · ${r2(r.width)} × ${r2(r.height)}</span><div class="fr">${FIELDS.size.map(([p, l]) => field(el, p, l)).join('')}${cs.maxWidth !== 'none' ? field(el, 'max-width', 'Max W') : ''}</div></div>
      <div class="ig"><span>Spacing</span><div class="bm"><b>margin</b>${mt}${ml}${mr}${mb}
        <div class="c"><div class="bm p"><b>padding</b>${pt}${pl}${pr}${pb}<div class="c core">${r2(px(cs.width))} × ${r2(px(cs.height))}</div></div></div></div></div>`;
    if (isFlexGrid(cs)) h += `<div class="ig"><span>${cs.display.includes('grid') ? 'Grid' : 'Flex ' + cs.flexDirection}</span><div class="fr">${FIELDS.layout.map(([p, l]) => field(el, p, l)).join('')}</div></div>`;
    if (/absolute|fixed|relative|sticky/.test(cs.position)) h += `<div class="ig"><span>Position · ${cs.position}</span><div class="fr">${FIELDS.pos.map(([p, l]) => field(el, p, l)).join('')}</div></div>`;
    if (hasText(el)) h += `<div class="ig"><span>Text</span><div class="fr">${FIELDS.type.map(([p, l]) => field(el, p, l)).join('')}</div><div class="fr" style="margin-top:5px;grid-template-columns:1fr">${field(el, 'color', 'Color')}</div></div>`;
    h += `<div class="ig"><span>Fill</span><div class="fr" style="grid-template-columns:1fr">${field(el, 'background-color', 'Fill')}</div><div class="fr" style="margin-top:5px">${FIELDS.fill.map(([p, l]) => field(el, p, l)).join('')}</div></div>`;
    return h + '</div>';
  }

  function groups() {
    const g = new Map();
    for (const e of list()) {
      const k = e.sel + '#' + (e.exact || 0);
      if (!g.has(k)) g.set(k, { sel: e.sel, exact: e.exact, label: e.label, n: e.n, edits: [] });
      g.get(k).edits.push(e);
    }
    return [...g.values()];
  }
  function theme() { if (E.theme === undefined) { try { E.theme = Pg.scanTheme(); } catch (e) { E.theme = null; } } return E.theme; }

  function panelHtml() {
    const b = bp();
    const gs = groups();
    const total = E.ctx.bps().reduce((n, x) => n + (x.edits || []).length, 0);
    const T = theme();
    const prefix = T && b ? Core.prefixFor(b.width, E.ctx.bps().map((x) => x.width), T) : null;
    const selKey = E.sel ? [uniqueSelector(E.sel), similarOf(E.sel) && similarOf(E.sel).sel] : [];
    let h = `<div class="ed"><div class="edbar"><button class="btn pri ${E.on ? 'live' : ''}" data-e="mode">${E.on ? 'Editing — click to stop' : 'Edit the page'} <kbd>E</kbd></button><button class="tp ${E.before ? 'on' : ''}" data-e="before" title="Before / after (B)">Before</button></div>`;
    if (E.on && E.sel && E.sel.isConnected) h += inspectorHtml(E.sel);
    else h += `<div class="hint">${E.on ? 'Click an element on the page. Drag it to move it, drag its edges for size, the green/orange strips for padding/margin, pink strips for gap. ⇥ while dragging switches the property.' : 'Turn on Edit, then line elements up with the design overlay by hand. Every change is recorded as real CSS for this breakpoint.'}</div>`;
    h += `<div class="elist"><div class="lh"><span>${b ? `${b.width}px` : ''} · ${list().length} change${list().length === 1 ? '' : 's'}${prefix != null ? ` · ${prefix ? prefix + ':' : 'base'}` : ''}</span>${list().length ? '<button class="link" data-e="clear" style="text-transform:none;letter-spacing:0">clear</button>' : ''}</div>`;
    if (gs.length) {
      h += '<div class="erows">';
      for (const g of gs) {
        const miss = g.edits[0].kind === 'order' ? false : !targets(g.edits[0]).length;
        const tw = T ? g.edits.map((e) => Core.twSuggest(e, prefix, T)).filter(Boolean).map((s) => s.suggested).join(' ') : '';
        h += `<div class="er ${miss ? 'miss' : ''} ${selKey.includes(g.sel) ? 'on' : ''}" data-e="goto" data-sel="${esc(g.sel)}" data-x="${g.exact || 0}"><div class="t"><code>${esc(g.label)}${g.n > 1 ? ' ×' + g.n : ''}</code>${esc(g.edits.map(Core.describe).join(' · '))}${tw ? `<small>${esc(tw)}</small>` : ''}</div><button class="icon" data-e="drop-group" data-sel="${esc(g.sel)}" data-x="${g.exact || 0}" title="Revert">×</button></div>`;
      }
      h += '</div>';
    }
    h += `</div><div class="exp"><button class="btn pri" data-e="copy-md" ${total ? '' : 'disabled'}>Copy edits.md</button><button class="btn" data-e="download" ${total ? '' : 'disabled'}>Download</button></div>`;
    if (total) h += `<div class="tot">${total} change${total === 1 ? '' : 's'} across ${E.ctx.bps().filter((x) => (x.edits || []).length).length} breakpoint(s) in the export</div>`;
    return h + '</div>';
  }

  function renderPanel() {
    const m = E.mountEl;
    if (!m || !m.isConnected) return;
    const focused = m.querySelector('input:focus');
    if (focused) return; // don't steal the caret while typing
    const sc = m.querySelector('.erows');
    const top = sc ? sc.scrollTop : 0;
    m.innerHTML = panelHtml();
    const sc2 = m.querySelector('.erows');
    if (sc2) sc2.scrollTop = top;
  }

  function parseInput(prop, raw, el) {
    let v = String(raw).trim();
    if (!v) return null;
    if (COLOR.test(prop)) { const h = toHex(v.startsWith('#') || /^[a-z]+\(|^[a-z]+$/i.test(v) ? v : '#' + v); return h || null; }
    if (prop === 'font-weight' || prop === 'opacity') return String(parseFloat(v));
    if (prop === 'line-height' && /^[\d.]+$/.test(v) && parseFloat(v) < 4) return fmt(parseFloat(v) * px(cur(el, 'font-size')));
    if (/^-?[\d.]+$/.test(v)) return fmt(parseFloat(v));
    return v;
  }

  function wirePanel(m) {
    m.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-e]');
      if (!t) return;
      e.preventDefault();
      const a = t.dataset.e;
      if (a === 'mode') setMode(!E.on);
      else if (a === 'before') toggleBefore();
      else if (a === 'nav' && E.sel) { const r = relatives(t.dataset.v); if (r) select(r); }
      else if (a === 'copy' && E.sel) { const ok = await E.ctx.copy(E.sel.getAttribute('class') || uniqueSelector(E.sel)); E.ctx.toast(ok ? 'Copied' : 'Copy failed', !ok); }
      else if (a === 'reset' && E.sel) resetElement(E.sel);
      else if (a === 'scope') { E.all = t.dataset.v === 'all'; paint(); renderPanel(); }
      else if (a === 'unset' && E.sel) {
        const ed = editOf(E.sel, t.dataset.p);
        if (ed) { pushUndo(); setList(list().filter((x) => x !== ed)); }
      } else if (a === 'drop' && E.sel) {
        const el = E.sel, prop = t.dataset.p;
        try {
          const r = await new window.EyeDropper().open();
          commit([{ el, prop, from: cur(el, prop), to: r.sRGBHex.toLowerCase() }]);
        } catch (err) { /* cancelled */ }
      } else if (a === 'goto') {
        const g = { sel: t.dataset.sel, exact: +t.dataset.x };
        const el = targets(g)[0];
        if (!el) return E.ctx.toast('Not on the page right now (hidden or not rendered)', true);
        if (getComputedStyle(el).display === 'none') return E.ctx.toast('Hidden by your edit — × removes it', true);
        if (!E.on) setMode(true);
        E.all = g.exact > 0;
        select(el);
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        paint();
      } else if (a === 'drop-group') {
        e.stopPropagation();
        pushUndo();
        setList(list().filter((x) => !(x.sel === t.dataset.sel && (x.exact || 0) === +t.dataset.x)));
      } else if (a === 'clear') {
        if (!t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'sure?'; setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = 'clear'; } }, 2500); return; }
        pushUndo();
        setList([]);
      } else if (a === 'copy-md') {
        const ok = await E.ctx.copy(Core.toMarkdown(exportDoc()));
        E.ctx.toast(ok ? 'edits.md copied — paste it into your coding agent' : 'Copy failed', !ok);
      } else if (a === 'download') {
        const doc = exportDoc();
        let slug = location.host + location.pathname;
        slug = slug.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
        const dir = `${E.ctx.settings().folder || 'parity'}/${slug}`;
        await E.ctx.download(`${dir}/edits.md`, Core.toMarkdown(doc), 'text/markdown');
        await E.ctx.download(`${dir}/edits.json`, JSON.stringify(Core.toJson(doc), null, 2), 'application/json');
        E.ctx.toast(`Saved Downloads/${dir}/edits.md + .json`);
      }
    });
    // scrub: drag on a field label or its input; a plain click focuses the input for typing
    m.addEventListener('pointerdown', (e) => {
      const lab = e.target.closest('[data-scrub]');
      const inp = e.target.closest('input[data-p]');
      if ((!lab && !inp) || !E.sel || (inp && document.activeElement === inp) || (inp && inp.matches(':focus'))) return;
      const prop = lab ? lab.dataset.scrub : inp.dataset.p;
      if (COLOR.test(prop)) return;
      const input = inp || lab.parentElement.querySelector('input');
      if (input && input.getRootNode().activeElement === input) return;
      e.preventDefault();
      const el = E.sel;
      const base = cur(el, prop);
      const step = prop === 'font-weight' ? 100 : prop === 'opacity' ? 0.05 : 1;
      let b0 = px(base);
      if (prop === 'line-height' && base === 'normal') b0 = Math.round(px(cur(el, 'font-size')) * 1.2);
      const x0 = e.clientX, y0 = e.clientY;
      let moved = false, val = null;
      const mv = (ev) => {
        const d = Math.round((ev.clientX - x0 - (ev.clientY - y0)) / 2);
        if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 3) return;
        moved = true;
        let v = b0 + d * step;
        if (ev.shiftKey && step === 1) v = Math.round(v / 4) * 4;
        if (prop === 'opacity') v = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
        else if (prop === 'font-weight') v = Math.min(900, Math.max(100, v));
        else if (!/^(margin|top|left|right|bottom|letter-spacing)/.test(prop)) v = Math.max(0, v);
        val = prop === 'opacity' || prop === 'font-weight' ? String(v) : fmt(v);
        preview(el, prop, val);
        if (input) input.value = short(val);
        paint();
      };
      const up = () => {
        window.removeEventListener('pointermove', mv, true);
        window.removeEventListener('pointerup', up, true);
        if (!moved) { if (input) { input.focus(); input.select(); } return; }
        applyAll();
        if (val != null) commit([{ el, prop, from: base, to: val }]);
      };
      window.addEventListener('pointermove', mv, true);
      window.addEventListener('pointerup', up, true);
    });
    m.addEventListener('change', (e) => {
      const inp = e.target.closest('input[data-p]');
      if (!inp || !E.sel) return;
      const prop = inp.dataset.p;
      const v = parseInput(prop, inp.value, E.sel);
      inp.blur();
      if (v == null) return renderPanel();
      commit([{ el: E.sel, prop, from: cur(E.sel, prop), to: v }]);
    });
    m.addEventListener('keydown', (e) => {
      const inp = e.target.closest('input[data-p]');
      if (!inp) return;
      if (e.key === 'Enter') { inp.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (e.key === 'Escape') { inp.blur(); renderPanel(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !COLOR.test(inp.dataset.p)) {
        e.preventDefault();
        const st = (inp.dataset.p === 'font-weight' ? 100 : inp.dataset.p === 'opacity' ? 0.05 : 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        inp.value = String(r2(px(inp.value) + st));
      }
      e.stopPropagation();
    });
  }

  // edits sorted by where their element sits in the page (missing ones last), flagged when not found
  function inPageOrder(edits) {
    const withEl = edits.map((e, i) => {
      let el = null;
      try { el = e.kind === 'order' ? document.querySelector(e.sel) : targets(e)[0]; } catch (err) { /* bad selector */ }
      return { e: { ...e, missing: !el || undefined }, el, i };
    });
    withEl.sort((a, b) => {
      if (!a.el || !b.el) return (a.el ? 0 : 1) - (b.el ? 0 : 1) || a.i - b.i;
      if (a.el === b.el) return a.i - b.i;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return withEl.map((x) => x.e);
  }

  function exportDoc() {
    return {
      url: location.href,
      title: document.title,
      at: new Date().toISOString(),
      tailwind: theme(),
      bps: E.ctx.bps().map((b) => ({
        width: b.width, name: b.name, file: b.file,
        edits: inPageOrder(b.edits || []),
      })),
    };
  }

  // ---------- lifecycle ----------

  globalThis.ParityEditor = {
    CSS: PANEL_CSS,
    attach(ctx) {
      E.ctx = ctx;
      E.theme = undefined;
      ensureHost();
      applyAll();
      obs.observe(document.documentElement, { childList: true, subtree: true });
      paint();
    },
    detach() {
      if (!E.ctx) return;
      setMode(false);
      obs.disconnect();
      clearTimeout(E.reT);
      unapplyAll();
      if (host) host.remove();
      E.sel = null;
      E.hover = null;
      E.before = false;
      E.ctx = null;
      E.mountEl = null;
    },
    refresh() { // breakpoint switched or project reloaded
      if (!E.ctx) return;
      if (E.drag) dragCancel();
      applyAll();
      paint();
      renderPanel();
    },
    mount(el) {
      if (!el) { E.mountEl = null; return; }
      if (!el.__parityWired) { wirePanel(el); el.__parityWired = true; }
      E.mountEl = el;
      el.innerHTML = panelHtml();
    },
    setMode,
    toggle() { setMode(!E.on); },
    isOn: () => E.on,
    onKey,
    onScroll() { if (E.ctx) paint(); },
    count: (b) => ((b && b.edits) || []).length,
    exportDoc,
  };
})();
