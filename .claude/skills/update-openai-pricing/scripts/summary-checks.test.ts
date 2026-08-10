// node --test .claude/skills/update-openai-pricing/scripts/summary-checks.test.ts
//
// (add --experimental-test-coverage for a coverage table; requires Node >= 26)

import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';

import {
  checkSummary,
  extractTemplateConst,
  isClean,
  sections,
  similarity,
  type SummaryResult,
} from './summary-checks.ts';

const INPUT = ['101', '102', '103', '104', '105'];

const CLEAN: SummaryResult = {
  topics: [
    { topic: 'Обговорення нового ноутбука та вибору між моделями', messageIds: ['101', '102'] },
    { topic: 'Суперечка про якість кави в офісі біля метро', messageIds: ['103'] },
  ],
  trends: [{ trend: 'Учасники масово переходять на механічні клавіатури', messageIds: ['104'] }],
  events: [{ event: 'Зустріч у суботу о 19:00 біля кінотеатру', messageIds: ['105'] }],
  gaming: null,
  memes: null,
  fullSummary: 'Чат обговорював техніку, каву та домовився про зустріч.',
};

describe('flattening a result into checkable sections', () => {
  it('covers every part the no-duplication rule applies to', (t: TestContext) => {
    const found = sections({
      ...CLEAN,
      gaming: { summary: 'про ігри', messageIds: ['104'] },
      memes: { summary: 'про меми', messageIds: ['105'] },
    });
    t.assert.deepStrictEqual(
      found.map((section) => section.path),
      ['topics[0]', 'topics[1]', 'trends[0]', 'events[0]', 'gaming', 'memes'],
    );
  });

  it('skips the nullable sections when the model left them out', (t: TestContext) => {
    t.assert.strictEqual(
      sections(CLEAN).filter((section) => section.path === 'gaming' || section.path === 'memes').length,
      0,
    );
  });
});

describe('similarity', () => {
  it('scores a rephrasing high and unrelated text low', (t: TestContext) => {
    const rephrased = similarity(
      'Обговорення нового ноутбука та вибору між моделями',
      'Обговорення вибору нового ноутбука між різними моделями',
    );
    t.assert.ok(rephrased > 0.6, `rephrasing scored ${rephrased.toFixed(2)}`);
    t.assert.ok(similarity('Обговорення ноутбука', 'Зустріч у суботу біля кінотеатру') < 0.2);
  });

  it('is symmetric and safe on empty text', (t: TestContext) => {
    t.assert.strictEqual(similarity('однакові слова', 'однакові слова'), 1);
    t.assert.strictEqual(similarity('', 'щось'), 0);
    t.assert.strictEqual(similarity('ab', 'ab'), 0, 'too short to form a trigram');
  });
});

describe('checking one summary', () => {
  it('passes a result that keeps its topics apart', (t: TestContext) => {
    const report = checkSummary(CLEAN, INPUT);
    t.assert.deepStrictEqual(report.bleedingIds, []);
    t.assert.deepStrictEqual(report.duplicateSections, []);
    t.assert.deepStrictEqual(report.unknownIds, []);
    t.assert.strictEqual(report.coverage, 1);
    t.assert.strictEqual(isClean(report), true);
  });

  it('catches the same message cited from two sections', (t: TestContext) => {
    const bleeding: SummaryResult = {
      ...CLEAN,
      gaming: { summary: 'Обговорення ігор на новому ноутбуці', messageIds: ['101', '104'] },
    };
    const report = checkSummary(bleeding, INPUT);
    t.assert.deepStrictEqual(report.bleedingIds, [
      { id: '101', paths: ['topics[0]', 'gaming'] },
      { id: '104', paths: ['trends[0]', 'gaming'] },
    ]);
    t.assert.strictEqual(isClean(report), false);
  });

  it('catches two sections that say the same thing in different words', (t: TestContext) => {
    const repeated: SummaryResult = {
      ...CLEAN,
      topics: [
        { topic: 'Обговорення нового ноутбука та вибору між моделями', messageIds: ['101'] },
        { topic: 'Обговорення вибору нового ноутбука між моделями', messageIds: ['102'] },
      ],
    };
    const report = checkSummary(repeated, INPUT);
    t.assert.strictEqual(report.duplicateSections.length, 1);
    t.assert.deepStrictEqual(report.duplicateSections[0].paths, ['topics[0]', 'topics[1]']);
    t.assert.ok(report.duplicateSections[0].similarity > 0.6);
  });

  it('catches invented message ids and measures coverage', (t: TestContext) => {
    const invented: SummaryResult = { topics: [{ topic: 'Щось', messageIds: ['999'] }], fullSummary: '' };
    const report = checkSummary(invented, INPUT);
    t.assert.deepStrictEqual(report.unknownIds, ['999']);
    t.assert.strictEqual(report.coverage, 0);
  });

  it('enforces the two rules the prompt spells out for events and fullSummary', (t: TestContext) => {
    const sloppy: SummaryResult = {
      ...CLEAN,
      events: [{ event: 'Домовились колись зустрітися', messageIds: ['105'] }],
      fullSummary: 'Учасники домовились про зустріч (105).',
    };
    const report = checkSummary(sloppy, INPUT);
    t.assert.deepStrictEqual(report.eventsWithoutDate, ['Домовились колись зустрітися']);
    t.assert.deepStrictEqual(report.idsLeakedIntoFullSummary, ['105']);
    t.assert.strictEqual(isClean(report), false);
  });

  it('accepts an event that admits the date is unknown', (t: TestContext) => {
    const report = checkSummary(
      { ...CLEAN, events: [{ event: 'Зустріч, дата не вказана', messageIds: ['105'] }] },
      INPUT,
    );
    t.assert.deepStrictEqual(report.eventsWithoutDate, []);
  });
});

describe('reading the shipped prompt', () => {
  const source = readFileSync(new URL('../../../../src/services/openai.service.ts', import.meta.url), 'utf8');

  it('extracts the prompt the bot actually sends', (t: TestContext) => {
    const prompt = extractTemplateConst(source, 'SUMMARIZATION_PROMPT');
    t.assert.match(prompt, /HARD CONSTRAINTS/);
    t.assert.match(prompt, /NO DUPLICATION RULE/, 'the rule the bleed check enforces');
    t.assert.match(prompt, /EVENTS > GAMING > TOPICS/);
  });

  it('still lines up with the schema the app declares', (t: TestContext) => {
    // the checks walk these fields by name; if the schema is renamed they must follow
    for (const field of ['topParticipants', 'topics', 'trends', 'gaming', 'memes', 'events', 'fullSummary']) {
      t.assert.match(source, new RegExp(String.raw`\n\s{2}${field}:`), `${field} is still in the schema`);
    }
  });

  it('reports a missing constant instead of returning nonsense', (t: TestContext) => {
    t.assert.throws(() => extractTemplateConst('const OTHER = 1;', 'SUMMARIZATION_PROMPT'), /Could not find/);
  });
});
