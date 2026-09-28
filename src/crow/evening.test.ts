import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { eveningAt, EveningGoodbyes, goodbyeProblems, MIN_POSTS_FOR_GOODBYE, writeGoodbye } from './evening';
import type { GoodbyeRequest, TalkResult } from './prompts';
import type { QuietChat, RememberedPost } from './store';

const KYIV = 'Europe/Kyiv';
const at = (iso: string) => new Date(iso);

describe('eveningAt', () => {
  // 23:00–10:00, the default quiet hours
  const evening = (iso: string, timeZone = KYIV) => {
    const found = eveningAt(at(iso), timeZone, 1380, 600);
    return found && { quietStart: found.quietStart.toISOString(), dayStart: found.dayStart.toISOString() };
  };

  it('opens 35 minutes before the quiet hours and lasts until they begin, with the day since the morning', () => {
    assert.equal(evening('2026-09-27T19:24:00Z'), null); // 22:24 in Kyiv
    assert.deepEqual(evening('2026-09-27T19:25:00Z'), {
      quietStart: '2026-09-27T20:00:00.000Z',
      dayStart: '2026-09-27T07:00:00.000Z',
    });
    assert.ok(evening('2026-09-27T19:59:00Z'));
    assert.equal(evening('2026-09-27T20:00:00Z'), null);
  });

  it('follows the change to winter time', () => {
    // On 25.10.2026 Kyiv goes to UTC+2: 23:00 there is 21:00Z, and 10:00 is 08:00Z
    assert.deepEqual(evening('2026-10-25T20:30:00Z'), {
      quietStart: '2026-10-25T21:00:00.000Z',
      dayStart: '2026-10-25T08:00:00.000Z',
    });
  });

  it('counts in UTC for a chat that set no zone', () => {
    assert.equal(evening('2026-09-27T22:30:00Z', 'UTC')?.quietStart, '2026-09-27T23:00:00.000Z');
  });

  it('finds quiet hours that begin just after midnight, and the morning before them', () => {
    // 00:30–09:00: at 23:59 in Kyiv the quiet hours begin tomorrow, the day began this morning
    const found = eveningAt(at('2026-09-27T20:59:00Z'), KYIV, 30, 540);
    assert.equal(found?.quietStart.toISOString(), '2026-09-27T21:30:00.000Z');
    assert.equal(found?.dayStart.toISOString(), '2026-09-27T06:00:00.000Z');
  });

  it('is never without quiet hours', () => {
    assert.equal(eveningAt(at('2026-09-27T19:50:00Z'), KYIV, null, null), null);
  });
});

describe('goodbyeProblems', () => {
  const allowed = allowedNumbers('на 20% дешевший');
  it('wants a short text by the rules of an arc message', () => {
    assert.deepEqual(goodbyeProblems('🐦‍⬛ Все, коти, відпускаю. Opus досі на 20% дешевший.', allowed), []);
    assert.deepEqual(goodbyeProblems(`🐦‍⬛ ${'а'.repeat(420)}`, allowed), ['довше за 400 символів']);
    assert.deepEqual(goodbyeProblems('🐦‍⬛ Повернуся о 10:00.', allowed), ['час доби цифрами заборонений']);
  });
});

/** A model that answers from a list, one answer per call, and remembers what it was asked */
function fakeModel(...answers: string[]) {
  const requests: GoodbyeRequest[] = [];
  const write = async (request: GoodbyeRequest) => {
    requests.push(request);
    const result: TalkResult = { text: answers[requests.length - 1] };
    return { result, costUsd: 0.0003 };
  };
  return { write, requests };
}

const request: GoodbyeRequest = { recentPosts: [], verdicts: [], continuing: [], previousGoodbyes: [], maxLength: 400 };

describe('writeGoodbye', () => {
  it('keeps a goodbye that passes, with its crow counted', async () => {
    const goodbye = await writeGoodbye(fakeModel('Все, коти, відпускаю.').write, request, allowedNumbers());
    assert.equal(goodbye.text, '🐦‍⬛ Все, коти, відпускаю.');
  });

  it('rewrites once, then gives up', async () => {
    const model = fakeModel('🐦‍⬛ Повернуся о 10:00.', '🐦‍⬛ Повернуся зранку.');
    assert.equal((await writeGoodbye(model.write, request, allowedNumbers())).text, '🐦‍⬛ Повернуся зранку.');
    assert.deepEqual(model.requests[1].corrections, ['час доби цифрами заборонений']);
    const stubborn = fakeModel('🐦‍⬛ О 10:00.', '🐦‍⬛ О 10:00.');
    assert.equal((await writeGoodbye(stubborn.write, request, allowedNumbers())).text, null);
  });
});

/** A store with one chat of the default quiet hours in Kyiv and the given posts of the day */
function fakeStore(today: RememberedPost[], planned = false) {
  const goodbyes: { text: string; notBefore: Date; expiresAt: Date }[] = [];
  const store = {
    quietChats: async (): Promise<QuietChat[]> => [{ chatId: '-100', timeZone: KYIV, quietFrom: 1380, quietTo: 600 }],
    plannedSince: async () => planned || goodbyes.length > 0,
    postsSince: async () => today,
    dayVerdicts: async () => ['Claude Opus 5.5: найкраща модель'],
    continuingStories: async () => ['Claude Opus 5.5'],
    recentGoodbyes: async () => ['🐦‍⬛ Вчорашнє прощання'],
    planGoodbye: async (_chatId: string, goodbye: { text: string; notBefore: Date; expiresAt: Date }) => {
      goodbyes.push(goodbye);
    },
  };
  return { store, goodbyes };
}

const post = (text: string, iso: string): RememberedPost => ({ text, sentAt: at(iso) });
const day = [post('🐦‍⬛ Хвіст арки', '2026-09-27T15:00:00Z'), post('🐦‍⬛🐦‍⬛🐦‍⬛ Прильот', '2026-09-27T09:00:00Z')];

describe('EveningGoodbyes', () => {
  it('plans the goodbye 20 minutes before the quiet hours, dropped if it cannot go before they begin', async () => {
    const { store, goodbyes } = fakeStore(day);
    const model = fakeModel('🐦‍⬛ Все, коти, на сьогодні відпускаю.');
    const job = new EveningGoodbyes(store, model.write, () => at('2026-09-27T19:30:00Z')).job();
    const state = await job.run({});
    assert.deepEqual(goodbyes, [
      {
        text: '🐦‍⬛ Все, коти, на сьогодні відпускаю.',
        notBefore: at('2026-09-27T19:40:00Z'),
        expiresAt: at('2026-09-27T20:00:00Z'),
      },
    ]);
    // The day's posts, the verdicts, what goes on tomorrow and the last goodbyes go into the request
    assert.deepEqual(model.requests[0].recentPosts, ['(4 год тому) 🐦‍⬛ Хвіст арки', '(10 год тому) 🐦‍⬛🐦‍⬛🐦‍⬛ Прильот']);
    assert.deepEqual(model.requests[0].verdicts, ['Claude Opus 5.5: найкраща модель']);
    assert.deepEqual(model.requests[0].continuing, ['Claude Opus 5.5']);
    assert.deepEqual(model.requests[0].previousGoodbyes, ['🐦‍⬛ Вчорашнє прощання']);
    // One try an evening
    await job.run(state as Record<string, unknown>);
    assert.equal(model.requests.length, 1);
  });

  it('after a downtime, says goodbye at once while there is still time', async () => {
    const { store, goodbyes } = fakeStore(day);
    await new EveningGoodbyes(store, fakeModel('🐦‍⬛ Бувайте.').write, () => at('2026-09-27T19:50:00Z')).job().run({});
    assert.equal(goodbyes[0].notBefore.toISOString(), '2026-09-27T19:50:00.000Z');
  });

  it(`says no goodbye after a day of fewer than ${MIN_POSTS_FOR_GOODBYE} posts, twice, or outside the evening`, async () => {
    const quiet = fakeStore(day.slice(0, 1));
    await new EveningGoodbyes(quiet.store, fakeModel('🐦‍⬛ Бувайте.').write, () => at('2026-09-27T19:30:00Z'))
      .job()
      .run({});
    assert.equal(quiet.goodbyes.length, 0);

    const already = fakeStore(day, true);
    const model = fakeModel('🐦‍⬛ Бувайте.');
    await new EveningGoodbyes(already.store, model.write, () => at('2026-09-27T19:30:00Z')).job().run({});
    assert.equal(model.requests.length, 0);

    const afternoon = fakeStore(day);
    await new EveningGoodbyes(afternoon.store, fakeModel('🐦‍⬛ Бувайте.').write, () => at('2026-09-27T14:00:00Z'))
      .job()
      .run({});
    assert.equal(afternoon.goodbyes.length, 0);
  });

  it('keeps quiet when the goodbye fails its checks', async () => {
    const { store, goodbyes } = fakeStore(day);
    await new EveningGoodbyes(store, fakeModel('🐦‍⬛ О 10:00.', '🐦‍⬛ О 10:00.').write, () => at('2026-09-27T19:30:00Z'))
      .job()
      .run({});
    assert.equal(goodbyes.length, 0);
  });
});
