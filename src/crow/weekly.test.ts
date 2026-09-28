import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CrowPostExtras } from '../entity/CrowPost.entity';
import { allowedNumbers } from './arcValidation';
import type { WeeklyRequest, WeeklyResult } from './prompts';
import type { SmartestCat, WeekStory } from './store';
import {
  smartestLine,
  topStories,
  voteLine,
  voteOptions,
  weeklyContent,
  WeeklyDigests,
  weeklyDue,
  weeklyProblems,
  writeWeekly,
} from './weekly';

const at = (iso: string) => new Date(iso);
/** Friday 2.10.2026, 18:05 in Kyiv */
const FRIDAY = at('2026-10-02T15:05:00Z');

const story = (patch: Partial<WeekStory>): WeekStory => ({
  storyId: 1,
  title: 'Anthropic Introduces Claude Opus 5.5',
  hero: 'Claude Opus 5.5',
  vendor: 'anthropic',
  categories: ['ai-enterprise'],
  importance: 3,
  facts: [{ id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' }],
  stance: { subject: 'Claude Opus 5.5', verdict: 'найкраща модель' },
  sentAt: at('2026-09-29T09:00:00Z'),
  tgMessageId: 1366,
  replies: 0,
  ...patch,
});

describe('weeklyDue', () => {
  it('is Friday 18:00 in the chat’s zone, for three hours', () => {
    assert.deepEqual(weeklyDue(FRIDAY, 'Europe/Kyiv'), at('2026-10-02T15:00:00Z'));
    assert.deepEqual(weeklyDue(at('2026-10-02T17:59:00Z'), 'Europe/Kyiv'), at('2026-10-02T15:00:00Z'));
    assert.equal(weeklyDue(at('2026-10-02T18:00:00Z'), 'Europe/Kyiv'), null, 'at 21:00 the week goes without');
    assert.equal(weeklyDue(at('2026-10-02T14:59:00Z'), 'Europe/Kyiv'), null, 'before 18:00');
    assert.equal(weeklyDue(at('2026-10-01T15:05:00Z'), 'Europe/Kyiv'), null, 'on Thursday');
    assert.deepEqual(weeklyDue(at('2026-10-02T18:30:00Z'), 'UTC'), at('2026-10-02T18:00:00Z'), 'a chat without a zone');
  });

  it('keeps 18:00 local after the change to winter time', () => {
    // 30.10.2026, the Friday after Europe moved its clocks back
    assert.deepEqual(weeklyDue(at('2026-10-30T16:10:00Z'), 'Europe/Kyiv'), at('2026-10-30T16:00:00Z'));
  });
});

describe('topStories', () => {
  it('ranks the week by importance and by how much the cats talked back, five at most', () => {
    const stories = [
      story({ storyId: 1, importance: 2, replies: 0 }),
      story({ storyId: 2, importance: 3, replies: 0 }),
      story({ storyId: 3, importance: 2, replies: 4 }),
      story({ storyId: 4, importance: 1, replies: 40, sentAt: at('2026-09-28T09:00:00Z') }),
      story({ storyId: 5, importance: 1, replies: 0 }),
      story({ storyId: 6, importance: 1, replies: 1 }),
    ];
    assert.deepEqual(
      topStories(stories).map((s) => s.storyId),
      [4, 3, 2, 1, 6],
      'ten replies count at most: 1 + 5 is 6',
    );
  });
});

describe('weeklyProblems', () => {
  const stories = [story({}), story({ storyId: 2, hero: null, title: 'Gemini 3.8 Live', vendor: 'google' })];
  const allowed = allowedNumbers('Opus 5.5 на 20% дешевший за Opus 5');
  const result = (patch: Partial<WeeklyResult>): WeeklyResult => ({
    intro: '🐦‍⬛🐦‍⬛ Тиждень був гарячий.',
    winner: 'Claude Opus 5.5',
    verdict: 'бо на 20% дешевший.',
    ...patch,
  });

  it('takes a winner of the week by its name, a part of it, or its vendor', () => {
    assert.deepEqual(weeklyProblems(result({}), stories, allowed), []);
    assert.deepEqual(weeklyProblems(result({ winner: 'Opus 5.5' }), stories, allowed), []);
    assert.deepEqual(weeklyProblems(result({ winner: 'Google' }), stories, allowed), []);
    assert.deepEqual(weeklyProblems(result({ winner: 'Grok' }), stories, allowed), ['переможця «Grok» немає серед новин тижня']);
  });

  it('checks the word and the verdict as an arc message', () => {
    assert.deepEqual(weeklyProblems(result({ intro: '🐦‍⬛🐦‍⬛ О 18:00 тиждень скінчився.', verdict: 'бо на 40%.' }), stories, allowed), [
      'intro: час доби цифрами заборонений',
      'intro: числа 18 немає у фактах',
      'verdict: числа 40 немає у фактах',
    ]);
  });
});

describe('writeWeekly', () => {
  it('puts the crows in front of the word, takes them off the verdict, and rewrites once', async () => {
    const answers: WeeklyResult[] = [
      { intro: 'Тиждень.', winner: 'Grok', verdict: 'так.' },
      { intro: 'Тиждень.', winner: '**Claude Opus 5.5**', verdict: '🐦‍⬛ бо так.' },
    ];
    const requests: WeeklyRequest[] = [];
    const written = await writeWeekly(
      async (request) => {
        requests.push(request);
        return { result: answers[requests.length - 1], costUsd: 0.0005 };
      },
      { stories: [], lastVote: null, recentPosts: [] },
      [story({})],
      allowedNumbers(),
    );
    assert.deepEqual(written.result, { intro: '🐦‍⬛ Тиждень.', winner: 'Claude Opus 5.5', verdict: 'бо так.' });
    assert.deepEqual(requests[1].corrections, ['переможця «Grok» немає серед новин тижня']);
  });
});

describe('the lines of the digest', () => {
  it('tells how the last vote went, and when nobody voted', () => {
    assert.equal(
      voteLine({ options: ['Claude Opus 5.5', 'Gemini 3.8'], counts: [1, 4] }),
      '🗳 Минулого разу ви обрали: **Gemini 3.8** — 4 голоси.',
    );
    assert.match(voteLine({ options: ['a', 'b'], counts: [0, 0] }), /ніхто не проголосував/);
  });

  it('names the smartest cat of the month', () => {
    const cat: SmartestCat = { userId: '42', name: 'Олег', wins: 3, bets: 4 };
    assert.equal(smartestLine(cat), '🧠 Найрозумніший кіт місяця — Олег: 3 з 4 ставок.');
    assert.equal(smartestLine({ ...cat, wins: 1, bets: 1 }), '🧠 Найрозумніший кіт місяця — Олег: 1 з 1 ставки.');
  });

  it('gives the vote an option per story, the day added where two share a name', () => {
    assert.deepEqual(
      voteOptions([
        { name: 'Claude Opus 5.5', day: 'у вівторок' },
        { name: 'Claude Opus 5.5', day: 'сьогодні' },
        { name: 'Gemini 3.8', day: 'учора' },
      ]),
      ['Claude Opus 5.5 (у вівторок)', 'Claude Opus 5.5 (сьогодні)', 'Gemini 3.8'],
    );
  });

  it('numbers the stories of one name and one day, and keeps the day of a name cut to fit', () => {
    assert.deepEqual(
      voteOptions([
        { name: 'GTA VI', day: 'у неділю' },
        { name: 'GTA VI', day: 'у неділю' },
        { name: 'GTA VI', day: 'у понеділок' },
      ]),
      ['GTA VI (у неділю, 1)', 'GTA VI (у неділю, 2)', 'GTA VI (у понеділок)'],
    );
    const long = 'Д'.repeat(120);
    const [first] = voteOptions([
      { name: long, day: 'учора' },
      { name: long, day: 'сьогодні' },
    ]);
    assert.equal(first.length, 100);
    assert.ok(first.endsWith(' (учора)'));
  });
});

describe('weeklyContent', () => {
  const shown = [
    { story: story({ replies: 3 }), name: 'Claude Opus 5.5', day: 'у вівторок' },
    { story: story({ storyId: 2, hero: 'Qwen3.9', categories: ['ai-homebrew'], tgMessageId: null }), name: 'Qwen3.9', day: 'учора' },
  ];
  const written = { intro: '🐦‍⬛🐦‍⬛ Тиждень.', winner: 'Claude Opus 5.5', verdict: 'бо дешевший.' };

  it('lays out the word, the winner, the last vote and the table of the news, each a link to her post', () => {
    const { text, extras } = weeklyContent({
      chatId: '-1001906889754',
      shown,
      written,
      vote: { options: ['Gemini 3.8'], counts: [2] },
      smartest: null,
    });
    assert.equal(
      text,
      '🐦‍⬛🐦‍⬛ Тиждень.\n🏆 Переможець тижня — **Claude Opus 5.5**: бо дешевший.\n🗳 Минулого разу ви обрали: **Gemini 3.8** — 2 голоси.',
    );
    assert.equal(extras.heading, '🗞 Воронячий дайджест тижня');
    assert.deepEqual(extras.table, {
      header: ['Блискучка', 'Коли', '💬'],
      rows: [
        ['{link:s1}', 'у вівторок', '3'],
        ['🦙 Qwen3.9', 'учора', '0'],
      ],
    });
    assert.deepEqual(extras.anchors, { s1: { label: '🤖 Claude Opus 5.5', url: 'https://t.me/c/1906889754/1366' } });
    assert.deepEqual(extras.poll, {
      question: '🐦‍⬛ Яка новина тижня найблискучіша?',
      options: ['Claude Opus 5.5', 'Qwen3.9'],
      storyIds: [1, 2],
    });
  });

  it('goes with a plain word when the model failed, and without a vote for a single story', () => {
    const { text, extras } = weeklyContent({ chatId: '-4001', shown: shown.slice(0, 1), written: null, vote: null, smartest: null });
    assert.match(text, /^🐦‍⬛🐦‍⬛ П'ятниця, коти/);
    assert.equal(extras.poll, undefined);
    assert.deepEqual(extras.table?.rows, [['🤖 Claude Opus 5.5', 'у вівторок', '3']], 'no link in a basic group');
  });
});

describe('WeeklyDigests', () => {
  function fakeStore(options: { week?: WeekStory[]; planned?: boolean; vote?: { id: number; tgMessageId: number; options: string[] } | null }) {
    const plans: { chatId: string; text: string; extras: CrowPostExtras; expiresAt: Date }[] = [];
    const closed: { id: number; counts: number[] | null }[] = [];
    const store = {
      crowChats: async () => [{ chatId: '-1001906889754', timeZone: 'Europe/Kyiv' }],
      plannedSince: async () => options.planned ?? false,
      weekStories: async () => options.week ?? [story({})],
      openVote: async () => options.vote ?? null,
      closeVote: async (id: number, counts: number[] | null) => {
        closed.push({ id, counts });
      },
      smartestCat: async () => null,
      recentPosts: async () => [],
      planWeekly: async (chatId: string, weekly: { text: string; extras: CrowPostExtras; expiresAt: Date }) => {
        plans.push({ chatId, ...weekly });
      },
    };
    return { store, plans, closed };
  }

  const model = (result: WeeklyResult) => async () => ({ result, costUsd: 0.0005 });
  const written: WeeklyResult = { intro: '🐦‍⬛🐦‍⬛ Тиждень.', winner: 'Claude Opus 5.5', verdict: 'бо дешевший.' };

  it('plans the digest on Friday evening once, stopping the last vote to tell its result', async () => {
    const { store, plans, closed } = fakeStore({ vote: { id: 7, tgMessageId: 900, options: ['Gemini 3.8', 'Qwen3.9'] } });
    const stopped: number[] = [];
    const weekly = new WeeklyDigests(store, model(written), {
      stop: async (_chatId, messageId) => {
        stopped.push(messageId);
        return [3, 1];
      },
    }, () => FRIDAY);
    const job = weekly.job();
    const state = await job.run({});
    await job.run(state ?? {});
    assert.equal(plans.length, 1, 'one try a week');
    assert.deepEqual(stopped, [900]);
    assert.deepEqual(closed, [{ id: 7, counts: [3, 1] }]);
    assert.match(plans[0].text, /Минулого разу ви обрали: \*\*Gemini 3\.8\*\* — 3 голоси/);
    assert.deepEqual(plans[0].expiresAt, at('2026-10-02T21:00:00Z'));
  });

  it('has no digest for a week without news, or when one is planned already', async () => {
    const quiet = fakeStore({ week: [] });
    await new WeeklyDigests(quiet.store, model(written), { stop: async () => null }, () => FRIDAY).job().run({});
    assert.equal(quiet.plans.length, 0);
    const done = fakeStore({ planned: true });
    await new WeeklyDigests(done.store, model(written), { stop: async () => null }, () => FRIDAY).job().run({});
    assert.equal(done.plans.length, 0);
  });

  it('does nothing outside Friday evening', async () => {
    const { store, plans } = fakeStore({});
    await new WeeklyDigests(store, model(written), { stop: async () => null }, () => at('2026-10-01T15:05:00Z')).job().run({});
    assert.equal(plans.length, 0);
  });
});
