// node --test .claude/skills/update-openai-pricing/scripts/crow-talk-checks.test.ts
//
// (requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import { type Decoded, decodeVerdicts } from './crow-checks.ts';
import { blindTalksFile, type CrowTalksFixture, type TalkRun, talkVerdict, tallyTalks } from './crow-talk-checks.ts';

const FIXTURE: CrowTalksFixture = {
  talks: [
    {
      name: 'shrug',
      tests: 'the cat shrugs the release off',
      request: {
        kind: 'chime',
        message: { name: 'Богдан', text: 'похуй на этот релиз' },
        thread: [],
        recentChat: ['Олег: Gears of War: E-Day получила 87 баллов'],
        stories: [
          {
            title: 'Gears of War: E-Day reviews',
            facts: [{ id: 'F1', text: 'Gears of War: E-Day вийде 6 жовтня.' }],
            details: [{ id: 'Z1', text: 'Кампанія триває кілька днів.' }],
            planned: [],
          },
        ],
        recentPosts: ['🐦‍⬛ Раніше'],
        catTopics: [],
        nickname: null,
        chatNicknames: ['Тарас — «вовче»'],
        maxLength: 400,
      },
    },
  ],
};

const talk = (run: number, text: string | null, extra: Partial<NonNullable<TalkRun['written']>> = {}): TalkRun => ({
  talk: 'shrug',
  run,
  written: { text, declined: text === null, nickname: null, attempts: [{ costUsd: 0.001, problems: [] }], ...extra },
  ms: 2000,
  error: null,
});

describe('what a script can see in a talk', () => {
  it('tallies the spoken, the silent, the failed and the complaints of the chat', (t: TestContext) => {
    const tally = tallyTalks([
      talk(1, '🐦‍⬛ Котику, а кампанія — кілька днів у пеклі.'),
      talk(2, null),
      talk(3, null, { declined: false, attempts: [{ costUsd: 0.001, problems: ['x'] }, { costUsd: 0.001, problems: ['x'] }] }),
      talk(4, '🐦‍⬛ Сорока ще не принесла.', { nickname: 'тигре' }),
      { talk: 'shrug', run: 5, written: null, ms: 1000, error: '400 reasoning_effort' },
    ]);
    t.assert.strictEqual(tally.talks, 5);
    t.assert.strictEqual(tally.errors, 1);
    t.assert.strictEqual(tally.spoke, 2);
    t.assert.strictEqual(tally.declined, 1);
    t.assert.strictEqual(tally.failed, 1);
    t.assert.strictEqual(tally.rewritten, 1);
    t.assert.strictEqual(tally.catOpenings, 1);
    t.assert.strictEqual(tally.magpie, 1);
    t.assert.strictEqual(tally.nicknames, 1);
  });
});

describe('blind talk files', () => {
  const runs = { baseline: [talk(1, '🐦‍⬛ Базова відповідь')], candidate: [talk(1, null)] };

  it('hide which model answered, and the key says it', (t: TestContext) => {
    const { markdown, key } = blindTalksFile(FIXTURE, runs, 1);
    t.assert.ok(!markdown.includes('baseline') && !markdown.includes('candidate'));
    t.assert.deepStrictEqual(new Set(Object.values(key['shrug#1'])), new Set(['baseline', 'candidate']));
    t.assert.ok(markdown.includes('*(she keeps quiet)*'), 'her silence is an answer to judge');
  });

  it('give the judges the message, the chat, the facts and her store', (t: TestContext) => {
    const { markdown } = blindTalksFile(FIXTURE, runs, 2);
    for (const text of ['похуй на этот релиз', 'получила 87 баллов', 'F1: Gears of War', 'Z1 (her store', 'Тарас — «вовче»']) {
      t.assert.ok(markdown.includes(text), text);
    }
  });
});

describe('the talks verdict', () => {
  const tallies = { baseline: tallyTalks([talk(1, '🐦‍⬛ a')]), candidate: tallyTalks([talk(1, '🐦‍⬛ b')]) };
  const decoded = (better: Decoded['better'], fit: boolean): Decoded => ({
    item: 'shrug#1',
    judge: 1,
    better,
    factErrors: { baseline: [], candidate: [] },
    publishable: { baseline: true, candidate: fit },
  });

  it('does not call a tie or a win a degradation', (t: TestContext) => {
    t.assert.strictEqual(talkVerdict([decoded('tie', true), decoded('candidate', true)], tallies).degraded, false);
  });

  it('calls it one when the judges prefer the baseline or fewer answers fit', (t: TestContext) => {
    const verdict = talkVerdict([decoded('baseline', false), decoded('baseline', true)], tallies);
    t.assert.strictEqual(verdict.degraded, true);
    t.assert.strictEqual(verdict.reasons.length, 2);
  });

  it('decodes the labels as the arcs do', (t: TestContext) => {
    const [d] = decodeVerdicts([{ item: 'shrug#1', better: 'A', publishable: { A: true, B: false } }], { 'shrug#1': { A: 'candidate', B: 'baseline' } }, 1);
    t.assert.strictEqual(d.better, 'candidate');
    t.assert.deepStrictEqual(d.publishable, { candidate: true, baseline: false });
  });
});

describe('the bundled talks', () => {
  it('are well formed, with made-up names', (t: TestContext) => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/crow-talks.json', import.meta.url), 'utf8')) as CrowTalksFixture;
    t.assert.ok(fixture.talks.length >= 10);
    t.assert.strictEqual(new Set(fixture.talks.map((entry) => entry.name)).size, fixture.talks.length, 'unique names');
    for (const { name, tests, request } of fixture.talks) {
      t.assert.ok(tests, `${name}: says what it tests`);
      t.assert.ok(request.kind === 'reply' || request.kind === 'chime', name);
      t.assert.ok(request.message.text && request.message.name, name);
      t.assert.ok(Array.isArray(request.chatNicknames) && request.maxLength > 0, name);
      if (request.kind === 'chime') t.assert.ok(request.stories.length > 0, `${name}: a chime-in is about a story`);
    }
  });
});
