// node --test .claude/skills/update-openai-pricing/scripts/model-config.test.ts
//
// (add --experimental-test-coverage for a coverage table; requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import {
  CONFIG_LOCATIONS,
  EFFORT_FOR,
  EFFORT_RUNGS,
  MODEL_VARIABLES,
  cheaperAlternatives,
  equivalentEffort,
  currentModels,
  readModel,
  replaceModel,
  type ConfigLocation,
  type ConfigVariable,
} from './model-config.ts';
import type { ModelPrice } from './pricing.ts';

const at = (path: string): ConfigLocation => {
  const location = CONFIG_LOCATIONS.find((candidate) => candidate.path === path);
  if (!location) throw new Error(`no declared location for ${path}`);
  return location;
};

const ENV = ['TG_TOKEN=secret', 'OPENAI_MODEL=gpt-5-mini', 'OPENAI_VISION_MODEL=gpt-5-mini', ''].join('\n');

const CONFIG = [
  'export class ConfigService {',
  '  private config = {',
  "    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',",
  "    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-5-mini',",
  "    OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL || 'gpt-5-mini',",
  '  };',
  '}',
].join('\n');

const DOCS = [
  '- `OPENAI_BASE_URL`: Optional custom OpenAI API base URL',
  '- `OPENAI_MODEL`: Model to use (default: gpt-5-mini)',
  '- `MATCH_IMAGE_COUNT`: Number of results to return per page (default 3)',
].join('\n');

const price = (input: number, cached: number, output: number): ModelPrice => ({ input, cached, output });

const PRICES = new Map<string, ModelPrice>([
  ['gpt-5.6-luna', price(0.2, 0.02, 1.2)],
  ['gpt-5-mini', price(0.25, 0.025, 2.0)],
  ['gpt-5-nano', price(0.05, 0.005, 0.4)],
  // cheaper input and output, but dearer cached input — not a safe swap
  ['gpt-4o-mini', price(0.15, 0.075, 0.6)],
  ['gpt-5.4', price(2.5, 0.25, 15.0)],
]);

describe('reading the configured model', () => {
  it('finds it in every declared kind of location', (t: TestContext) => {
    t.assert.strictEqual(readModel(ENV, at('.env'), 'OPENAI_MODEL'), 'gpt-5-mini');
    t.assert.strictEqual(readModel(CONFIG, at('src/config/config.service.ts'), 'OPENAI_MODEL'), 'gpt-5-mini');
    t.assert.strictEqual(readModel(DOCS, at('CLAUDE.md'), 'OPENAI_MODEL'), 'gpt-5-mini');
  });

  it('keeps the two model variables apart', (t: TestContext) => {
    const env = ENV.replace('OPENAI_VISION_MODEL=gpt-5-mini', 'OPENAI_VISION_MODEL=gpt-4o-mini');
    t.assert.strictEqual(readModel(env, at('.env'), 'OPENAI_MODEL'), 'gpt-5-mini');
    t.assert.strictEqual(readModel(env, at('.env'), 'OPENAI_VISION_MODEL'), 'gpt-4o-mini');

    const config = CONFIG.replace("OPENAI_VISION_MODEL || 'gpt-5-mini'", "OPENAI_VISION_MODEL || 'gpt-4o-mini'");
    t.assert.strictEqual(readModel(config, at('src/config/config.service.ts'), 'OPENAI_VISION_MODEL'), 'gpt-4o-mini');
  });

  it('reports nothing when the variable is absent or empty', (t: TestContext) => {
    t.assert.strictEqual(readModel('TG_TOKEN=x\n', at('.env'), 'OPENAI_MODEL'), null);
    t.assert.strictEqual(readModel('OPENAI_MODEL=\n', at('.env'), 'OPENAI_MODEL'), null);
  });

  it('collapses agreeing places and surfaces disagreement', (t: TestContext) => {
    const reading = (path: string, model: string | null) => ({ location: at(path), model });
    t.assert.deepStrictEqual(currentModels([reading('.env', 'gpt-5-mini'), reading('CLAUDE.md', 'gpt-5-mini')]), [
      'gpt-5-mini',
    ]);
    t.assert.deepStrictEqual(currentModels([reading('.env', 'gpt-5.6-luna'), reading('CLAUDE.md', 'gpt-5-mini')]), [
      'gpt-5.6-luna',
      'gpt-5-mini',
    ]);
    t.assert.deepStrictEqual(currentModels([reading('.env', null)]), []);
  });
});

describe('rewriting the configured model', () => {
  it('replaces only the id and leaves the rest of the line alone', (t: TestContext) => {
    const env = replaceModel(ENV, at('.env'), 'OPENAI_MODEL', 'gpt-5.6-luna');
    t.assert.strictEqual(env.replaced, true);
    t.assert.match(env.text, /^OPENAI_MODEL=gpt-5\.6-luna$/m);
    t.assert.match(env.text, /^TG_TOKEN=secret$/m, 'other variables untouched');
    t.assert.match(env.text, /^OPENAI_VISION_MODEL=gpt-5-mini$/m, 'the vision model is a separate decision');
  });

  it('keeps surrounding syntax intact in code and docs', (t: TestContext) => {
    const config = replaceModel(CONFIG, at('src/config/config.service.ts'), 'OPENAI_MODEL', 'gpt-5.6-luna');
    t.assert.match(config.text, /OPENAI_MODEL: process\.env\.OPENAI_MODEL \|\| 'gpt-5\.6-luna',/);
    t.assert.match(config.text, /OPENAI_VISION_MODEL: process\.env\.OPENAI_VISION_MODEL \|\| 'gpt-5-mini',/);

    const docs = replaceModel(DOCS, at('CLAUDE.md'), 'OPENAI_MODEL', 'gpt-5.6-luna');
    t.assert.match(docs.text, /- `OPENAI_MODEL`: Model to use \(default: gpt-5\.6-luna\)/);
    t.assert.match(docs.text, /\(default 3\)/, 'unrelated defaults untouched');
  });

  it('reports when there was nothing to replace', (t: TestContext) => {
    const absent = replaceModel('TG_TOKEN=x\n', at('.env'), 'OPENAI_MODEL', 'gpt-5.6-luna');
    t.assert.strictEqual(absent.replaced, false);
    t.assert.strictEqual(absent.text, 'TG_TOKEN=x\n');

    const same = replaceModel(ENV, at('.env'), 'OPENAI_MODEL', 'gpt-5-mini');
    t.assert.strictEqual(same.replaced, false, 'rewriting to the same id is not a change');
  });

  it('is idempotent', (t: TestContext) => {
    const once = replaceModel(ENV, at('.env'), 'OPENAI_MODEL', 'gpt-5.6-luna').text;
    const twice = replaceModel(once, at('.env'), 'OPENAI_MODEL', 'gpt-5.6-luna').text;
    t.assert.strictEqual(twice, once);
  });
});

describe('carrying the reasoning effort onto another model', () => {
  const GPT5 = ['minimal', 'low', 'medium', 'high'];
  const GPT56 = ['none', 'low', 'medium', 'high', 'xhigh'];

  it('keeps the value when the target already accepts it', (t: TestContext) => {
    t.assert.strictEqual(equivalentEffort('low', GPT56), 'low');
    t.assert.strictEqual(equivalentEffort('minimal', GPT5), 'minimal');
  });

  it('translates the cheapest rung between its two names', (t: TestContext) => {
    // the setting is unchanged in intent; only the spelling differs by generation
    t.assert.strictEqual(equivalentEffort('minimal', GPT56), 'none');
    t.assert.strictEqual(equivalentEffort('none', GPT5), 'minimal');
  });

  it('steps up rather than down when the rung has no name on the target', (t: TestContext) => {
    // too little reasoning is the failure that matters, so never quietly reduce it
    t.assert.strictEqual(equivalentEffort('minimal', ['low', 'medium', 'high']), 'low');
    t.assert.strictEqual(equivalentEffort('low', ['medium', 'high']), 'medium');
    t.assert.strictEqual(equivalentEffort('xhigh', GPT5), null, 'nothing above it to step to');
  });

  it('refuses to guess for a value it does not know', (t: TestContext) => {
    t.assert.strictEqual(equivalentEffort('turbo', GPT56), null);
  });

  it('reads and rewrites the effort in every declared location', (t: TestContext) => {
    const env = 'OPENAI_MODEL=gpt-5-mini\nOPENAI_REASONING_EFFORT=low\nOPENAI_VISION_REASONING_EFFORT=minimal\n';
    t.assert.strictEqual(readModel(env, at('.env'), 'OPENAI_REASONING_EFFORT'), 'low');
    t.assert.strictEqual(readModel(env, at('.env'), 'OPENAI_VISION_REASONING_EFFORT'), 'minimal');
    const swapped = replaceModel(env, at('.env'), 'OPENAI_VISION_REASONING_EFFORT', 'none');
    t.assert.match(swapped.text, /^OPENAI_VISION_REASONING_EFFORT=none$/m);
    t.assert.match(swapped.text, /^OPENAI_REASONING_EFFORT=low$/m, 'the other effort is untouched');

    // ConfigService wraps the effort in a validator instead of a `||` fallback
    const config =
      "    OPENAI_VISION_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_VISION_REASONING_EFFORT, 'minimal'),";
    t.assert.strictEqual(
      readModel(config, at('src/config/config.service.ts'), 'OPENAI_VISION_REASONING_EFFORT'),
      'minimal',
    );
    const rewritten = replaceModel(
      config,
      at('src/config/config.service.ts'),
      'OPENAI_VISION_REASONING_EFFORT',
      'none',
    );
    t.assert.match(rewritten.text, /reasoningEffort\(process\.env\.OPENAI_VISION_REASONING_EFFORT, 'none'\)/);

    const docs = '- `OPENAI_REASONING_EFFORT`: Effort for summarization and aggregation (default: low)';
    t.assert.strictEqual(readModel(docs, at('CLAUDE.md'), 'OPENAI_REASONING_EFFORT'), 'low');
  });

  it('does not confuse the vision variable with the plain one', (t: TestContext) => {
    const env = 'OPENAI_VISION_REASONING_EFFORT=minimal\n';
    t.assert.strictEqual(readModel(env, at('.env'), 'OPENAI_REASONING_EFFORT'), null);
    const config =
      "    OPENAI_VISION_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_VISION_REASONING_EFFORT, 'minimal'),";
    t.assert.strictEqual(readModel(config, at('src/config/config.service.ts'), 'OPENAI_REASONING_EFFORT'), null);
  });

  it('pairs each model variable with the effort that governs it', (t: TestContext) => {
    t.assert.strictEqual(EFFORT_FOR.OPENAI_MODEL, 'OPENAI_REASONING_EFFORT');
    t.assert.strictEqual(EFFORT_FOR.OPENAI_VISION_MODEL, 'OPENAI_VISION_REASONING_EFFORT');
  });
});

describe('the declarations against the real repository', () => {
  // The synthetic fixtures above pin the *behaviour* of each pattern; these pin
  // the patterns to the files they claim to describe. Without this, refactoring
  // ConfigService (a different wrapper, another quote style) would silently drop
  // it out of the switch flow with every synthetic test still green.
  const repoFile = (path: string): string => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
  const VARIABLES: readonly ConfigVariable[] = [...MODEL_VARIABLES, ...MODEL_VARIABLES.map((v) => EFFORT_FOR[v])];

  it('finds every variable in every non-optional location', (t: TestContext) => {
    for (const location of CONFIG_LOCATIONS.filter((candidate) => !candidate.optional)) {
      const text = repoFile(location.path);
      for (const variable of VARIABLES) {
        t.assert.ok(readModel(text, location, variable) !== null, `${variable} not found in ${location.path}`);
      }
    }
  });

  it('agrees with ConfigService about which efforts exist at all', (t: TestContext) => {
    // Two encodings of the same ladder: EFFORT_RUNGS here, REASONING_EFFORTS in
    // the app. If they drift, switch-model can write an effort the app refuses
    // at runtime and silently replaces with the fallback — the quiet degradation
    // the whole step-up design exists to prevent.
    const source = repoFile('src/config/config.service.ts');
    const declared = /const REASONING_EFFORTS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
    t.assert.ok(declared, 'REASONING_EFFORTS not found in config.service.ts');
    const app = [...declared!.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    const skill = EFFORT_RUNGS.flat().toSorted();
    t.assert.deepStrictEqual(skill, app);
  });
});

describe('finding cheaper alternatives', () => {
  it('offers only models that cost no more on every axis', (t: TestContext) => {
    const found = cheaperAlternatives(PRICES, 'gpt-5-mini');
    t.assert.deepStrictEqual(
      found.map((alternative) => alternative.model),
      ['gpt-5.6-luna', 'gpt-5-nano'],
      'gpt-4o-mini is dearer per cached token, so it is not a safe swap',
    );
  });

  it('puts the smallest step away from the current model first', (t: TestContext) => {
    const [first, second] = cheaperAlternatives(PRICES, 'gpt-5-mini');
    t.assert.ok(first.price.output > second.price.output);
    t.assert.strictEqual(first.model, 'gpt-5.6-luna');
    t.assert.strictEqual(Number(first.outputSaving.toFixed(2)), 0.4);
  });

  it('can be restricted to the models just added', (t: TestContext) => {
    const found = cheaperAlternatives(PRICES, 'gpt-5-mini', ['gpt-5.6-luna', 'gpt-5.4']);
    t.assert.deepStrictEqual(
      found.map((alternative) => alternative.model),
      ['gpt-5.6-luna'],
      'gpt-5.4 is in the pool but dearer, and gpt-5-nano is cheaper but not in it',
    );
  });

  it('returns nothing when the current model is already the cheapest or unknown', (t: TestContext) => {
    t.assert.deepStrictEqual(cheaperAlternatives(PRICES, 'gpt-5-nano'), []);
    t.assert.deepStrictEqual(cheaperAlternatives(PRICES, 'gpt-9000'), []);
    t.assert.deepStrictEqual(cheaperAlternatives(PRICES, 'gpt-5-mini', []), []);
  });
});
