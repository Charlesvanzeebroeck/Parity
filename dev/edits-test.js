// Unit tests for edits-core.js (edit model, Tailwind mapping, export). Run: node dev/edits-test.js
const assert = require('assert');
const C = require('../edits-core.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('upsert keeps the first from, updates to, drops no-ops', () => {
  let l = C.upsert([], { sel: '.a', prop: 'margin-top', from: '24px', to: '32px' });
  l = C.upsert(l, { sel: '.a', prop: 'margin-top', from: '32px', to: '40px' });
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].from, '24px');
  assert.strictEqual(l[0].to, '40px');
  l = C.upsert(l, { sel: '.a', prop: 'margin-top', from: '40px', to: '24px' });
  assert.strictEqual(l.length, 0);
  assert.strictEqual(C.upsert([], { sel: '.a', prop: 'gap', from: '8px', to: '8px' }).length, 0);
  // same selector, different scope (exact) is a different target
  l = C.upsert([{ sel: 'h3.t', prop: 'font-size', from: '22px', to: '24px' }], { sel: 'h3.t', exact: 1, prop: 'font-size', from: '22px', to: '26px' });
  assert.strictEqual(l.length, 2);
});

t('describe', () => {
  assert.strictEqual(C.describe({ prop: 'padding-top', from: '20px', to: '24px' }), 'padding-top 20 → 24px');
  assert.strictEqual(C.describe({ prop: 'line-height', from: 'normal', to: '28px' }), 'line-height normal → 28px');
  assert.strictEqual(C.describe({ prop: 'display', from: 'flex', to: 'none' }), 'hidden');
  assert.strictEqual(C.describe({ kind: 'order', prop: 'order', from: ['#1 a', '#2 b'], to: ['#2 b', '#1 a'] }), 'children order #1 a, #2 b → #2 b, #1 a');
  assert.strictEqual(C.describe({ kind: 'order', prop: 'order', from: ['#1 div.card', '#2 div.card', '#3 div.card'], to: ['#2 div.card', '#1 div.card', '#3 div.card'] }), 'children order #1, #2, #3 → #2, #1, #3 (div.card ×3)');
});

t('Tailwind v4 utilities', () => {
  const T = { v4: true, spacing: 4, text: { lg: 14, base: 16, xl: 20, '2xl': 24 }, colors: { '#c8ff3d': 'lime-brand' }, radius: { lg: 8 }, containers: { '7xl': 1280 } };
  assert.strictEqual(C.twUtility('padding-top', '24px', T), 'pt-6');
  assert.strictEqual(C.twUtility('padding-top', '22px', T), 'pt-5.5');
  assert.strictEqual(C.twUtility('padding-top', '21px', T), 'pt-[21px]');
  assert.strictEqual(C.twUtility('margin-top', '-16px', T), '-mt-4');
  assert.strictEqual(C.twUtility('margin-top', '1px', T), 'mt-px');
  assert.strictEqual(C.twUtility('row-gap', '32px', T), 'gap-y-8');
  assert.strictEqual(C.twUtility('font-size', '24px', T), 'text-2xl');
  assert.strictEqual(C.twUtility('font-size', '22px', T), 'text-[22px]');
  assert.strictEqual(C.twUtility('line-height', '28px', T), 'leading-7');
  assert.strictEqual(C.twUtility('color', '#c8ff3d', T), 'text-lime-brand');
  assert.strictEqual(C.twUtility('background-color', '#123456', T), 'bg-[#123456]');
  assert.strictEqual(C.twUtility('border-radius', '8px', T), 'rounded-lg');
  assert.strictEqual(C.twUtility('max-width', '1280px', T), 'max-w-7xl');
  assert.strictEqual(C.twUtility('display', 'none', T), 'hidden');
  assert.strictEqual(C.twUtility('font-weight', '600', T), 'font-semibold');
  assert.strictEqual(C.twUtility('translate', '0px -12px', T), '-translate-y-3');
  assert.strictEqual(C.twUtility('width', '520px', T), 'w-130');
});

t('Tailwind v3 scale', () => {
  const T = { v4: false };
  assert.strictEqual(C.twUtility('padding-top', '24px', T), 'pt-6');
  assert.strictEqual(C.twUtility('padding-top', '52px', T), 'pt-[52px]');
  assert.strictEqual(C.twUtility('width', '520px', T), 'w-[520px]');
  assert.strictEqual(C.twUtility('line-height', '28px', T), 'leading-7');
  assert.strictEqual(C.twUtility('border-radius', '4px', T), 'rounded');
  assert.strictEqual(C.twUtility('font-size', '30px', T), 'text-3xl');
});

t('related classes respect responsive variants only', () => {
  const T = { v4: true };
  assert.deepStrictEqual(C.twRelated('padding-top', 'flex py-5 lg:pt-6 hover:pt-2 px-4', T), ['py-5', 'lg:pt-6']);
  assert.deepStrictEqual(C.twRelated('font-size', 'text-xl text-white md:text-[22px] text-center', T), ['text-xl', 'md:text-[22px]']);
  assert.deepStrictEqual(C.twRelated('color', 'text-xl text-white text-center', T), ['text-white']);
  assert.deepStrictEqual(C.twRelated('row-gap', 'grid gap-6 gap-x-4', T), ['gap-6']);
});

t('responsive prefix (mobile-first)', () => {
  assert.strictEqual(C.prefixFor(375, [375, 1440], {}), '');
  assert.strictEqual(C.prefixFor(1440, [375, 1440], {}), 'lg');
  assert.strictEqual(C.prefixFor(1920, [375, 1440, 1920], {}), '2xl');
  assert.strictEqual(C.prefixFor(1440, [375, 768, 1440], {}), 'lg');
  assert.strictEqual(C.prefixFor(768, [375, 768, 1440], {}), 'md');
  assert.strictEqual(C.prefixFor(1440, [1440], {}), 'lg');
  assert.strictEqual(C.prefixFor(900, [900], {}), 'md');
});

t('markdown export', () => {
  const doc = {
    url: 'http://localhost:4321/about', title: 'About', at: '2026-10-21T22:10:00.000Z',
    tailwind: { v4: true, text: { '2xl': 24 } },
    bps: [
      { width: 375, name: 'Mobile', edits: [] },
      { width: 1440, name: 'Desktop', file: 'home-1440.jpg', edits: [
        { sel: 'header.site', n: 1, label: 'header.site', src: 'src/components/Header.astro:4', cls: 'flex py-5', prop: 'padding-top', from: '20px', to: '24px' },
        { sel: 'h3.card-title', exact: 2, n: 3, label: 'h3.card-title', cls: 'card-title text-[22px]', prop: 'font-size', from: '22px', to: '24px' },
        { sel: 'main > p', n: 1, label: 'p', prop: 'display', from: 'block', to: 'none', missing: true },
      ] },
    ],
  };
  const md = C.toMarkdown(doc);
  console.log('\n' + md);
  assert(md.startsWith('# Parity edits · localhost:4321/about'));
  assert(md.includes('3 changes · 1440px'));
  assert(md.includes('## 1440px · Desktop · `lg:` (≥1024px)'));
  assert(md.includes('### src/components/Header.astro:4 · `header.site`'));
  assert(md.includes('- padding-top 20 → 24px · `py-5` → `lg:pt-6`'));
  assert(md.includes('### `h3.card-title` ×3'));
  assert(md.includes('- font-size 22 → 24px · `text-[22px]` → `lg:text-2xl`'));
  assert(md.includes('- hidden · add `lg:hidden` · (element not found on the page at export)'));
  assert(!md.includes('375px ·'), 'breakpoints without edits are skipped');
  const js = C.toJson(doc);
  assert.strictEqual(js.schema, 'parity.edits/1');
  assert.strictEqual(js.breakpoints[0].elements[1].count, 3);
  assert.strictEqual(js.breakpoints[0].elements[0].changes[0].tailwind.suggested, 'lg:pt-6');
});

t('markdown without Tailwind', () => {
  const md = C.toMarkdown({ url: 'https://x.dev/', at: '2026-10-21T22:10:00Z', tailwind: null, bps: [{ width: 1280, edits: [{ sel: '#hero', n: 1, label: 'section#hero', prop: 'margin-top', from: '0px', to: '16px' }] }] });
  assert(md.includes('## 1280px\n'));
  assert(md.includes('### `#hero`\n- margin-top 0 → 16px\n'));
});

console.log(`\n${n} passed`);
