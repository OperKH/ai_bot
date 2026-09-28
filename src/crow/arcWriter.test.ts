import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { arcRequest, hoursLabel, writeArc } from './arcWriter';
import { findCategory } from './categories';
import type { ArcRequest, ArcResult } from './prompts';

const HOUR = 3_600_000;
const facts = Array.from({ length: 8 }, (_, i) => ({ id: `F${i + 1}`, text: `факт ${i + 1}` }));
const story = { title: 'Claude Opus 5.5', category: findCategory('ai-enterprise')!, importance: 3 as const, isRumor: false, facts };
const memory = { recentPosts: [], previousStances: [] };

/** A model that answers from a list, one answer per call, and remembers what it was asked */
function fakeModel(...answers: string[][]) {
  const requests: ArcRequest[] = [];
  const write = async (request: ArcRequest) => {
    requests.push(request);
    const texts = answers[requests.length - 1];
    const result: ArcResult = {
      messages: texts.map((text) => ({ text, table: null })),
      stance: { subject: 'Claude Opus 5.5', verdict: 'імба' },
    };
    return { result, costUsd: 0.01 };
  };
  return { write, requests };
}

describe('hoursLabel', () => {
  it('declines the hours as «протягом» wants them', () => {
    assert.equal(hoursLabel(30 * HOUR), '30 годин');
    assert.equal(hoursLabel(4 * HOUR), '4 годин');
    assert.equal(hoursLabel(21 * HOUR), '21 години');
    assert.equal(hoursLabel(11 * HOUR), '11 годин');
    assert.equal(hoursLabel(undefined), 'кількох годин');
  });
});

describe('arcRequest', () => {
  it('lays out the arc for the boldest chat and no longer than the facts carry', () => {
    const { request, outline } = arcRequest(story, ['openai: GPT-6 Sol'], memory, new Date());
    assert.deepEqual(
      outline.map((item) => item.kind),
      ['breaking', 'fact', 'fact', 'versus'],
    );
    assert.equal(request.outline.length, outline.length);
    assert.equal(request.window, '30 годин');
    assert.equal(request.categoryName, '🤖 AI Enterprise — флагманські моделі');
  });

  it('compares with nobody when there is no roster: a game news gets a fact in its place', () => {
    const game = { ...story, title: 'Switch 2 price', category: findCategory('nintendo')! };
    const { outline } = arcRequest(game, [], memory, new Date());
    assert.deepEqual(
      outline.map((item) => item.kind),
      ['breaking', 'fact', 'fact'],
    );
  });
});

describe('writeArc', () => {
  const { request, outline } = arcRequest(story, ['openai: GPT-6 Sol'], memory, new Date());
  const good = ['🐦‍⬛🐦‍⬛🐦‍⬛ Прильот', '🐦‍⬛ Четвертий', '🐦‍⬛ П’ятий', '🐦‍⬛🐦‍⬛ Порівняння'];

  it('keeps a clean arc after one call, with the crows counted from the text', async () => {
    const model = fakeModel(good);
    const arc = await writeArc(model.write, request, outline);
    assert.equal(arc.attempts.length, 1);
    assert.equal(arc.failed, false);
    assert.deepEqual(arc.dropped, []);
    assert.deepEqual(
      arc.messages.map((m) => [m.kind, m.crows]),
      [['breaking', 3], ['fact', 1], ['fact', 1], ['versus', 2]],
    );
  });

  it('rewrites once with the problems listed, then drops what still fails', async () => {
    const invented = good.map((text, i) => (i === 2 ? '🐦‍⬛ На 42% краще' : text));
    const model = fakeModel(invented, invented);
    const arc = await writeArc(model.write, request, outline);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(model.requests[1].corrections, ['Повідомлення 3: числа 42 немає у фактах']);
    assert.deepEqual(arc.dropped, [3]);
    assert.equal(arc.failed, false);
    assert.equal(arc.messages.length, 3);
    assert.equal(arc.attempts.reduce((sum, a) => sum + a.costUsd, 0), 0.02);
  });

  it('fails the arc when the opening still fails, and asks for the right count', async () => {
    const model = fakeModel(good.slice(0, 3), ['🐦‍⬛🐦‍⬛🐦‍⬛ О 18:00', ...good.slice(1)]);
    const arc = await writeArc(model.write, request, outline);
    assert.deepEqual(model.requests[1].corrections, ['повідомлень має бути рівно 4, а не 3']);
    assert.equal(arc.failed, true);
  });
});
