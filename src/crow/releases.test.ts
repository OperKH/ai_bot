import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RadarRequest } from './prompts';
import { nintendoMaterials, type Platform, radarContent, radarMonday, radarRows, ReleaseRadar, withRoundupPlatforms, writeRadarIntro } from './releases';
import { type NintendoRelease, parseNintendoReleases } from './sources/nintendoStore';
import type { EventChat } from './store';

const monday = Temporal.PlainDate.from('2026-09-28');

describe('radarMonday', () => {
  it('is the chat’s Monday from eleven of its zone', () => {
    assert.equal(radarMonday(new Date('2026-09-28T08:00:00Z'), 'Europe/Kyiv')?.toString(), '2026-09-28', '11:00 in Kyiv');
    assert.equal(radarMonday(new Date('2026-09-28T07:59:00Z'), 'Europe/Kyiv'), null);
    assert.equal(radarMonday(new Date('2026-09-27T12:00:00Z'), 'Europe/Kyiv'), null, 'Sunday');
    assert.equal(radarMonday(new Date('2026-09-28T22:30:00Z'), 'Europe/Kyiv'), null, 'Tuesday already in Kyiv');
  });
});

describe('radarRows', () => {
  it('keeps the releases of the week once each, the biggest when too many, in the order of their days', () => {
    const rows = radarRows(
      [
        { game: 'The Witcher 3: Wild Hunt Remastered', platforms: ['PS5', 'Xbox Series X|S', 'PC'], date: '2026-09-29', sources: [] },
        { game: 'Ace Combat 8: Wings of Theve', platforms: ['PS5', 'Xbox Series X|S', 'PC'], date: '2026-10-02', sources: [] },
        { game: 'Minecraft Dungeons II', platforms: ['Xbox Series X|S', 'PC', 'PS5', 'Switch 2'], date: '2026-09-28', sources: [] },
        { game: 'ace combat 8: wings of theve', platforms: ['PS5'], date: '2026-10-02', sources: [] },
        { game: 'Gears of War: E-Day', platforms: ['Xbox Series X|S', 'PC'], date: '2026-10-06', sources: [] },
        { game: 'Toem 2', platforms: ['PS5', 'Switch 2'], date: 'TBA', sources: [] },
      ],
      monday,
    );
    assert.deepEqual(
      rows.map((row) => [row.game, row.platforms, row.day]),
      [
        ['Minecraft Dungeons II', 'PS5, Xbox Series X|S, Switch 2, PC', 'пн, 28 вересня'],
        ['The Witcher 3: Wild Hunt Remastered', 'PS5, Xbox Series X|S, PC', 'вт, 29 вересня'],
        ['Ace Combat 8: Wings of Theve', 'PS5, Xbox Series X|S, PC', 'пт, 2 жовтня'],
      ],
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ game: `Game ${i}`, platforms: ['PC' as const], date: '2026-10-01', sources: [] }));
    assert.equal(radarRows(many, monday).length, 8);
  });
});

describe('withRoundupPlatforms', () => {
  it('adds the platforms of every roundup the release cites, and of its game in Nintendo’s store, the model dropped', () => {
    const roundups = [
      { sourceId: 'push-square', title: 'Guide: These 21+ PS5 and PS Plus Games Are Coming Out Next Week', summary: '' },
      { sourceId: 'xbox-wire', title: 'Next Week on XBOX', summary: '' },
    ];
    const nintendo = new Map([['the witcher 3 wild hunt remastered', ['Switch 2']]]);
    const release = (game: string, platforms: Platform[], sources: string[]) => ({ game, platforms, date: '2026-09-29', sources });
    assert.deepEqual(withRoundupPlatforms(release('The Witcher 3: Wild Hunt - Remastered', ['PS5'], ['R1', 'R2']), roundups, nintendo).platforms, [
      'PS5',
      'Xbox Series X|S',
      'Switch 2',
      'PC',
    ]);
    assert.deepEqual(
      withRoundupPlatforms(release('Gothic II Complete Classic', ['PC'], ['R2', 'R7', 'X']), roundups, nintendo).platforms,
      ['Xbox Series X|S', 'PC'],
      'a label of no roundup adds nothing',
    );
  });
});

describe('the radar’s post', () => {
  it('shows her word under the heading and the table of the week', () => {
    const { text, extras } = radarContent('🐦‍⬛🐦‍⬛ Тиждень Відьмака.', [
      { game: 'The Witcher 3', platforms: 'PS5', date: '2026-09-29', day: 'вт, 29 вересня' },
    ]);
    assert.equal(text, '🐦‍⬛🐦‍⬛ Тиждень Відьмака.');
    assert.deepEqual(extras, {
      heading: '📅 Реліз-радар тижня',
      table: { header: ['Гра', 'Де', 'Коли'], rows: [['The Witcher 3', 'PS5', 'вт, 29 вересня']] },
    });
  });

  it('rewrites her word once when it makes up a number, then goes with a plain one', async () => {
    const rows = [{ game: 'Ace Combat 8', platforms: 'PS5', date: '2026-10-02', day: 'пт, 2 жовтня' }];
    const requests: RadarRequest[] = [];
    const write = async (request: RadarRequest) => {
      requests.push(request);
      return { result: { text: '🐦‍⬛🐦‍⬛ Ace Combat 12 уже тут.' }, costUsd: 0.0002 };
    };
    const written = await writeRadarIntro(write, rows);
    assert.equal(written.text, '🐦‍⬛🐦‍⬛ Що виходить цього тижня:');
    assert.deepEqual(requests[1].corrections, ['числа 12 немає у фактах']);
  });
});

describe('ReleaseRadar', () => {
  const chat = (chatId: string, timeZone = 'Europe/Kyiv'): EventChat => ({ chatId, timeZone, quietFrom: 1380, quietTo: 600 });

  function setup(
    roundups = [{ sourceId: 'xbox-wire', title: 'Next Week on XBOX: New Games for September 28 to October 2', summary: 'Minecraft Dungeons II – September 28' }],
    nintendo: (from: Temporal.PlainDate, to: Temporal.PlainDate) => Promise<NintendoRelease[]> = async () => [],
  ) {
    const planned: { chatId: string; text: string }[] = [];
    const extracted: string[] = [];
    const store = {
      eventChats: async () => [chat('-1'), chat('-2', 'UTC')],
      roundups: async () => [...roundups, { sourceId: 'xbox-wire', title: 'Free Play Days', summary: '' }],
      planRadar: async (chatId: string, radar: { text: string }) => {
        planned.push({ chatId, text: radar.text });
      },
    };
    const writers = {
      releases: async (week: string, materials: string) => {
        extracted.push(`${week}\n${materials}`);
        return { result: [{ game: 'Minecraft Dungeons II', platforms: ['Xbox Series X|S' as const, 'PC' as const], date: '2026-09-28', sources: ['R1'] }], costUsd: 0.0005 };
      },
      radar: async () => ({ result: { text: '🐦‍⬛🐦‍⬛ Кубічний тиждень.' }, costUsd: 0.0002 }),
    };
    return { store, writers, nintendo, planned, extracted };
  }

  it('posts the week once in each chat on its Monday, from the roundups only, prepared once', async () => {
    const { store, writers, nintendo, planned, extracted } = setup();
    const kyivNoon = new ReleaseRadar(store, writers, nintendo, () => new Date('2026-09-28T09:00:00Z'));
    const state = await kyivNoon.job().run({});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1'], 'UTC is not at eleven yet');
    assert.equal(extracted.length, 1);
    assert.ok(extracted[0].startsWith('28 вересня – 4 жовтня 2026'));
    assert.ok(!extracted[0].includes('Free Play Days'), 'only the roundups');
    const utcNoon = new ReleaseRadar(store, writers, nintendo, () => new Date('2026-09-28T12:00:00Z'));
    const next = await utcNoon.job().run(state ?? {});
    await utcNoon.job().run(next ?? {});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1', '-2']);
    assert.equal(extracted.length, 1, 'one extraction a week');
  });

  it('goes without a post in a week with no roundups', async () => {
    const { store, writers, nintendo, planned, extracted } = setup([]);
    await new ReleaseRadar(store, writers, nintendo, () => new Date('2026-09-28T09:00:00Z')).job().run({});
    assert.deepEqual(planned, []);
    assert.deepEqual(extracted, []);
  });

  it('reads the week of Nintendo’s store with the roundups, and goes on without it when the store fails', async () => {
    const witcher: NintendoRelease = { title: 'The Witcher 3: Wild Hunt — Remastered', systems: ['Switch 2'], date: '2026-09-29', publisher: 'CD PROJEKT RED', rank: 198 };
    const weeks: [string, string][] = [];
    const store = setup([], async (from, to) => {
      weeks.push([from.toString(), to.toString()]);
      return [witcher];
    });
    await new ReleaseRadar(store.store, store.writers, store.nintendo, () => new Date('2026-09-28T09:00:00Z')).job().run({});
    assert.deepEqual(weeks, [['2026-09-28', '2026-10-04']]);
    assert.ok(store.extracted[0].includes('- The Witcher 3: Wild Hunt — Remastered (Switch 2) — 2026-09-29 — CD PROJEKT RED'));
    assert.deepEqual(store.planned.map((p) => p.chatId), ['-1'], 'the store alone makes a week');

    const failing = setup(undefined, async () => {
      throw new Error('HTTP 503');
    });
    await new ReleaseRadar(failing.store, failing.writers, failing.nintendo, () => new Date('2026-09-28T09:00:00Z')).job().run({});
    assert.deepEqual(failing.planned.map((p) => p.chatId), ['-1']);
    assert.ok(!failing.extracted[0].includes('Nintendo'));
  });
});

describe('Nintendo’s store', () => {
  const doc = (title: string, system: string, date: string, rank?: number) => ({
    title,
    system_names_txt: [system],
    dates_released_dts: [`${date}T00:00:00Z`],
    publisher: 'Mojang',
    ...(rank === undefined ? {} : { downloads_rank_i: rank }),
  });

  it('gives a game once for its Switch and Switch 2 versions, without the marks and an empty rank', () => {
    const answer = JSON.stringify({
      response: {
        docs: [
          doc('Minecraft Dungeons II', 'Nintendo Switch', '2026-09-29', 212),
          doc('Minecraft Dungeons II', 'Nintendo Switch 2', '2026-09-29', 109),
          doc('Middle-earth™: Shadow Bundle', 'Nintendo Switch 2', '2026-09-30', 999999),
          { title: 'No date' },
        ],
      },
    });
    assert.deepEqual(parseNintendoReleases(answer), [
      { title: 'Minecraft Dungeons II', systems: ['Switch', 'Switch 2'], date: '2026-09-29', publisher: 'Mojang', rank: 109 },
      { title: 'Middle-earth: Shadow Bundle', systems: ['Switch 2'], date: '2026-09-30', publisher: 'Mojang', rank: null },
    ]);
  });

  it('shows the model the most downloaded games of the week in the order of their days', () => {
    const game = (title: string, date: string, rank: number | null): NintendoRelease => ({ title, systems: ['Switch'], date, publisher: null, rank });
    const small = Array.from({ length: 45 }, (_, i) => game(`Small ${i}`, '2026-09-28', null));
    const materials = nintendoMaterials([...small, game('Late Hit', '2026-10-02', 5), game('Early Hit', '2026-09-29', 50)]);
    const lines = materials.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 40);
    assert.ok(lines.indexOf('- Early Hit (Switch) — 2026-09-29') < lines.indexOf('- Late Hit (Switch) — 2026-10-02'));
    assert.equal(nintendoMaterials([]), '');
  });
});
