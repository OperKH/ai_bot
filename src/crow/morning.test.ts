import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { digestNews, digestProblems, MAX_DIGEST_STORIES, morningEnd, MorningDigests, writeDigest } from './morning';
import type { MorningRequest, TalkResult } from './prompts';
import type { NewDigest, QuietChat, RememberedPost, WaitingNews } from './store';

const KYIV = 'Europe/Kyiv';
const at = (iso: string) => new Date(iso);

describe('morningEnd', () => {
  // 23:00–10:00, the default quiet hours
  const end = (iso: string, timeZone = KYIV) => morningEnd(at(iso), timeZone, 1380, 600)?.toISOString() ?? null;

  it('is the end of the quiet hours, from 15 minutes before it to 2 hours after', () => {
    assert.equal(end('2026-09-27T06:44:00Z'), null); // 09:44 in Kyiv
    assert.equal(end('2026-09-27T06:45:00Z'), '2026-09-27T07:00:00.000Z');
    assert.equal(end('2026-09-27T08:59:00Z'), '2026-09-27T07:00:00.000Z');
    assert.equal(end('2026-09-27T09:00:00Z'), null);
  });

  it('follows the change to winter time', () => {
    // On 25.10.2026 Kyiv goes to UTC+2: 10:00 there is 08:00Z, a day before it was 07:00Z
    assert.equal(end('2026-10-25T07:50:00Z'), '2026-10-25T08:00:00.000Z');
    assert.equal(end('2026-10-24T06:50:00Z'), '2026-10-24T07:00:00.000Z');
  });

  it('counts in UTC for a chat that set no zone', () => {
    assert.equal(end('2026-09-27T09:50:00Z', 'UTC'), '2026-09-27T10:00:00.000Z');
  });

  it('finds an end just past midnight', () => {
    // 22:00–00:05: at 23:55 in Kyiv the end is tomorrow's 00:05
    assert.equal(morningEnd(at('2026-09-26T20:55:00Z'), KYIV, 1320, 5)?.toISOString(), '2026-09-26T21:05:00.000Z');
  });

  it('is never without quiet hours', () => {
    assert.equal(morningEnd(at('2026-09-27T07:00:00Z'), KYIV, null, null), null);
  });
});

const waiting = (postId: number, importance: 1 | 2 | 3, notBefore: string): WaitingNews => ({
  postId,
  storyId: postId * 10,
  importance,
  notBefore: at(notBefore),
  title: `Story ${postId}`,
  categories: ['ai-enterprise'],
  facts: [
    { id: 'F1', text: `Факт перший історії ${postId}` },
    { id: 'F2', text: 'Ціна 20 доларів' },
    { id: 'F4', text: 'Факт поза прильотом' },
  ],
  opening: `🐦‍⬛🐦‍⬛🐦‍⬛ Прильот ${postId}`,
  factIds: ['F1', 'F2'],
});

describe('digestNews', () => {
  it('needs two stories at least', () => {
    assert.equal(digestNews([waiting(1, 3, '2026-09-27T01:00:00Z')]), null);
  });

  it('tells the most important news first, the earlier first among equals, and no more than fit', () => {
    const news = digestNews([
      waiting(1, 1, '2026-09-27T01:00:00Z'),
      waiting(2, 3, '2026-09-27T03:00:00Z'),
      waiting(3, 3, '2026-09-27T02:00:00Z'),
      ...[4, 5, 6, 7].map((id) => waiting(id, 2, '2026-09-27T04:00:00Z')),
    ]);
    assert.equal(news?.length, MAX_DIGEST_STORIES);
    assert.deepEqual(
      news?.map((item) => item.postId),
      [3, 2, 4, 5, 6, 7],
    );
  });
});

describe('digestProblems', () => {
  const allowed = allowedNumbers('Ціна 20 доларів');
  const good = '🐦‍⬛🐦‍⬛ Доброго ранку, ледащо!\n• Перше — за **20** доларів.\n• Друге.\nПодробиці — протягом дня.';

  it('passes a digest with a line per story', () => {
    assert.deepEqual(digestProblems(good, 2, allowed), []);
  });

  it('wants a line per story, and the rules of an arc message', () => {
    assert.deepEqual(digestProblems(good, 3, allowed), ['пунктів «• » має бути рівно 3, а не 2']);
    assert.deepEqual(digestProblems(good.replace('**20**', '30'), 2, allowed), ['числа 30 немає у фактах']);
    assert.deepEqual(digestProblems(`${good}\nСтрім о 18:00.`, 2, allowed), [
      'час доби цифрами заборонений',
      'числа 18 немає у фактах',
    ]);
  });
});

/** A model that answers from a list, one answer per call, and remembers what it was asked */
function fakeModel(...answers: string[]) {
  const requests: MorningRequest[] = [];
  const write = async (request: MorningRequest) => {
    requests.push(request);
    const result: TalkResult = { text: answers[requests.length - 1] };
    return { result, costUsd: 0.001 };
  };
  return { write, requests };
}

const request: MorningRequest = {
  stories: [waiting(1, 3, '2026-09-27T01:00:00Z'), waiting(2, 2, '2026-09-27T02:00:00Z')].map((item) => ({
    title: item.title,
    categoryName: '🤖 AI Enterprise',
    importance: item.importance,
    facts: item.facts,
    opening: item.opening,
  })),
  recentPosts: [],
  maxLength: 1500,
};
const allowed = allowedNumbers('Ціна 20 доларів');

describe('writeDigest', () => {
  it('keeps a digest that passes, with its crows counted', async () => {
    const model = fakeModel('🐦‍⬛ 🐦‍⬛  Ранок!\n• Одне.\n• Друге.\nДалі — вдень.');
    const digest = await writeDigest(model.write, request, allowed);
    assert.equal(digest.text, '🐦‍⬛🐦‍⬛ Ранок!\n• Одне.\n• Друге.\nДалі — вдень.');
    assert.equal(digest.attempts.length, 1);
  });

  it('rewrites once with the problems listed', async () => {
    const model = fakeModel('🐦‍⬛🐦‍⬛ Ранок!\n• Все разом.', '🐦‍⬛🐦‍⬛ Ранок!\n• Одне.\n• Друге.\nДалі — вдень.');
    const digest = await writeDigest(model.write, request, allowed);
    assert.equal(digest.text, '🐦‍⬛🐦‍⬛ Ранок!\n• Одне.\n• Друге.\nДалі — вдень.');
    assert.deepEqual(model.requests[1].corrections, ['пунктів «• » має бути рівно 2, а не 1']);
  });

  it('gives up when the rewrite fails too', async () => {
    const model = fakeModel('🐦‍⬛🐦‍⬛ • Все разом.', '🐦‍⬛🐦‍⬛ • Знову разом.');
    const digest = await writeDigest(model.write, request, allowed);
    assert.equal(digest.text, null);
    assert.equal(digest.attempts.length, 2);
  });
});

/** A store with one chat of the default quiet hours in Kyiv and the given news waiting there */
function fakeStore(news: WaitingNews[]) {
  const created: { chatId: string; digest: NewDigest; postIds: number[] }[] = [];
  const store = {
    quietChats: async (): Promise<QuietChat[]> => [
      { chatId: '-100', timeZone: KYIV, quietFrom: 1380, quietTo: 600 },
    ],
    plannedSince: async () => created.length > 0,
    waitingNews: async (_chatId: string, until: Date) => news.filter((item) => item.notBefore <= until),
    recentPosts: async (): Promise<RememberedPost[]> => [{ text: '🐦‍⬛ Учорашнє', sentAt: at('2026-09-26T15:00:00Z') }],
    createDigest: async (chatId: string, digest: NewDigest, postIds: number[]) => {
      created.push({ chatId, digest, postIds });
      return 99;
    },
  };
  return { store, created };
}

describe('MorningDigests', () => {
  const answer = '🐦‍⬛🐦‍⬛ Ранок!\n• Одне.\n• Друге.\nДалі — вдень.';

  it('plans the digest for the end of the quiet hours, in place of the news it tells', async () => {
    const { store, created } = fakeStore([
      waiting(1, 2, '2026-09-27T01:00:00Z'),
      waiting(2, 3, '2026-09-27T03:00:00Z'),
    ]);
    const model = fakeModel(answer);
    const job = new MorningDigests(store, model.write, () => at('2026-09-27T06:47:00Z')).job();
    const state = await job.run({});
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].postIds, [2, 1]);
    assert.equal(created[0].digest.notBefore.toISOString(), '2026-09-27T07:00:00.000Z');
    assert.equal(created[0].digest.importance, 3);
    assert.equal(created[0].digest.text, answer);
    // The opening's own facts go into the request, and the chat's memory with how long ago
    assert.deepEqual(
      model.requests[0].stories[0].facts.map((f) => f.id),
      ['F1', 'F2'],
    );
    assert.deepEqual(model.requests[0].recentPosts, ['(15 год тому) 🐦‍⬛ Учорашнє']);
    // Tried this morning: the next run leaves the chat alone
    await job.run(state as Record<string, unknown>);
    assert.equal(model.requests.length, 1);
  });

  it('makes no digest of one story, nor outside the morning', async () => {
    const one = fakeStore([waiting(1, 3, '2026-09-27T01:00:00Z')]);
    await new MorningDigests(one.store, fakeModel(answer).write, () => at('2026-09-27T06:47:00Z')).job().run({});
    assert.equal(one.created.length, 0);

    const two = fakeStore([waiting(1, 3, '2026-09-27T01:00:00Z'), waiting(2, 3, '2026-09-27T02:00:00Z')]);
    await new MorningDigests(two.store, fakeModel(answer).write, () => at('2026-09-27T12:00:00Z')).job().run({});
    assert.equal(two.created.length, 0);
  });

  it('after a downtime, tells what waits and sends it at once', async () => {
    const { store, created } = fakeStore([
      waiting(1, 2, '2026-09-27T01:00:00Z'),
      waiting(2, 2, '2026-09-27T02:00:00Z'),
    ]);
    await new MorningDigests(store, fakeModel(answer).write, () => at('2026-09-27T08:10:00Z')).job().run({});
    assert.equal(created[0].digest.notBefore.toISOString(), '2026-09-27T08:10:00.000Z');
  });

  it('keeps the news one by one when the digest fails its checks', async () => {
    const { store, created } = fakeStore([
      waiting(1, 2, '2026-09-27T01:00:00Z'),
      waiting(2, 2, '2026-09-27T02:00:00Z'),
    ]);
    const model = fakeModel('🐦‍⬛ • разом', '🐦‍⬛ • знову разом');
    await new MorningDigests(store, model.write, () => at('2026-09-27T06:47:00Z')).job().run({});
    assert.equal(created.length, 0);
    assert.equal(model.requests.length, 2);
  });
});
