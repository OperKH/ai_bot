import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowBet } from '../entity/CrowStory.entity';
import { allowedNumbers } from './arcValidation';
import {
  BetKeeper,
  betPoll,
  betProblems,
  betTimes,
  namesDay,
  outcomeProblems,
  outcomeTable,
  streak,
  streakLines,
  withBet,
  writeBet,
} from './bets';
import type { PlannedPost } from './planning';
import type { BetOutcomeRequest, BetRequest, BetResult, ResolveBetResult } from './prompts';
import type { BetStreaks, BetVote, DueBet } from './store';

const at = (iso: string) => new Date(iso);
const TODAY = Temporal.PlainDate.from('2026-09-27');
const facts = [
  { id: 'F1', text: 'Rockstar підтвердила, що GTA VI вийде 19 листопада 2026 року на PS5 та Xbox.' },
  { id: 'F2', text: 'Ціна стандартного видання — $79.99.' },
  { id: 'F3', text: 'Google обіцяє Gemini 4 до кінця грудня.' },
];
const proposed = (patch: Partial<NonNullable<BetResult['bet']>> = {}) => ({
  question: '🐦‍⬛ Чи вийде GTA VI 19 листопада, як обіцяють?',
  options: ['Так, Rockstar не підведе', 'Перенесуть, як завжди'],
  crowPick: 0,
  resolvesOn: '2026-11-19',
  factId: 'F1',
  ...patch,
});

describe('namesDay', () => {
  it('finds the day of a bet in its fact, or the month of a deadline at its end', () => {
    assert.ok(namesDay(facts[0].text, Temporal.PlainDate.from('2026-11-19')));
    assert.ok(namesDay(facts[2].text, Temporal.PlainDate.from('2026-12-31')));
    assert.equal(namesDay(facts[0].text, Temporal.PlainDate.from('2026-11-20')), false);
    assert.equal(namesDay(facts[2].text, Temporal.PlainDate.from('2026-12-15')), false, 'mid-month is not «до кінця»');
  });
});

describe('betProblems', () => {
  const allowed = allowedNumbers(...facts.map((f) => f.text));

  it('takes a bet whose day is ahead and named by its fact', () => {
    assert.deepEqual(betProblems(proposed(), facts, TODAY, allowed), []);
  });

  it('refuses a day too near or too far, a day its fact does not name, and a made-up fact', () => {
    assert.deepEqual(betProblems(proposed({ resolvesOn: '2026-09-28' }), facts, TODAY, allowed), [
      'день події має бути через 2–92 днів від сьогодні, а не через 1',
      'у факті F1 немає дня 28 вересня',
    ]);
    assert.match(betProblems(proposed({ resolvesOn: '2027-03-01' }), facts, TODAY, allowed)[0], /а не через 155/);
    assert.deepEqual(betProblems(proposed({ factId: 'F9' }), facts, TODAY, allowed), ['факту F9 немає']);
    assert.deepEqual(betProblems(proposed({ resolvesOn: 'листопад' }), facts, TODAY, allowed), [
      'resolvesOn «листопад» — не дата YYYY-MM-DD',
    ]);
  });

  it('wants two to four different options, a pick among them, and texts checked as an arc message', () => {
    assert.deepEqual(betProblems(proposed({ options: ['Так'], crowPick: 1 }), facts, TODAY, allowed), [
      'варіантів має бути від 2 до 4',
      'crowPick має бути номером одного з варіантів',
    ]);
    assert.deepEqual(betProblems(proposed({ options: ['Так', 'Так'] }), facts, TODAY, allowed), ['варіанти повторюються']);
    assert.deepEqual(betProblems(proposed({ question: '🐦‍⬛ Вийде о 18:00?' }), facts, TODAY, allowed), [
      'question: час доби цифрами заборонений',
      'question: числа 18 немає у фактах',
    ]);
  });
});

describe('writeBet', () => {
  const request: BetRequest = { title: 'GTA VI', facts, today: '27 вересня 2026', minDays: 2, maxDays: 92 };
  const model = (...answers: BetResult[]) => {
    const requests: BetRequest[] = [];
    return {
      requests,
      write: async (r: BetRequest) => {
        requests.push(r);
        return { result: answers[Math.min(requests.length, answers.length) - 1], costUsd: 0.0004 };
      },
    };
  };

  it('keeps a story without a dated event betless, without a rewrite', async () => {
    const none = model({ bet: null });
    assert.equal((await writeBet(none.write, request, facts, TODAY)).bet, null);
    assert.equal(none.requests.length, 1);
  });

  it('rewrites a failing bet once, with a crow in front of the question', async () => {
    const fixed = model({ bet: proposed({ resolvesOn: '2026-11-20' }) }, { bet: proposed({ question: 'Чи вийде GTA VI вчасно?' }) });
    const written = await writeBet(fixed.write, request, facts, TODAY);
    assert.equal(written.bet?.question, '🐦‍⬛ Чи вийде GTA VI вчасно?');
    assert.deepEqual(fixed.requests[1].corrections, ['у факті F1 немає дня 20 листопада']);
    const stubborn = model({ bet: proposed({ factId: 'F9' }) });
    assert.equal((await writeBet(stubborn.write, request, facts, TODAY)).bet, null);
  });
});

describe('betTimes and betPoll', () => {
  const bet: CrowBet = proposed();

  it('closes the betting when the day begins in the chat, and looks for the outcome at noon the day after', () => {
    assert.deepEqual(betTimes('2026-11-19', 'Europe/Kyiv'), {
      closesAt: at('2026-11-18T22:00:00Z'),
      resolvesAt: at('2026-11-20T10:00:00Z'),
    });
  });

  it('lets Telegram close a poll within its 30 days, and says till when and what the crow bets on', () => {
    const { closesAt } = betTimes('2026-11-19', 'Europe/Kyiv');
    const soon = betPoll(bet, closesAt, at('2026-11-01T12:00:00Z'));
    assert.deepEqual(soon.closeDate, closesAt);
    assert.equal(soon.anonymous, false);
    assert.equal(soon.description, '🐦‍⬛ Ставки — до 18 листопада включно. Я ставлю на «Так, Rockstar не підведе».');
    assert.equal(betPoll(bet, closesAt, at('2026-09-27T12:00:00Z')).closeDate, null, 'the crow closes it herself');
  });
});

describe('withBet', () => {
  const post = (seq: number): PlannedPost => ({
    kind: 'arc',
    storyMessageId: seq,
    text: null,
    mention: null,
    seq,
    optional: false,
    importance: 2,
    gapMs: 0,
    notBefore: seq === 1 ? at('2026-09-27T10:00:00Z') : null,
    expiresAt: null,
  });

  it('puts the bet after the news and its burst, numbering the chain again', () => {
    const chain = withBet([1, 2, 3, 4, 5].map(post), proposed(), () => 0.5);
    assert.deepEqual(
      chain.map((p) => [p.kind, p.seq]),
      [
        ['arc', 1],
        ['arc', 2],
        ['arc', 3],
        ['bet', 4],
        ['arc', 5],
        ['arc', 6],
      ],
    );
    assert.equal(chain[3].text, proposed().question);
    assert.equal(chain[3].gapMs, 30 * 60_000);
    assert.deepEqual(withBet([post(1)], proposed(), () => 0).map((p) => p.kind), ['arc', 'bet'], 'after a lone opening');
  });
});

const votes: BetVote[] = [
  { userId: '1', name: 'Олег', username: 'oleg', optionIds: [1] },
  { userId: '2', name: 'Іра', username: null, optionIds: [0] },
];

describe('streaks', () => {
  it('counts the guessed bets in a row up to the latest, or those a miss broke', () => {
    assert.deepEqual(streak([true, true, true, false, true]), { current: 3, broken: 0 });
    assert.deepEqual(streak([false, true, true, true, true, true, false]), { current: 0, broken: 5 });
    assert.deepEqual(streak([false, false]), { current: 0, broken: 0 });
    assert.deepEqual(streak([]), { current: 0, broken: 0 });
  });

  it('tells a streak from three and a broken one from five, the cats as in the table and her own', () => {
    const streaks: BetStreaks = {
      crow: [false, true, true, true, true, true],
      cats: new Map([
        ['1', [true, true, true]],
        ['2', [false, true, true, true, true]],
      ]),
    };
    const { mentions } = outcomeTable(['Так', 'Ні'], 0, votes, 'bold');
    const told = streakLines(streaks, votes, mentions, 'bold');
    const key = (userId: string) => Object.keys(mentions).find((id) => mentions[id].userId === userId);
    assert.deepEqual(told.lines, [
      `🔥 {cat:${key('1')}}: 3 ставки поспіль у яблучко.`,
      '💔 А моя серія з 5 вгаданих обірвалася.',
    ]);
    assert.deepEqual(told.mentions, mentions, 'the cat of the table');
    const broken = streakLines({ crow: [true, true, true], cats: new Map([['2', [false, true, true, true, true, true]]]) }, votes, {}, 'restrained');
    assert.deepEqual(broken.lines, ['💔 {cat:s1}: серія з 5 вгаданих обірвалася.', '🔥 А я вгадала 3 поспіль.']);
    assert.deepEqual(broken.mentions.s1, { userId: '2', name: 'Іра', username: null, ping: false });
  });
});

describe('outcomeTable', () => {
  it('shows who bet on what, the winners first, named as the crow’s boldness names cats', () => {
    const { table, mentions } = outcomeTable(['Так', 'Ні'], 0, votes, 'bold');
    assert.deepEqual(table, {
      header: ['Кіт', 'Ставка', ''],
      rows: [
        ['{cat:u1}', 'Так', '✅'],
        ['{cat:u2}', 'Ні', '❌'],
      ],
    });
    assert.deepEqual(mentions.u1, { userId: '2', name: 'Іра', username: null, ping: true });
    assert.equal(outcomeTable(['Так', 'Ні'], 0, votes, 'restrained').mentions.u1.ping, false);
  });

  it('checks the word on it as an arc message, the moment of the bet once', () => {
    assert.deepEqual(outcomeProblems('🐦‍⬛🐦‍⬛ Я ж казала ще {when:bet}!', allowedNumbers()), []);
    assert.deepEqual(outcomeProblems('🐦‍⬛ {when:bet} і {when:bet}', allowedNumbers()), ['`{when:bet}` — не більше одного разу']);
  });
});

describe('BetKeeper', () => {
  const NOW = at('2026-11-20T10:05:00Z');
  const due = (patch: Partial<DueBet> = {}): DueBet => ({
    id: 5,
    chatId: '-1001906889754',
    storyId: 9,
    tgMessageId: 1500,
    question: proposed().question,
    options: proposed().options,
    crowPick: 0,
    status: 'closed',
    createdAt: at('2026-09-27T12:00:00Z'),
    closesAt: at('2026-11-18T22:00:00Z'),
    resolvesAt: at('2026-11-20T10:00:00Z'),
    resolvesOn: '2026-11-19',
    eventFact: facts[0].text,
    ...patch,
  });

  function fakeStore(bets: DueBet[], streaks: BetStreaks = { crow: [], cats: new Map() }) {
    const settled: { id: number; status: string; outcome: number | null }[] = [];
    const outcomes: { chatId: string; text: string; extras: CrowPostExtras; replyToMessageId: string }[] = [];
    const asked: number[] = [];
    const store = {
      dueBets: async () => bets,
      betById: async (id: number) => bets.find((bet) => bet.id === id) ?? null,
      betEvidence: async () => [{ title: 'GTA VI is out', facts: [{ id: 'F1', text: 'GTA VI вийшла 19 листопада' }] }],
      betVotes: async () => votes,
      betStreaks: async () => streaks,
      optedOut: async () => new Set<string>(),
      chat: async () => ({ boldness: 'bold' }) as never,
      settleBet: async (id: number, status: string, outcome: number | null) => {
        settled.push({ id, status, outcome });
      },
      planOutcome: async (chatId: string, outcome: { text: string; extras: CrowPostExtras; replyToMessageId: string }) => {
        outcomes.push({ chatId, ...outcome });
      },
      askedBet: async (id: number) => {
        asked.push(id);
      },
    };
    return { store, settled, outcomes, asked };
  }

  const writers = (resolved: ResolveBetResult, text = '🐦‍⬛🐦‍⬛ Я ж казала ще {when:bet}! Іра вгадала.') => {
    const outcomeRequests: BetOutcomeRequest[] = [];
    return {
      outcomeRequests,
      writers: {
        resolve: async () => ({ result: resolved, costUsd: 0.0003 }),
        outcome: async (request: BetOutcomeRequest) => {
          outcomeRequests.push(request);
          return { result: { text }, costUsd: 0.0004 };
        },
      },
    };
  };
  const polls = (askOwner = false) => {
    const stopped: number[] = [];
    return { stopped, polls: { stop: async (_c: string, id: number) => stopped.push(id), askOwner: async () => askOwner } };
  };

  it('tells a sure outcome as a reply to the poll, with who bet on what', async () => {
    const { store, settled, outcomes } = fakeStore([due()]);
    const { writers: w, outcomeRequests } = writers({ outcome: 0, cancelled: false, sure: true, reason: 'GTA VI вийшла вчасно.' });
    await new BetKeeper(store, w, polls().polls, () => NOW).job().run({});
    assert.deepEqual(settled, [{ id: 5, status: 'resolved', outcome: 0 }]);
    assert.deepEqual(outcomeRequests[0].winners, ['Іра']);
    assert.equal(outcomeRequests[0].crowWon, true);
    assert.equal(outcomes[0].replyToMessageId, '1500');
    assert.equal(outcomes[0].text, '🐦‍⬛🐦‍⬛ Я ж казала ще {when:bet}! Іра вгадала.');
    assert.equal(outcomes[0].extras.moments?.bet.unixTime, Math.floor(at('2026-09-27T12:00:00Z').getTime() / 1000));
    assert.equal(outcomes[0].extras.table?.rows.length, 2);
  });

  it('adds the streaks under the outcome, of the bet just settled too', async () => {
    const { store, outcomes } = fakeStore([due()], { crow: [true, true, true], cats: new Map([['2', [true, true, true, true]]]) });
    await new BetKeeper(store, writers({ outcome: 0, cancelled: false, sure: true, reason: 'GTA VI вийшла вчасно.' }).writers, polls().polls, () => NOW)
      .job()
      .run({});
    const lines = outcomes[0].text.split('\n');
    assert.equal(lines[0], '🐦‍⬛🐦‍⬛ Я ж казала ще {when:bet}! Іра вгадала.');
    assert.match(lines[1], /^🔥 \{cat:u\d\}: 4 ставки поспіль у яблучко\.$/);
    assert.equal(lines[2], '🔥 А я вгадала 3 поспіль.');
  });

  it('closes an open poll when its day begins, and waits for the day after to look for the outcome', async () => {
    const { store, settled, outcomes } = fakeStore([due({ status: 'open', resolvesAt: at('2026-11-21T10:00:00Z') })]);
    const { stopped, polls: p } = polls();
    await new BetKeeper(store, writers({ outcome: 0, cancelled: false, sure: true, reason: '' }).writers, p, () => NOW).job().run({});
    assert.deepEqual(stopped, [1500]);
    assert.deepEqual(settled, [{ id: 5, status: 'closed', outcome: null }]);
    assert.equal(outcomes.length, 0);
  });

  it('asks the owner about an unclear outcome, and calls the bet off in a word of her own when nobody can say', async () => {
    const unsure: ResolveBetResult = { outcome: null, cancelled: false, sure: false, reason: 'Новин про реліз немає.' };
    const asking = fakeStore([due()]);
    await new BetKeeper(asking.store, writers(unsure).writers, polls(true).polls, () => NOW).job().run({});
    assert.deepEqual(asking.asked, [5]);
    assert.equal(asking.outcomes.length, 0);

    const alone = fakeStore([due()]);
    await new BetKeeper(alone.store, writers(unsure).writers, polls(false).polls, () => NOW).job().run({});
    assert.deepEqual(alone.settled, [{ id: 5, status: 'void', outcome: null }]);
    assert.match(alone.outcomes[0].text, /навіть сорока не знає/);
    assert.equal(alone.outcomes[0].extras.table, undefined);
  });

  it('settles as the owner says, once, and calls off a bet the owner kept quiet about', async () => {
    const { store, settled, outcomes } = fakeStore([due({ status: 'asking' })]);
    const keeper = new BetKeeper(store, writers({ outcome: null, cancelled: false, sure: false, reason: '' }).writers, polls().polls, () => NOW);
    assert.equal(await keeper.settleByOwner(5, 1), true);
    assert.deepEqual(settled[0], { id: 5, status: 'resolved', outcome: 1 });
    assert.equal(await keeper.settleByOwner(5, 7), false, 'no such option');
    assert.equal(outcomes.length, 1);

    const quiet = fakeStore([due({ status: 'asking' })]);
    await new BetKeeper(quiet.store, writers({ outcome: null, cancelled: false, sure: false, reason: '' }).writers, polls().polls, () => NOW)
      .job()
      .run({});
    assert.deepEqual(quiet.settled, [{ id: 5, status: 'void', outcome: null }]);
  });

  it('calls off a cancelled event with a jab at the culprit, and no table', async () => {
    const { store, outcomes } = fakeStore([due()]);
    const { writers: w, outcomeRequests } = writers(
      { outcome: null, cancelled: true, sure: true, reason: 'Rockstar перенесла реліз на 2027 рік.' },
      '🐦‍⬛🐦‍⬛ Rockstar, ну ти й зрадниця.',
    );
    await new BetKeeper(store, w, polls().polls, () => NOW).job().run({});
    assert.equal(outcomeRequests[0].outcome, null);
    assert.equal(outcomes[0].extras.table, undefined);
  });
});
