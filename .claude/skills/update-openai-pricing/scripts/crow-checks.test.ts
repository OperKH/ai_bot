// node --test .claude/skills/update-openai-pricing/scripts/crow-checks.test.ts
//
// (requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import {
  arcMetrics,
  type ArcRun,
  blindFile,
  crowVerdict,
  type CrowFixture,
  decodeVerdicts,
  isSwear,
  itemId,
  type Side,
  tallySide,
} from './crow-checks.ts';

const FIXTURE: CrowFixture = {
  roster: ['openai: GPT-6 Sol'],
  stories: [
    {
      name: 'opus',
      tests: 'a mega release',
      title: 'Anthropic Introduces Claude Opus 5.5',
      category: 'ai-enterprise',
      importance: 3,
      isRumor: false,
      facts: [{ id: 'F1', text: 'Anthropic представила Claude Opus 5.5.' }],
      recentPosts: ['🐦‍⬛ Раніше'],
      previousStances: ['GPT-6: імба'],
    },
  ],
};

const arc = (story: string, run: number, texts: string[], extra: Partial<NonNullable<ArcRun['written']>> = {}): ArcRun => ({
  story,
  run,
  outline: texts.map((_, i) => `${i + 1}. [${i === 0 ? 'breaking' : 'fact'}] …`),
  written: {
    messages: texts.map((text) => ({ kind: 'fact', crows: 1, text, factIds: [] })),
    stance: { subject: 'Claude Opus 5.5', verdict: 'імба' },
    dropped: [],
    failed: false,
    attempts: [{ costUsd: 0.02, problems: [] }],
    ...extra,
  },
  ms: 20_000,
  error: null,
});

describe('what a script can see in an arc', () => {
  it('counts the chat’s swear words and tells euphemisms apart', (t: TestContext) => {
    t.assert.ok(isSwear('бля'));
    t.assert.ok(isSwear('заєбісь'));
    t.assert.ok(isSwear('хуйня'));
    t.assert.ok(!isSwear('бляха'), '«бляха» is a euphemism');
    t.assert.ok(!isSwear('блін'));
    const metrics = arcMetrics([
      { text: '🐦‍⬛🐦‍⬛🐦‍⬛ Коти, бля, Anthropic знову' },
      { text: '🐦‍⬛ Anthropic повідомляє, що блін' },
      { text: '🐦‍⬛ Anthropic повідомляє ще одне' },
    ]);
    t.assert.strictEqual(metrics.swearing, 1);
    t.assert.strictEqual(metrics.euphemisms, 1);
    t.assert.strictEqual(metrics.catOpenings, 1);
    t.assert.strictEqual(metrics.nameOpenings, 2);
    t.assert.strictEqual(metrics.sameStarts, 1, 'the two «Anthropic повідомляє» neighbours');
  });

  it('tallies failed openings, rewrites, drops and cost per model', (t: TestContext) => {
    const tally = tallySide([
      arc('opus', 1, ['a', 'b']),
      arc('opus', 2, ['a'], { failed: true, dropped: [1], attempts: [{ costUsd: 0.02, problems: ['x'] }, { costUsd: 0.03, problems: ['x'] }] }),
      { story: 'opus', run: 3, outline: [], written: null, ms: 1000, error: '400 reasoning_effort' },
    ]);
    t.assert.strictEqual(tally.arcs, 3);
    t.assert.strictEqual(tally.errors, 1);
    t.assert.strictEqual(tally.failed, 1);
    t.assert.strictEqual(tally.rewritten, 1);
    t.assert.strictEqual(tally.dropped, 1);
    t.assert.strictEqual(Number(tally.costUsd.toFixed(2)), 0.07);
  });
});

describe('blind files', () => {
  const runs: Record<Side, ArcRun[]> = {
    baseline: [arc('opus', 1, ['🐦‍⬛ базовий текст'])],
    candidate: [arc('opus', 1, ['🐦‍⬛ текст кандидата'])],
  };

  it('hide which model wrote which arc, and the key says it', (t: TestContext) => {
    const { markdown, key } = blindFile(FIXTURE, runs, 1);
    const labels = key[itemId('opus', 1)];
    t.assert.deepStrictEqual(new Set(Object.values(labels)), new Set(['baseline', 'candidate']));
    t.assert.ok(!/baseline|candidate/.test(markdown), 'no side named in the file');
    const a = markdown.indexOf('### Arc A');
    const b = markdown.indexOf('### Arc B');
    const baselineText = markdown.indexOf('базовий текст');
    t.assert.strictEqual(baselineText > a && baselineText < b, labels.A === 'baseline');
  });

  it('give the judges what they need to check the facts', (t: TestContext) => {
    const { markdown } = blindFile(FIXTURE, runs, 1);
    for (const needed of ['F1: Anthropic представила', 'openai: GPT-6 Sol', 'GPT-6: імба', 'a mega release']) {
      t.assert.ok(markdown.includes(needed), needed);
    }
  });

  it('shuffle the same way for the same seed', (t: TestContext) => {
    t.assert.deepStrictEqual(blindFile(FIXTURE, runs, 7).key, blindFile(FIXTURE, runs, 7).key);
  });

  it('mark what the code dropped instead of hiding the gap', (t: TestContext) => {
    const dropped = { baseline: [arc('opus', 1, ['🐦‍⬛ перший'], { dropped: [2] })], candidate: runs.candidate };
    dropped.baseline[0].outline = ['1. [breaking] …', '2. [fact] …'];
    t.assert.ok(blindFile(FIXTURE, dropped, 1).markdown.includes("dropped by the code's checks"));
  });
});

describe('the verdict', () => {
  const key = { 'opus#1': { A: 'candidate', B: 'baseline' }, 'opus#2': { A: 'baseline', B: 'candidate' } } as const;
  const clean = tallySide([arc('opus', 1, ['a'])]);
  const tallies = { baseline: clean, candidate: clean };

  it('decodes the labels back into models', (t: TestContext) => {
    const [decoded] = decodeVerdicts([{ item: 'opus#1', better: 'A', factErrors: { B: ['F1 bent'] }, publishable: { A: true } }], key, 1);
    t.assert.strictEqual(decoded.better, 'candidate');
    t.assert.deepStrictEqual(decoded.factErrors.baseline, ['F1 bent']);
    t.assert.strictEqual(decoded.publishable.candidate, true);
    t.assert.strictEqual(decoded.publishable.baseline, false);
  });

  it('does not call a tie a degradation', (t: TestContext) => {
    const decoded = decodeVerdicts(
      [
        { item: 'opus#1', better: 'tie', publishable: { A: true, B: true } },
        { item: 'opus#2', better: 'A', publishable: { A: true, B: true } },
      ],
      key,
      1,
    );
    const verdict = crowVerdict(decoded, tallies);
    t.assert.strictEqual(verdict.degraded, false);
    t.assert.strictEqual(verdict.wins.baseline, 1);
  });

  it('calls it a degradation when the judges prefer the baseline or the candidate bends more facts', (t: TestContext) => {
    const lost = decodeVerdicts(
      [
        { item: 'opus#1', better: 'B', publishable: { A: true, B: true } },
        { item: 'opus#2', better: 'A', publishable: { A: true, B: true } },
      ],
      key,
      1,
    );
    t.assert.strictEqual(crowVerdict(lost, tallies).degraded, true);
    const bent = decodeVerdicts([{ item: 'opus#1', better: 'A', factErrors: { A: ['invented a price'] }, publishable: { A: true, B: true } }], key, 1);
    t.assert.deepStrictEqual(crowVerdict(bent, tallies).reasons, ['fact errors: 0 → 1']);
  });

  it('rejects an answer for an item the key does not know', (t: TestContext) => {
    t.assert.throws(() => decodeVerdicts([{ item: 'nope#1', better: 'A' }], key, 2), /unknown item/);
  });
});

describe('the bundled stories', () => {
  it('are well formed', (t: TestContext) => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/crow-stories.json', import.meta.url), 'utf8'),
    ) as CrowFixture;
    t.assert.ok(fixture.roster.length > 0);
    t.assert.ok(fixture.stories.length >= 6);
    for (const story of fixture.stories) {
      t.assert.ok(story.facts.length > 0, story.name);
      t.assert.ok(story.tests, story.name);
      t.assert.deepStrictEqual(
        story.facts.map((fact) => fact.id),
        story.facts.map((_, i) => `F${i + 1}`),
        story.name,
      );
    }
  });
});
