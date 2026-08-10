// node --test .claude/skills/update-openai-pricing/scripts/capabilities.test.ts
//
// (add --experimental-test-coverage for a coverage table; requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import { acceptsImages, fetchCapabilityBundle, readCapabilities, supportsStructuredOutputs } from './capabilities.ts';

const BUNDLE = readFileSync(new URL('../fixtures/models-bundle.js', import.meta.url), 'utf8');

describe('reading a model spec out of the docs bundle', () => {
  it('reads a model whose spec sits on the alias itself', (t: TestContext) => {
    const luna = readCapabilities(BUNDLE, 'gpt-5.6-luna');
    t.assert.ok(luna);
    t.assert.strictEqual(luna.displayName, 'GPT-5.6 Luna');
    t.assert.strictEqual(luna.kind, 'reasoning');
    t.assert.strictEqual(luna.performance, 3);
    t.assert.strictEqual(luna.latency, 4);
    t.assert.strictEqual(luna.reasoningTokens, true);
    t.assert.strictEqual(luna.contextWindow, 1_050_000);
    t.assert.strictEqual(luna.maxOutputTokens, 128_000);
    t.assert.deepStrictEqual(luna.inputModalities, ['text', 'image']);
    t.assert.deepStrictEqual(luna.outputModalities, ['text']);
  });

  it('follows the alias to the dated snapshot that carries the spec', (t: TestContext) => {
    // gpt-5-mini's own object has the prose; the modalities live under gpt-5-mini-2025-08-07
    const mini = readCapabilities(BUNDLE, 'gpt-5-mini');
    t.assert.ok(mini);
    t.assert.strictEqual(mini.snapshot, 'gpt-5-mini-2025-08-07');
    t.assert.strictEqual(mini.contextWindow, 400_000);
    t.assert.strictEqual(mini.performance, 3);
    t.assert.deepStrictEqual(mini.inputModalities, ['text', 'image']);
    t.assert.match(mini.tagline ?? '', /cost sensitive/i);
  });

  it('surfaces a deprecated snapshot behind a healthy-looking alias', (t: TestContext) => {
    t.assert.strictEqual(readCapabilities(BUNDLE, 'gpt-5-mini')?.deprecated, true);
    t.assert.strictEqual(readCapabilities(BUNDLE, 'gpt-5.6-luna')?.deprecated, null);
  });

  it('answers the two questions this bot actually depends on', (t: TestContext) => {
    for (const model of ['gpt-5-mini', 'gpt-5.6-luna', 'gpt-4o-mini']) {
      const capabilities = readCapabilities(BUNDLE, model);
      t.assert.ok(capabilities, `${model} is in the bundle`);
      t.assert.strictEqual(acceptsImages(capabilities), true, `${model} takes images`);
      t.assert.strictEqual(supportsStructuredOutputs(capabilities), true, `${model} takes a schema`);
    }
  });

  it('keeps the prose that explains where a model sits in its family', (t: TestContext) => {
    // the only signal that gpt-5.6-luna is a tier below gpt-5-mini despite rating the same
    t.assert.match(readCapabilities(BUNDLE, 'gpt-5.6-luna')?.description ?? '', /nano model tier/);
    t.assert.match(readCapabilities(BUNDLE, 'gpt-5.6-terra')?.description ?? '', /mini model tier/);
  });

  it('reports an unknown model as absent rather than as an empty spec', (t: TestContext) => {
    t.assert.strictEqual(readCapabilities(BUNDLE, 'gpt-9000'), null);
    t.assert.strictEqual(readCapabilities('', 'gpt-5-mini'), null);
  });
});

describe('locating the bundle', () => {
  const page = '<astro-island component-url="/_astro/ModelOverview.react.CYx9v0ji.js"></astro-island>';
  const script = 'import{x}from"./models-page-data.react.uLjwemwK.js";import{y}from"./Button.js";';

  it('walks the models page to the data module', async (t: TestContext) => {
    const asked: string[] = [];
    const fetchText = (url: string): Promise<string> => {
      asked.push(url);
      if (url.endsWith('/models')) return Promise.resolve(page);
      if (url.includes('ModelOverview')) return Promise.resolve(script);
      return Promise.resolve('BUNDLE');
    };
    t.assert.strictEqual(await fetchCapabilityBundle(fetchText, 'https://example.com/api/docs/models'), 'BUNDLE');
    t.assert.deepStrictEqual(asked, [
      'https://example.com/api/docs/models',
      'https://example.com/_astro/ModelOverview.react.CYx9v0ji.js',
      'https://example.com/_astro/models-page-data.react.uLjwemwK.js',
    ]);
  });

  it('fails loudly when either hop disappears', async (t: TestContext) => {
    await t.assert.rejects(
      () => fetchCapabilityBundle(() => Promise.resolve('<html></html>'), 'https://example.com/api/docs/models'),
      /No ModelOverview script/,
    );
    await t.assert.rejects(
      () =>
        fetchCapabilityBundle(
          (url) => Promise.resolve(url.endsWith('/models') ? page : 'import{y}from"./Button.js";'),
          'https://example.com/api/docs/models',
        ),
      /no longer imports models-page-data/,
    );
  });
});
