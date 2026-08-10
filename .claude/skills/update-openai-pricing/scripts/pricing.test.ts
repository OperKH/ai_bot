// node --test .claude/skills/update-openai-pricing/scripts/pricing.test.ts
//
// (add --experimental-test-coverage for a coverage table; requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import {
  applyPricingUpdate,
  cellText,
  decodeAstroValue,
  decodeHtmlEntities,
  extractIslands,
  extractPrices,
  findPricingBlock,
  formatPrice,
  modelFamily,
  normalizeModelName,
  parseAmount,
  planColumns,
  renderEntries,
  type ModelPrice,
} from './pricing.ts';

const FIXTURE = readFileSync(new URL('../fixtures/pricing-page.html', import.meta.url), 'utf8');

// --- helpers ---------------------------------------------------------------

/** Inverse of Astro's prop serialisation, so edge cases can be written as plain data. */
function encodeAstroValue(value: unknown): unknown {
  if (Array.isArray(value)) return [1, value.map(encodeAstroValue)];
  if (value !== null && typeof value === 'object') {
    return [0, Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encodeAstroValue(inner)]))];
  }
  return [0, value];
}

function island(component: string, props: Record<string, unknown>): string {
  const serialized = JSON.stringify(
    Object.fromEntries(Object.entries(props).map(([key, value]) => [key, encodeAstroValue(value)])),
  );
  const escaped = serialized
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<astro-island component-export="${component}" props="${escaped}"></astro-island>`;
}

const textTokenIsland = (tier: string, rows: unknown[][]): string => island('TextTokenPricingTables', { tier, rows });

const priceOf = (
  html: string,
  model: string,
  options?: Parameters<typeof extractPrices>[1],
): ModelPrice | undefined => {
  const found = extractPrices(html, options).prices.get(model);
  return found && { input: found.input, cached: found.cached, output: found.output };
};

const TARGET = [
  "import OpenAI from 'openai';",
  '',
  '// Pricing per 1M tokens (USD) - Standard tier',
  '// Source: https://developers.openai.com/api/docs/pricing',
  'const MODEL_PRICING: Record<string, { input: number; cached: number; output: number }> = {',
  "  'gpt-5.4-mini': { input: 0.1, cached: 0.2, output: 0.3 },",
  "  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },",
  '  o1: { input: 15.0, cached: 7.5, output: 60.0 },',
  "  'o1-mini': { input: 1.1, cached: 0.55, output: 4.4 },", // retired: no longer on the page
  '};',
  '',
  'export class OpenAIService {}',
].join('\n');

// --- Astro decoding --------------------------------------------------------

describe('Astro prop decoding', () => {
  it('decodes entities with &amp; resolved last', (t: TestContext) => {
    t.assert.strictEqual(decodeHtmlEntities('&quot;a&quot; &lt;272K&gt; &amp;&#39;'), '"a" <272K> &\'');
    t.assert.strictEqual(decodeHtmlEntities('&amp;lt;'), '&lt;');
  });

  it('decodes primitives, arrays, nested objects and holes', (t: TestContext) => {
    t.assert.strictEqual(decodeAstroValue([0, 'gpt-5']), 'gpt-5');
    t.assert.strictEqual(decodeAstroValue([0, null]), null);
    t.assert.strictEqual(decodeAstroValue([0]), undefined);
    t.assert.deepStrictEqual(
      decodeAstroValue([
        1,
        [
          [0, 1],
          [0, '-'],
        ],
      ]),
      [1, '-'],
    );
    t.assert.deepStrictEqual(decodeAstroValue([0, { model: [0, 'o3'], rows: [1, [[1, [[0, 2]]]]] }]), {
      model: 'o3',
      rows: [[2]],
    });
  });

  it('rejects unknown serialisation types instead of guessing', (t: TestContext) => {
    t.assert.throws(() => decodeAstroValue([4, []]), /Unsupported Astro prop type 4/);
    t.assert.throws(() => decodeAstroValue('gpt-5'), /Astro \[type, value\] pair/);
  });

  it('reads islands out of the real page markup and skips uninteresting ones', (t: TestContext) => {
    const islands = extractIslands(FIXTURE);
    const components = islands.map((entry) => entry.component);
    t.assert.ok(components.includes('TextTokenPricingTables'));
    t.assert.ok(components.includes('GroupedPricingTable'));
    t.assert.ok(components.includes('PricingTable'));
    const standard = islands.find((entry) => entry.props.tier === 'standard');
    t.assert.ok(Array.isArray(standard?.props.rows));
    t.assert.ok(islands.every((entry) => entry.component !== 'default'));
  });
});

// --- cells and headings ----------------------------------------------------

describe('cell parsing', () => {
  it('unwraps the page cell wrappers', (t: TestContext) => {
    t.assert.strictEqual(cellText('gpt-5'), 'gpt-5');
    t.assert.strictEqual(
      cellText({ __pricingHtml: 'gpt-3.5-turbo<br /><small>Legacy</small>' }),
      'gpt-3.5-turbo Legacy',
    );
    t.assert.strictEqual(
      cellText({ __pricingTooltipHeading: { label: 'Cache writes', tooltip: 'x' } }),
      'Cache writes',
    );
    t.assert.strictEqual(cellText(undefined), '');
  });

  it('treats "-" as missing and "Free" as zero', (t: TestContext) => {
    t.assert.strictEqual(parseAmount(1.75), 1.75);
    t.assert.strictEqual(parseAmount('$12.50'), 12.5);
    t.assert.strictEqual(parseAmount('Free'), 0);
    t.assert.strictEqual(parseAmount('-'), null);
    t.assert.strictEqual(parseAmount(null), null);
    t.assert.strictEqual(parseAmount('n/a'), null);
  });

  it('splits the context window out of the model name', (t: TestContext) => {
    t.assert.deepStrictEqual(normalizeModelName('gpt-5.4-mini'), { model: 'gpt-5.4-mini', context: null });
    t.assert.deepStrictEqual(normalizeModelName('gpt-5.4-pro (<272K context length)'), {
      model: 'gpt-5.4-pro',
      context: 'short',
    });
    t.assert.deepStrictEqual(normalizeModelName('gpt-5.4-pro (>272K context length)'), {
      model: 'gpt-5.4-pro',
      context: 'long',
    });
    // parentheses that are not about the context window stay part of the name
    t.assert.deepStrictEqual(normalizeModelName('gpt-4o (2024-05-13)'), {
      model: 'gpt-4o (2024-05-13)',
      context: null,
    });
  });

  it('keeps only the requested half of a short/long context header', (t: TestContext) => {
    const headings = [
      'Model',
      'Short context input',
      'Short context cached input',
      'Short context cache writes',
      'Short context output',
      'Long context input',
      'Long context cached input',
      'Long context cache writes',
      'Long context output',
    ];
    t.assert.deepStrictEqual(planColumns(headings, 'short'), { width: 9, model: 0, input: 1, cached: 2, output: 4 });
    t.assert.deepStrictEqual(planColumns(headings, 'long'), { width: 9, model: 0, input: 5, cached: 6, output: 8 });
  });

  it('refuses tables without both an input and an output column', (t: TestContext) => {
    t.assert.strictEqual(planColumns(['Model', 'Size', 'Portrait', 'Price per second'], 'short'), null);
    t.assert.strictEqual(planColumns(['Model', 'Use case', 'Input', 'Estimated cost'], 'short'), null);
  });
});

// --- extraction from the real page -----------------------------------------

describe('extractPrices (real page snapshot)', () => {
  it('reads the standard tier text token table', (t: TestContext) => {
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.4-mini'), { input: 0.75, cached: 0.075, output: 4.5 });
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5-nano'), { input: 0.05, cached: 0.005, output: 0.4 });
  });

  it('aligns rows that omit the optional cache-writes column', (t: TestContext) => {
    // ['gpt-5.2', 1.75, 0.175, 14] against a five column header
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.2'), { input: 1.75, cached: 0.175, output: 14 });
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'o4-mini'), { input: 1.1, cached: 0.275, output: 4.4 });
  });

  it('drops the context suffix and stores the bare model id', (t: TestContext) => {
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.4'), { input: 2.5, cached: 0.25, output: 15 });
    // cached input is "-" for the pro models and normalises to 0
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.4-pro'), { input: 30, cached: 0, output: 180 });
    t.assert.strictEqual(priceOf(FIXTURE, 'gpt-5.4-pro (<272K context length)'), undefined);
  });

  it('selects the tier asked for', (t: TestContext) => {
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.4-mini', { tier: 'flex' }), {
      input: 0.375,
      cached: 0.0375,
      output: 2.25,
    });
    t.assert.strictEqual(
      priceOf(FIXTURE, 'gpt-5.4-mini', { tier: 'flex' })?.input !== priceOf(FIXTURE, 'gpt-5.4-mini')?.input,
      true,
    );
  });

  it('takes short context columns by default and long ones on request', (t: TestContext) => {
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.6-cyber'), { input: 12.5, cached: 1.25, output: 75 });
    t.assert.strictEqual(priceOf(FIXTURE, 'gpt-5.6-cyber', { context: 'long' }), undefined);
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.6-sol', { context: 'long' }), {
      input: 10,
      cached: 1,
      output: 45,
    });
  });

  it('reads the category grouped table', (t: TestContext) => {
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.3-codex'), { input: 1.75, cached: 0.175, output: 14 });
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.3-chat-latest'), { input: 1.75, cached: 0.175, output: 14 });
  });

  it('tells apart the switcher panels of a table that has no tier in its props', (t: TestContext) => {
    // the same grouped table is rendered once per tier; only the panel wrapper differs
    t.assert.deepStrictEqual(priceOf(FIXTURE, 'gpt-5.3-codex', { tier: 'fast' }), {
      input: 3.5,
      cached: 0.35,
      output: 28,
    });
    t.assert.deepStrictEqual(extractPrices(FIXTURE, { tier: 'fast' }).warnings, []);
    // the cyber table sits outside any switcher, so it belongs to the standard tier only
    t.assert.strictEqual(extractPrices(FIXTURE, { tier: 'fast' }).prices.has('gpt-5.6-cyber'), false);
    t.assert.strictEqual(extractPrices(FIXTURE, { tier: 'flex' }).prices.has('gpt-5.6-cyber'), false);
    t.assert.deepStrictEqual(extractPrices(FIXTURE, { tier: 'flex' }).warnings, []);
  });

  it('records which switcher panel each island came from', (t: TestContext) => {
    const grouped = extractIslands(FIXTURE).filter((entry) => entry.component === 'GroupedPricingTable');
    t.assert.deepStrictEqual(
      grouped.map((entry) => entry.tier),
      [null, 'standard', 'standard', 'fast'],
      'the cyber table has no panel of its own',
    );
  });

  it('ignores groups the page hides and tables that do not price text tokens', (t: TestContext) => {
    const { prices } = extractPrices(FIXTURE);
    for (const model of ['gpt-5.5-cyber', 'text-embedding-3-small', 'omni-moderation-latest']) {
      t.assert.strictEqual(prices.has(model), false, `${model} should be hidden`);
    }
    for (const model of ['gpt-image-1.5', 'gpt-image-2', 'gpt-4.1-2025-04-14']) {
      t.assert.strictEqual(prices.has(model), false, `${model} belongs to another table`);
    }
  });

  it('parses the snapshot without warnings', (t: TestContext) => {
    t.assert.deepStrictEqual(extractPrices(FIXTURE).warnings, []);
  });

  it('cross-checks the two tables that price the same models', (t: TestContext) => {
    // gpt-5.6-sol appears in both the text token table and the short/long context
    // table; agreement is what validates the hard-coded text-token column order.
    const sol = priceOf(FIXTURE, 'gpt-5.6-sol');
    t.assert.deepStrictEqual(sol, { input: 5, cached: 0.5, output: 30 });
  });
});

// --- extraction edge cases -------------------------------------------------

describe('extractPrices (synthetic pages)', () => {
  it('warns when two tables disagree about a model', (t: TestContext) => {
    const html =
      textTokenIsland('standard', [['gpt-9', 1, 0.1, '-', 8]]) +
      island('GroupedPricingTable', {
        headings: ['Category', 'Model', 'Input', 'Cached input', 'Output'],
        groups: [{ model: 'Chat', rows: [['gpt-9', 2, 0.1, 8]] }],
      });
    const { prices, warnings } = extractPrices(html);
    t.assert.deepStrictEqual(prices.get('gpt-9')?.input, 1, 'first table wins');
    t.assert.strictEqual(warnings.length, 1);
    t.assert.match(warnings[0], /Conflicting prices for gpt-9/);
  });

  it('skips rows without a usable input or output price', (t: TestContext) => {
    const html = textTokenIsland('standard', [
      ['dead-model', '-', '-', '-', '-'],
      ['embedding-ish', 0.02, '-', '-', '-'],
      ['alive', 1, '-', '-', 4],
    ]);
    const { prices } = extractPrices(html);
    t.assert.deepStrictEqual([...prices.keys()], ['alive']);
    t.assert.strictEqual(prices.get('alive')?.cached, 0);
  });

  it('skips rows that are longer than the header instead of shifting them', (t: TestContext) => {
    const html = textTokenIsland('standard', [['too-wide', 1, 2, 3, 4, 5]]);
    t.assert.strictEqual(extractPrices(html).prices.has('too-wide'), false);
  });

  it('drops long-context rows when short context is requested', (t: TestContext) => {
    const html = textTokenIsland('standard', [
      ['gpt-x (<272K context length)', 1, 0.1, '-', 8],
      ['gpt-x (>272K context length)', 2, 0.2, '-', 16],
    ]);
    t.assert.deepStrictEqual(priceOf(html, 'gpt-x'), { input: 1, cached: 0.1, output: 8 });
    t.assert.deepStrictEqual(priceOf(html, 'gpt-x', { context: 'long' }), { input: 2, cached: 0.2, output: 16 });
  });

  it('warns instead of throwing when the page has no islands', (t: TestContext) => {
    const { prices, warnings } = extractPrices('<html><body>nothing here</body></html>');
    t.assert.strictEqual(prices.size, 0);
    t.assert.strictEqual(warnings.length, 2);
  });
});

// --- family ordering -------------------------------------------------------

/** The families the constant actually carries, in the order the file lists them. */
const FAMILY_TARGET = [
  'const MODEL_PRICING: Record<string, { input: number; cached: number; output: number }> = {',
  "  'gpt-5.6-sol': { input: 5.0, cached: 0.5, output: 30.0 },",
  "  'gpt-5.6-terra': { input: 2.0, cached: 0.2, output: 12.0 },",
  "  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },",
  "  'gpt-5.5': { input: 5.0, cached: 0.5, output: 30.0 },",
  "  'gpt-5.5-pro': { input: 30.0, cached: 0, output: 180.0 },",
  "  'gpt-5.4-pro': { input: 30.0, cached: 0, output: 180.0 },",
  "  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15.0 },",
  "  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },",
  "  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },",
  "  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14.0 },",
  "  'gpt-5.2-pro': { input: 21.0, cached: 0, output: 168.0 },",
  "  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10.0 },",
  "  'gpt-5': { input: 1.25, cached: 0.125, output: 10.0 },",
  "  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },",
  "  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },",
  "  'gpt-5-pro': { input: 15.0, cached: 0, output: 120.0 },",
  "  'gpt-4o': { input: 2.5, cached: 1.25, output: 10.0 },",
  "  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },",
  '  o1: { input: 15.0, cached: 7.5, output: 60.0 },',
  "  'o1-pro': { input: 150.0, cached: 0, output: 600.0 },",
  "  'o3-pro': { input: 20.0, cached: 0, output: 80.0 },",
  '  o3: { input: 2.0, cached: 0.5, output: 8.0 },',
  "  'o3-mini': { input: 1.1, cached: 0.55, output: 4.4 },",
  "  'gpt-5.6-cyber': { input: 12.5, cached: 1.25, output: 75.0 },",
  '};',
].join('\n');

const reorder = (target: string): string[] => {
  const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices);
  return [...findPricingBlock(source).entries.keys()];
};

describe('ordering within a model family', () => {
  it('groups an id by its version, not by its variant suffix', (t: TestContext) => {
    t.assert.strictEqual(modelFamily('gpt-5'), 'gpt-5');
    t.assert.strictEqual(modelFamily('gpt-5-pro'), 'gpt-5');
    t.assert.strictEqual(modelFamily('gpt-5-nano'), 'gpt-5');
    t.assert.strictEqual(modelFamily('gpt-5.2-chat-latest'), 'gpt-5.2');
    t.assert.strictEqual(modelFamily('gpt-5.6-luna'), 'gpt-5.6');
    t.assert.strictEqual(modelFamily('o1-pro'), 'o1');
    t.assert.strictEqual(modelFamily('o4-mini'), 'o4');
    // gpt-4o is its own family, distinct from gpt-4 and gpt-4.1
    t.assert.strictEqual(modelFamily('gpt-4o-mini'), 'gpt-4o');
    t.assert.strictEqual(modelFamily('gpt-4.1-nano'), 'gpt-4.1');
    t.assert.strictEqual(modelFamily('gpt-4-turbo-2024-04-09'), 'gpt-4');
    // nothing version-shaped to key on
    t.assert.strictEqual(modelFamily('chat-latest'), 'chat-latest');
  });

  it('lifts every pro variant above the rest of its family', (t: TestContext) => {
    const keys = reorder(FAMILY_TARGET);
    const above = (high: string, low: string) =>
      t.assert.ok(keys.indexOf(high) < keys.indexOf(low), `${high} must sit above ${low}`);

    above('gpt-5-pro', 'gpt-5');
    above('gpt-5-pro', 'gpt-5-mini');
    above('gpt-5-pro', 'gpt-5-nano');
    above('gpt-5.2-pro', 'gpt-5.2');
    above('gpt-5.5-pro', 'gpt-5.5');
    above('o1-pro', 'o1');
  });

  it('orders each family by price and leaves the families where they are', (t: TestContext) => {
    t.assert.deepStrictEqual(reorder(FAMILY_TARGET), [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5-pro',
      'gpt-5.5',
      'gpt-5.4-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2-pro',
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5-pro',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4o',
      'gpt-4o-mini',
      'o1-pro',
      'o1',
      'o3-pro',
      'o3',
      'o3-mini',
      // a second, detached run of the gpt-5.6 family: it is not hoisted to the top
      'gpt-5.6-cyber',
    ]);
  });

  it('is idempotent and reports no change once a family is in order', (t: TestContext) => {
    const once = applyPricingUpdate(FAMILY_TARGET, extractPrices(FIXTURE).prices).source;
    const twice = applyPricingUpdate(once, extractPrices(FIXTURE).prices);
    t.assert.strictEqual(twice.source, once);
    t.assert.strictEqual(twice.plan.changed, false);
  });

  it('files a newly added variant by price too', (t: TestContext) => {
    const target = FAMILY_TARGET.replace("  'gpt-5.5-pro': { input: 30.0, cached: 0, output: 180.0 },\n", '');
    const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices, { add: ['gpt-5.5-pro'] });
    const keys = [...findPricingBlock(source).entries.keys()];
    t.assert.ok(keys.indexOf('gpt-5.5-pro') < keys.indexOf('gpt-5.5'));
  });

  it('adds a variant priced in a table of its own to its family, not to the page rank', (t: TestContext) => {
    // gpt-5.6-cyber is ~30 rows below gpt-5.6-sol on the page: by rank alone it
    // would land under the o3 entries as a stranded run of one.
    const target = FAMILY_TARGET.replace("  'gpt-5.6-cyber': { input: 12.5, cached: 1.25, output: 75.0 },\n", '');
    const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices, { add: ['gpt-5.6-cyber'] });
    const keys = [...findPricingBlock(source).entries.keys()];

    // dearest of the family, so it leads it
    t.assert.strictEqual(keys[0], 'gpt-5.6-cyber');
    t.assert.deepStrictEqual(keys.slice(0, 4), ['gpt-5.6-cyber', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  });

  it('still files a new family by page rank', (t: TestContext) => {
    const target = FAMILY_TARGET.replace(/ {2}'gpt-5\.6-(sol|terra|luna|cyber)':[^\n]*\n/g, '');
    const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices, { add: ['gpt-5.6-sol'] });
    const keys = [...findPricingBlock(source).entries.keys()];
    // no gpt-5.6 run to join, and the page ranks it first
    t.assert.strictEqual(keys[0], 'gpt-5.6-sol');
  });

  it('leaves a detached entry that is already in the file where it sits', (t: TestContext) => {
    // the no-hoist rule still holds for entries the run did not add
    t.assert.strictEqual(reorder(FAMILY_TARGET).at(-1), 'gpt-5.6-cyber');
  });
});

// --- rewriting the constant ------------------------------------------------

describe('source rewriting', () => {
  it('formats numbers the way the file already does', (t: TestContext) => {
    t.assert.strictEqual(formatPrice(0), '0');
    t.assert.strictEqual(formatPrice(30), '30.0');
    t.assert.strictEqual(formatPrice(0.075), '0.075');
    t.assert.strictEqual(formatPrice(4.5), '4.5');
  });

  it('quotes only the keys that need quoting', (t: TestContext) => {
    const rendered = renderEntries(
      new Map([
        ['o1', { input: 15, cached: 7.5, output: 60 }],
        ['gpt-5', { input: 1.25, cached: 0.125, output: 10 }],
      ]),
      '',
    );
    t.assert.strictEqual(
      rendered,
      [
        '  o1: { input: 15.0, cached: 7.5, output: 60.0 },',
        "  'gpt-5': { input: 1.25, cached: 0.125, output: 10.0 },",
      ].join('\n'),
    );
  });

  it('finds the constant and reads the entries already in it', (t: TestContext) => {
    const block = findPricingBlock(TARGET);
    t.assert.deepStrictEqual([...block.entries.keys()], ['gpt-5.4-mini', 'gpt-5-mini', 'o1', 'o1-mini']);
    t.assert.deepStrictEqual(block.entries.get('o1'), { input: 15, cached: 7.5, output: 60 });
    t.assert.strictEqual(block.indent, '');
  });

  it('reports a missing constant instead of writing garbage', (t: TestContext) => {
    t.assert.throws(() => findPricingBlock('const OTHER = {};'), /Could not find/);
    t.assert.throws(() => findPricingBlock(TARGET, 'NOPE'), /Could not find/);
  });

  it('updates known models and leaves everything else alone by default', (t: TestContext) => {
    const { source, plan } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices);
    t.assert.deepStrictEqual(
      plan.updated.map((entry) => entry.model),
      ['gpt-5.4-mini'],
    );
    t.assert.deepStrictEqual(plan.added, []);
    t.assert.deepStrictEqual(plan.removed, []);
    t.assert.deepStrictEqual(plan.missingOnPage, ['o1-mini']);
    t.assert.ok(plan.newOnPage.includes('gpt-5.6-sol'));
    t.assert.match(source, /'gpt-5\.4-mini': \{ input: 0\.75, cached: 0\.075, output: 4\.5 \},/);
    t.assert.match(source, /'o1-mini': \{ input: 1\.1, cached: 0\.55, output: 4\.4 \},/);
    t.assert.match(source, /\n {2}o1: \{ input: 15\.0, cached: 7\.5, output: 60\.0 \},/);
    t.assert.match(source, /^import OpenAI from 'openai';/);
    t.assert.match(source, /export class OpenAIService \{\}$/);
    t.assert.match(source, /\/\/ Source: https:\/\/developers\.openai\.com\/api\/docs\/pricing\n/);
  });

  it('weaves every page model in by rank, only with --add-new', (t: TestContext) => {
    const { source, plan } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, { addNew: true });
    t.assert.ok(plan.added.some((entry) => entry.model === 'gpt-5.6-sol'));
    const keys = [...findPricingBlock(source).entries.keys()];
    t.assert.deepStrictEqual(
      keys.slice(0, 4),
      // cyber is priced in a table of its own near the foot of the page, but it
      // is a gpt-5.6 model and the dearest of them, so it leads the family
      ['gpt-5.6-cyber', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      'newest at the top',
    );
    t.assert.deepStrictEqual(
      keys.filter((key) => ['gpt-5.4-mini', 'gpt-5-mini', 'o1', 'o1-mini'].includes(key)),
      ['gpt-5.4-mini', 'gpt-5-mini', 'o1', 'o1-mini'],
      'entries already in the file keep their relative order',
    );
    t.assert.ok(keys.indexOf('gpt-5.6-sol') < keys.indexOf('gpt-5.4-mini'));
    // The retired model is still never an anchor — nothing is placed by its rank,
    // because it has none. It does end up beside o1 rather than stranded at the
    // foot of the file: adding o1-pro extends the o1 run over it, and that run is
    // then sorted dearest first. Its order relative to o1 is what is asserted above.
    t.assert.deepStrictEqual(
      keys.slice(keys.indexOf('o1-pro'), keys.indexOf('o1-pro') + 3),
      ['o1-pro', 'o1', 'o1-mini'],
      'the retired model stays with the family it belongs to',
    );
  });

  it('removes models the page dropped only with --prune', (t: TestContext) => {
    const { source, plan } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, { prune: true });
    t.assert.deepStrictEqual(
      plan.removed.map((entry) => entry.model),
      ['o1-mini'],
    );
    const kept = findPricingBlock(source).entries;
    t.assert.strictEqual(kept.has('o1-mini'), false);
    t.assert.strictEqual(kept.has('o1'), true, 'models still on the page survive --prune');
  });

  it('adds exactly the models asked for, newest at the top', (t: TestContext) => {
    const { source, plan } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, {
      add: ['gpt-5.6-luna', 'gpt-5.6-sol'],
    });
    t.assert.deepStrictEqual(
      plan.added.map((entry) => entry.model),
      ['gpt-5.6-sol', 'gpt-5.6-luna'],
      'page order, not the order they were requested in',
    );
    t.assert.deepStrictEqual(
      [...findPricingBlock(source).entries.keys()],
      ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5-mini', 'o1', 'o1-mini'],
      'the page ranks both above everything already listed',
    );
  });

  it('slots an older addition beside its own generation, not at the top', (t: TestContext) => {
    // the page ranks gpt-4o-mini right after gpt-4o, and both below every gpt-5
    const target = TARGET.replace(
      "  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },",
      [
        "  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },",
        "  'gpt-4o': { input: 2.5, cached: 1.25, output: 10.0 },",
      ].join('\n'),
    );
    const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices, {
      add: ['gpt-4o-mini', 'gpt-5.6-sol'],
    });
    t.assert.deepStrictEqual(
      [...findPricingBlock(source).entries.keys()],
      ['gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
    );
  });

  it('goes to the top when the file offers no ranked anchor at all', (t: TestContext) => {
    const target = TARGET.replace("  'gpt-5.4-mini': { input: 0.1, cached: 0.2, output: 0.3 },\n", '')
      .replace("  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },\n", '')
      .replace('  o1: { input: 15.0, cached: 7.5, output: 60.0 },\n', '');
    // only the retired o1-mini is left, and the page gives it no rank to anchor to
    const { source } = applyPricingUpdate(target, extractPrices(FIXTURE).prices, { add: ['gpt-4o-mini'] });
    t.assert.deepStrictEqual([...findPricingBlock(source).entries.keys()], ['gpt-4o-mini', 'o1-mini']);
  });

  it('drops exactly the models asked for, even ones still on the page', (t: TestContext) => {
    const { source, plan } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, {
      remove: ['o1-mini', 'o1'],
    });
    t.assert.deepStrictEqual(
      plan.removed.map((entry) => entry.model),
      ['o1', 'o1-mini'],
    );
    const kept = findPricingBlock(source).entries;
    t.assert.deepStrictEqual([...kept.keys()], ['gpt-5.4-mini', 'gpt-5-mini']);
  });

  it('refuses to add a model the page does not price', (t: TestContext) => {
    t.assert.throws(
      () => applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, { add: ['gpt-9000'] }),
      /Cannot add gpt-9000: the page does not price it\./,
    );
    t.assert.throws(
      () => applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, { add: ['a', 'b'] }),
      /Cannot add a, b: the page does not price them\./,
    );
  });

  it('leaves a removed model out even when --add-new would re-add it', (t: TestContext) => {
    const { source } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, {
      addNew: true,
      remove: ['gpt-5.6-sol'],
    });
    t.assert.strictEqual(findPricingBlock(source).entries.has('gpt-5.6-sol'), false);
  });

  it('is idempotent — a second run changes nothing', (t: TestContext) => {
    const prices = extractPrices(FIXTURE).prices;
    const first = applyPricingUpdate(TARGET, prices, { addNew: true });
    const second = applyPricingUpdate(first.source, prices, { addNew: true });
    t.assert.strictEqual(second.source, first.source);
    t.assert.strictEqual(second.plan.changed, false);
    t.assert.deepStrictEqual(second.plan.updated, []);
  });

  it('round-trips every extracted price through the rendered source', (t: TestContext) => {
    const prices = extractPrices(FIXTURE).prices;
    const { source } = applyPricingUpdate(TARGET, prices, { addNew: true });
    const written = findPricingBlock(source).entries;
    for (const [model, price] of prices) {
      t.assert.deepStrictEqual(
        written.get(model),
        { input: price.input, cached: price.cached, output: price.output },
        `${model} survived the round trip`,
      );
    }
  });

  it('reports no change when the file already matches the page', (t: TestContext) => {
    const prices = new Map<string, ModelPrice>([
      ['gpt-5.4-mini', { input: 0.1, cached: 0.2, output: 0.3 }],
      ['gpt-5-mini', { input: 0.25, cached: 0.025, output: 2 }],
      ['o1', { input: 15, cached: 7.5, output: 60 }],
      ['o1-mini', { input: 1.1, cached: 0.55, output: 4.4 }],
    ]);
    const { source, plan } = applyPricingUpdate(TARGET, prices);
    t.assert.strictEqual(plan.changed, false);
    t.assert.strictEqual(source, TARGET);
    t.assert.deepStrictEqual(plan.unchanged, ['gpt-5.4-mini', 'gpt-5-mini', 'o1', 'o1-mini']);
    t.assert.deepStrictEqual(plan.updated, []);
  });

  it('never reorders the file just because the page lists models differently', (t: TestContext) => {
    const prices = new Map<string, ModelPrice>([
      ['gpt-5-mini', { input: 0.25, cached: 0.025, output: 2 }],
      ['gpt-5.4-mini', { input: 0.1, cached: 0.2, output: 0.3 }],
    ]);
    const { source, plan } = applyPricingUpdate(TARGET, prices);
    t.assert.strictEqual(plan.changed, false, 'same prices in a different order is not a change');
    t.assert.strictEqual(source, TARGET);
  });

  it('keeps the surrounding file byte-identical', (t: TestContext) => {
    const { source } = applyPricingUpdate(TARGET, extractPrices(FIXTURE).prices, { addNew: true, prune: true });
    const [beforeTarget] = TARGET.split('const MODEL_PRICING');
    const [beforeSource] = source.split('const MODEL_PRICING');
    t.assert.strictEqual(beforeSource, beforeTarget);
    t.assert.strictEqual(source.slice(source.indexOf('};') + 2), TARGET.slice(TARGET.indexOf('};') + 2));
  });

  it('works with an indented constant', (t: TestContext) => {
    const nested = [
      'export function f() {',
      '  const MODEL_PRICING = {',
      '    o1: { input: 1.0, cached: 0, output: 2.0 },',
      '  };',
      '}',
    ].join('\n');
    const { source } = applyPricingUpdate(nested, new Map([['o1', { input: 3, cached: 0, output: 4 }]]));
    t.assert.strictEqual(
      source,
      nested.replace('input: 1.0, cached: 0, output: 2.0', 'input: 3.0, cached: 0, output: 4.0'),
    );
  });
});
