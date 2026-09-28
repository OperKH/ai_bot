import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { COUNTDOWN_MARKS, type Countdown, countdownProblems, Countdowns, daysTo, markSlots, withReleaseLine } from './countdowns';
import type { CountdownRequest } from './prompts';
import type { EventChat } from './store';

const at = (iso: string) => new Date(iso);
const GTA: Countdown = {
  id: 'gta6',
  game: 'GTA VI',
  day: '2026-11-19',
  categories: ['gta6'],
  news: { categories: ['gta6'] },
  lineCategories: ['gta6'],
};

describe('the countdown days', () => {
  it('counts the calendar days to the release day in the chat’s zone, across the change to winter time', () => {
    assert.equal(daysTo('2026-11-19', at('2026-10-16T09:00:00Z'), 'Europe/Kyiv'), 34);
    assert.equal(daysTo('2026-11-19', at('2026-10-16T09:00:00Z'), 'UTC'), 34);
    assert.equal(daysTo('2026-11-19', at('2026-11-18T21:30:00Z'), 'Europe/Kyiv'), 1, 'half an hour before its midnight');
    assert.equal(daysTo('2026-11-19', at('2026-11-18T22:30:00Z'), 'Europe/Kyiv'), 0);
    assert.equal(daysTo('2026-11-19', at('2026-11-18T22:30:00Z'), 'America/New_York'), 1, 'still the 18th in New York');
    assert.equal(daysTo('2026-11-19', at('2026-10-26T09:00:00Z'), 'Europe/Kyiv'), 24, 'the day after winter time came');
  });

  it('speaks on the Fibonacci numbers, once a mark, and twice the day before the release', () => {
    assert.deepEqual(COUNTDOWN_MARKS, [55, 34, 21, 13, 8, 5, 3, 2, 1]);
    assert.deepEqual(markSlots(2).map((s) => s.slot), ['day']);
    assert.deepEqual(markSlots(2), [{ slot: 'day', hour: 11, minute: 11 }]);
    assert.deepEqual(markSlots(1), [
      { slot: 'morning', hour: 11, minute: 11 },
      { slot: 'evening', hour: 19, minute: 37 },
    ]);
  });
});

describe('withReleaseLine', () => {
  it('ends an arc post of a counted-down game with the days left in the chat’s zone, and leaves others as they are', () => {
    const content = { text: '🐦‍⬛ Rockstar показала мапу.' };
    const now = at('2026-09-27T12:00:00Z');
    assert.equal(withReleaseLine(content, ['gta6', 'playstation'], now, 'Europe/Kyiv').text, '🐦‍⬛ Rockstar показала мапу.\n⏳ До релізу — 53 дні');
    assert.equal(withReleaseLine(content, ['gta6'], at('2026-11-18T12:00:00Z'), 'Europe/Kyiv').text.endsWith('— 1 день'), true);
    assert.equal(withReleaseLine(content, ['playstation'], now, 'Europe/Kyiv'), content);
    assert.equal(withReleaseLine(content, ['gta6'], at('2026-11-19T12:00:00Z'), 'Europe/Kyiv'), content, 'out already');
  });
});

describe('countdownProblems', () => {
  it('wants the days left said before the release, and the arcs’ checks', () => {
    const allowed = allowedNumbers('34');
    assert.deepEqual(countdownProblems('🐦‍⬛🐦‍⬛ До GTA VI 34 дні.', 34, allowed), []);
    assert.deepEqual(countdownProblems('🐦‍⬛🐦‍⬛ Скоро.', 34, allowed), ['у тексті має бути, скільки днів лишилося: 34']);
    assert.deepEqual(countdownProblems('🐦‍⬛🐦‍⬛ Завтра!', 1, allowed), []);
  });
});

describe('Countdowns', () => {
  const chat = (chatId: string, patch: Partial<EventChat> = {}): EventChat => ({
    chatId,
    timeZone: 'Europe/Kyiv',
    quietFrom: 1380,
    quietTo: 600,
    ...patch,
  });

  function setup(chats: EventChat[], answers = ['🐦‍⬛🐦‍⬛ До GTA VI 34 дні, а Rockstar показала мапу.'], countdown: Countdown = GTA) {
    const planned: { chatId: string; text: string; notBefore: Date }[] = [];
    const requests: CountdownRequest[] = [];
    const store = {
      eventChats: async () => chats,
      recentStories: async () => [
        { id: 1, title: 'GTA VI map revealed', facts: [{ id: 'F1', text: 'Rockstar показала мапу' }] },
        { id: 2, title: 'Zelda remake dated', facts: [{ id: 'F1', text: 'Ремейк виходить 5 листопада' }] },
      ],
      planCountdown: async (chatId: string, countdown: { text: string; notBefore: Date }) => {
        planned.push({ chatId, text: countdown.text, notBefore: countdown.notBefore });
      },
    };
    const write = async (request: CountdownRequest) => {
      requests.push(request);
      return { result: { text: answers[Math.min(requests.length, answers.length) - 1] }, costUsd: 0.0003 };
    };
    const job = (now: string) => new Countdowns(store, write, [countdown], () => at(now)).job();
    return { job, planned, requests };
  }

  it('posts a mark once in each chat, in its day, with one text for every chat', async () => {
    const { job, planned, requests } = setup([chat('-1'), chat('-2', { timeZone: 'UTC' })]);
    // 16.10, 12:00 in Kyiv and 09:00 UTC: 34 days in both, past 11:11 only in Kyiv, and too early in UTC to plan
    const state = await job('2026-10-16T09:00:00Z').run({});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1']);
    assert.deepEqual(requests[0], {
      game: 'GTA VI',
      days: 34,
      slot: 'day',
      news: [
        { title: 'GTA VI map revealed', facts: [{ id: 'F1', text: 'Rockstar показала мапу' }] },
        { title: 'Zelda remake dated', facts: [{ id: 'F1', text: 'Ремейк виходить 5 листопада' }] },
      ],
      previous: [],
      maxLength: 400,
    });
    const next = await job('2026-10-16T12:00:00Z').run(state ?? {});
    await job('2026-10-16T13:00:00Z').run(next ?? {});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1', '-2'], 'each chat once');
    assert.equal(requests.length, 1, 'the text is written once a mark');
  });

  it('posts twice the day before the release, at 11:11 and at 19:37, planned ahead so each goes at its minute', async () => {
    const { job, planned, requests } = setup([chat('-1')], ['🐦‍⬛🐦‍⬛ Завтра!', '🐦‍⬛🐦‍⬛ Остання ніч.']);
    // 11:00 and 19:00 in Kyiv, winter time
    const morning = await job('2026-11-18T09:00:00Z').run({});
    const evening = await job('2026-11-18T17:00:00Z').run(morning ?? {});
    await job('2026-11-18T18:00:00Z').run(evening ?? {});
    assert.deepEqual(planned.map((p) => p.text), ['🐦‍⬛🐦‍⬛ Завтра!', '🐦‍⬛🐦‍⬛ Остання ніч.']);
    assert.deepEqual(planned.map((p) => p.notBefore), [at('2026-11-18T09:11:00Z'), at('2026-11-18T17:37:00Z')]);
    assert.deepEqual(requests.map((r) => r.slot), ['morning', 'evening']);
  });

  it('plans only the latest slot whose time came, and a late one for at once', async () => {
    const { job, planned, requests } = setup([chat('-1')], ['🐦‍⬛🐦‍⬛ Остання ніч.']);
    await job('2026-11-18T18:00:00Z').run({}); // 20:00 in Kyiv: the bot was down all day
    assert.deepEqual(requests.map((r) => r.slot), ['evening']);
    assert.deepEqual(planned.map((p) => p.notBefore), [at('2026-11-18T18:00:00Z')]);
  });

  it('takes the news of a game by its name where the category holds others, waits for the hour and the quiet hours', async () => {
    const zelda: Countdown = { id: 'zelda', game: 'Zelda: Ocarina of Time', day: '2026-11-05', categories: ['nintendo'], news: { categories: ['nintendo'], match: /zelda/i } };
    const named = setup([chat('-1')], ['🐦‍⬛🐦‍⬛ До Зельди 21 день.'], zelda);
    await named.job('2026-10-15T09:00:00Z').run({});
    assert.deepEqual(named.requests[0].news.map((n) => n.title), ['Zelda remake dated']);
    const early = setup([chat('-1')]);
    await early.job('2026-10-16T07:00:00Z').run({}); // 10:00 in Kyiv, more than an hour before 11:11
    assert.equal(early.planned.length, 0);
    const quiet = setup([chat('-1', { quietFrom: 600, quietTo: 1380 })]);
    await quiet.job('2026-10-16T09:00:00Z').run({});
    assert.equal(quiet.planned.length, 0);
  });

  it('leaves a mark without a post when its text fails after the rewrite, and does not try again', async () => {
    const failing = setup([chat('-1')], ['🐦‍⬛🐦‍⬛ Скоро.']);
    const state = await failing.job('2026-10-16T09:00:00Z').run({});
    await failing.job('2026-10-16T10:00:00Z').run(state ?? {});
    assert.equal(failing.requests.length, 2);
    assert.equal(failing.planned.length, 0);
  });
});
