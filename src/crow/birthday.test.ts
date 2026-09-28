import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { Birthdays, birthdayContent, birthdayDue, summarizeYear, writeBirthday, yearAwards, yearRows } from './birthday';
import type { BirthdayRequest } from './prompts';
import type { BirthdayChat, CrowYearData, YearStory } from './store';

const at = (iso: string) => new Date(iso);
const story = (patch: Partial<YearStory> = {}): YearStory => ({
  storyId: 1,
  title: 'Anthropic releases Claude Opus 5.5',
  hero: 'Claude Opus 5.5',
  vendor: 'anthropic',
  isRumor: false,
  confirmed: false,
  sentAt: at('2026-10-05T10:00:00Z'),
  replies: 0,
  tgMessageId: '700',
  ...patch,
});
const data = (patch: Partial<CrowYearData> = {}): CrowYearData => ({
  stories: [
    story({ storyId: 1, replies: 12 }),
    story({ storyId: 2, hero: 'GTA VI', title: 'GTA VI delayed', isRumor: true, confirmed: true, sentAt: at('2026-11-02T10:00:00Z'), tgMessageId: '800' }),
    story({ storyId: 3, hero: 'GTA VI', title: 'GTA VI trailer', sentAt: at('2026-11-20T10:00:00Z'), replies: 3 }),
    story({ storyId: 4, hero: 'GTA VI', title: 'GTA VI map', isRumor: true, sentAt: at('2026-11-25T10:00:00Z') }),
  ],
  kinds: { arc: 40, told: 3, quiz: 1 },
  crows: 97,
  talker: { userId: '11', count: 23 },
  shooer: { userId: '22', count: 7 },
  target: { userId: '33', name: 'Іра', username: 'ira', count: 5 },
  bets: { total: 4, crowWins: 3 },
  bettor: { userId: '44', name: 'Макс', wins: 3, bets: 4 },
  votes: [
    { storyId: 3, votes: 2 },
    { storyId: 2, votes: 5 },
  ],
  ...patch,
});

describe('birthdayDue', () => {
  const born = at('2026-10-05T07:30:00Z'); // 10:30 in Kyiv on the 5th of October

  it('comes on the day of her first post, a year on, at 12:34 of the chat’s zone, for three hours', () => {
    assert.equal(birthdayDue(at('2027-10-05T09:33:00Z'), 'Europe/Kyiv', born), null, '12:33 in Kyiv');
    assert.deepEqual(birthdayDue(at('2027-10-05T09:34:00Z'), 'Europe/Kyiv', born), { due: at('2027-10-05T09:34:00Z'), years: 1 });
    assert.equal(birthdayDue(at('2027-10-05T12:34:00Z'), 'Europe/Kyiv', born), null, 'three hours on');
    assert.equal(birthdayDue(at('2028-10-05T10:00:00Z'), 'Europe/Kyiv', born)?.years, 2);
  });

  it('is never on the day she came, nor on another day, and falls on the 28th for a cat born on the 29th of February', () => {
    assert.equal(birthdayDue(at('2026-10-05T09:00:00Z'), 'Europe/Kyiv', born), null);
    assert.equal(birthdayDue(at('2027-10-06T09:00:00Z'), 'Europe/Kyiv', born), null);
    const leap = at('2028-02-29T12:00:00Z');
    assert.equal(birthdayDue(at('2029-02-28T12:34:00Z'), 'UTC', leap)?.years, 1);
    assert.equal(birthdayDue(at('2032-02-29T12:34:00Z'), 'UTC', leap)?.years, 4);
  });
});

describe('the year', () => {
  it('counts her news, the hero, the busiest month in the chat’s zone, the rumors and the news of the year', () => {
    const year = summarizeYear(data(), 'Europe/Kyiv');
    assert.equal(year.stories, 4);
    assert.deepEqual(year.hero, { name: 'GTA VI', stories: 3 });
    assert.deepEqual(year.busiestMonth, { month: 11, stories: 3 });
    assert.deepEqual(year.rumors, { told: 2, confirmed: 1 });
    assert.deepEqual(year.newsOfTheYear, { name: 'Claude Opus 5.5', replies: 12, tgMessageId: '700' });
    assert.deepEqual(year.voted, { name: 'GTA VI', votes: 5 });
    assert.deepEqual(yearRows(year), [
      ['Новин', '4'],
      ['Прокаркано 🐦‍⬛', '97'],
      ['Мій герой', 'GTA VI — 3'],
      ['Найгарячіший місяць', 'листопад — 3'],
      ['Чуток / справдилося', '2 / 1'],
      ['«Я ж казала»', '3'],
      ['Ставок / я вгадала', '4 / 3'],
      ['Вікторин', '1'],
    ]);
  });

  it('has no hero of one story, and no news of the year nobody replied to', () => {
    const year = summarizeYear(data({ stories: [story(), story({ storyId: 2, hero: 'GTA VI' })], votes: [] }), 'UTC');
    assert.equal(year.hero, null);
    assert.equal(year.newsOfTheYear, null);
    assert.equal(year.voted, null);
  });
});

describe('the awards', () => {
  const names = new Map([
    ['11', { name: 'Олег', username: 'oleh' }],
    ['22', { name: 'Таня', username: null }],
  ]);

  it('gives each award its cat, pinged unless the crow is restrained; a cat gone from the chat gets none', () => {
    const awards = yearAwards(data(), names, 'bold');
    assert.deepEqual(
      awards.map((award) => award.line('кіт')),
      [
        '🗣 Найбалакучіший — кіт: 23 розмови зі мною.',
        '🔇 Головний по «Кш!» — кіт: 7 разів.',
        '🎯 Улюблена мішень — кіт: 5 підколок.',
        '🔮 Провидець року — кіт: 3 з 4 ставок.',
      ],
    );
    assert.deepEqual(awards[0].mention, { userId: '11', name: 'Олег', username: 'oleh', ping: true });
    assert.equal(yearAwards(data(), names, 'restrained')[2].mention.ping, false);
    assert.equal(yearAwards(data(), new Map(), 'bold').length, 2, 'the talker and the shooer have left');
  });

  it('puts her word, the awards with the cats, the news of the year as a link and the table of her year in the post', () => {
    const year = summarizeYear(data(), 'Europe/Kyiv');
    const awards = yearAwards(data(), names, 'bold');
    const { text, extras } = birthdayContent({ chatId: '-1001234567890', years: 1, year, awards, word: '🐦‍⬛🐦‍⬛ Рік, коти!' });
    assert.equal(extras.heading, '🎂 1 рік у цьому чаті');
    assert.deepEqual(text.split('\n'), [
      '🐦‍⬛🐦‍⬛ Рік, коти!',
      '🗣 Найбалакучіший — {cat:u1}: 23 розмови зі мною.',
      '🔇 Головний по «Кш!» — {cat:u2}: 7 разів.',
      '🎯 Улюблена мішень — {cat:u3}: 5 підколок.',
      '🔮 Провидець року — {cat:u4}: 3 з 4 ставок.',
      '📰 Новина року — {link:n1}: 12 відповідей котів.',
      '🗳 Рекорд тижневих голосувань — **GTA VI**: 5 голосів.',
    ]);
    assert.equal(extras.mentions?.u4.name, 'Макс');
    assert.deepEqual(extras.anchors?.n1, { label: 'Claude Opus 5.5', url: 'https://t.me/c/1234567890/700' });
    assert.deepEqual(extras.table?.header, ['Мій рік', '']);
  });

  it('names the news of the year without a link in a basic group, and has a plain word when hers failed', () => {
    const year = summarizeYear(data(), 'UTC');
    const { text } = birthdayContent({ chatId: '-123', years: 2, year, awards: [], word: null });
    assert.match(text, /^🐦‍⬛🐦‍⬛ 2 роки тому я вперше каркнула в цьому чаті\./);
    assert.match(text, /📰 Новина року — \*\*Claude Opus 5\.5\*\*: 12 відповідей котів\./);
  });
});

describe('writeBirthday', () => {
  const request: BirthdayRequest = { years: 1, year: ['Новин: 312'], awards: [], recentPosts: [], maxLength: 400 };

  it('rewrites once a word with a number of its own, and gives up on a second', async () => {
    const answers = ['🐦‍⬛🐦‍⬛ 500 новин, коти!', '🐦‍⬛🐦‍⬛ 312 новин, коти!'];
    const asked: BirthdayRequest[] = [];
    const write = async (sent: BirthdayRequest) => {
      asked.push(sent);
      return { result: { text: answers[asked.length - 1] }, costUsd: 0.0003 };
    };
    const written = await writeBirthday(write, request, allowedNumbers('1', 'Новин: 312'));
    assert.equal(written.text, '🐦‍⬛🐦‍⬛ 312 новин, коти!');
    assert.deepEqual(asked[1].corrections, ['числа 500 немає у фактах']);
    const stubborn = await writeBirthday(async () => ({ result: { text: '🐦‍⬛🐦‍⬛ 500!' }, costUsd: 0 }), request, allowedNumbers('312'));
    assert.equal(stubborn.text, null);
  });
});

describe('Birthdays', () => {
  const chat: BirthdayChat = { chatId: '-100123', timeZone: 'Europe/Kyiv', boldness: 'bold', firstPostAt: at('2026-10-05T07:30:00Z') };

  function setup(year: CrowYearData, planned = false) {
    const plans: { chatId: string; text: string }[] = [];
    const store = {
      birthdayChats: async () => [chat],
      plannedSince: async () => planned,
      crowYear: async () => year,
      recentPosts: async () => [],
      planBirthday: async (chatId: string, post: { text: string }) => {
        plans.push({ chatId, text: post.text });
      },
    };
    const write = async () => ({ result: { text: '🐦‍⬛🐦‍⬛ Рік, коти!' }, costUsd: 0.0003 });
    const job = (now: string) =>
      new Birthdays(store, write, async () => new Map([['11', { name: 'Олег', username: null }]]), () => at(now)).job();
    return { job, plans };
  }

  it('plans the birthday once, on its day, and skips a year without news or one planned already', async () => {
    const { job, plans } = setup(data());
    const state = await job('2027-10-05T09:35:00Z').run({});
    await job('2027-10-05T09:40:00Z').run(state ?? {});
    assert.equal(plans.length, 1);
    assert.match(plans[0].text, /Найбалакучіший — \{cat:u1\}/);
    const empty = setup(data({ stories: [] }));
    await empty.job('2027-10-05T09:35:00Z').run({});
    assert.equal(empty.plans.length, 0);
    const again = setup(data(), true);
    await again.job('2027-10-05T09:35:00Z').run({});
    assert.equal(again.plans.length, 0);
  });
});
