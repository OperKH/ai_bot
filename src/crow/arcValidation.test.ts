import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers, arcProblems, crowPrefix, type DraftMessage, messageProblems } from './arcValidation';

const facts = [
  { id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' },
  { id: 'F2', text: 'Генерація в середньому на 30% швидша' },
];
const allowed = allowedNumbers('Anthropic випустили Claude Opus 5.5', ...facts.map((f) => f.text), 'openai: GPT-6');
const factIds = new Set(['F1', 'F2']);

const message = (patch: Partial<DraftMessage> = {}): DraftMessage => ({
  kind: 'fact',
  crows: 2,
  text: '🐦‍⬛🐦‍⬛ Мінус **20%** до ціни Opus 5 — і розумніший за GPT-6. Кар.',
  optional: false,
  factIds: ['F1'],
  table: null,
  ...patch,
});

describe('messageProblems', () => {
  it('passes a message that keeps to its facts', () => {
    assert.deepEqual(messageProblems(message(), allowed, factIds), []);
  });

  it('wants exactly as many crows in front as the message says', () => {
    assert.deepEqual(messageProblems(message({ crows: 3 }), allowed, factIds), ['текст має починатися рівно з 3 🐦‍⬛']);
    assert.deepEqual(messageProblems(message({ crows: 1 }), allowed, factIds), ['текст має починатися рівно з 1 🐦‍⬛']);
    assert.deepEqual(messageProblems(message({ crows: 4 }), allowed, factIds), ['crows має бути 1, 2 або 3']);
  });

  it('catches numbers that are not in the facts', () => {
    const problems = messageProblems(message({ text: '🐦‍⬛🐦‍⬛ У 1,3 раза швидший і на 40% дешевший.' }), allowed, factIds);
    assert.deepEqual(problems, ['числа 1.3 немає у фактах', 'числа 40 немає у фактах']);
  });

  it('allows small counts, and numbers from the title and the roster', () => {
    assert.deepEqual(messageProblems(message({ text: '🐦‍⬛🐦‍⬛ Я казала це 2 рази: Opus 5.5 рве GPT-6.' }), allowed, factIds), []);
  });

  it('forbids a time of day in digits', () => {
    assert.deepEqual(messageProblems(message({ text: '🐦‍⬛🐦‍⬛ Прилетіла о 10:02.' }), allowed, factIds), [
      'час доби цифрами заборонений',
    ]);
  });

  it('forbids politics and slurs, but not words that only look alike', () => {
    assert.deepEqual(messageProblems(message({ text: '🐦‍⬛🐦‍⬛ Навіть Трамп би оцінив.' }), allowed, factIds), [
      'заборонена тема: політика, війна чи образи',
    ]);
    assert.deepEqual(
      messageProblems(message({ text: '🐦‍⬛🐦‍⬛ Стрибок як з трампліна, а ціни — як після педикюру.' }), allowed, factIds),
      [],
    );
  });

  it('checks the numbers and the shape of a table', () => {
    const table = { header: ['', 'Opus 5', 'Opus 5.5'], rows: [['Ціна', '100%', '80%']] };
    assert.deepEqual(messageProblems(message({ table }), allowed, factIds), [
      'числа 100 немає у фактах',
      'числа 80 немає у фактах',
    ]);
    const ragged = { header: ['Модель', 'Ціна'], rows: [['Opus 5.5']] };
    assert.deepEqual(messageProblems(message({ table: ragged }), allowed, factIds), [
      'рядки таблиці не збігаються з заголовком',
    ]);
  });

  it('catches facts that do not exist', () => {
    assert.deepEqual(messageProblems(message({ factIds: ['F1', 'F7'] }), allowed, factIds), ['факту F7 немає']);
  });

  it('gives the opening twice the room of a message: it tells six facts', () => {
    const text = (length: number) => `🐦‍⬛🐦‍⬛ ${'кар '.repeat(length / 4)}`.slice(0, length);
    assert.deepEqual(messageProblems(message({ kind: 'breaking', text: text(1500) }), allowed, factIds), []);
    assert.deepEqual(messageProblems(message({ kind: 'breaking', text: text(2600) }), allowed, factIds), ['довше за 2500 символів']);
    assert.deepEqual(messageProblems(message({ text: text(1300) }), allowed, factIds), ['довше за 1200 символів']);
  });
});

describe('crowPrefix', () => {
  it('counts the crows the text opens with', () => {
    assert.deepEqual(crowPrefix('🐦‍⬛🐦‍⬛ Кар.'), { crows: 2, text: '🐦‍⬛🐦‍⬛ Кар.' });
    assert.deepEqual(crowPrefix(' 🐦‍⬛ 🐦‍⬛🐦‍⬛  КАРРР!'), { crows: 3, text: '🐦‍⬛🐦‍⬛🐦‍⬛ КАРРР!' });
  });

  it('gives a text without crows one, and cuts more than three', () => {
    assert.deepEqual(crowPrefix('Кар.'), { crows: 1, text: '🐦‍⬛ Кар.' });
    assert.deepEqual(crowPrefix('🐦‍⬛🐦‍⬛🐦‍⬛🐦‍⬛ Зграя!'), { crows: 3, text: '🐦‍⬛🐦‍⬛🐦‍⬛ Зграя!' });
  });
});

describe('arcProblems', () => {
  it('numbers the messages from one, as the model sees them', () => {
    const arc = [message(), message({ text: '🐦‍⬛🐦‍⬛ О 18:00 буде стрім.' })];
    assert.deepEqual(arcProblems(arc, allowed, factIds), [
      { number: 2, problems: ['час доби цифрами заборонений', 'числа 18 немає у фактах'] },
    ]);
  });
});
