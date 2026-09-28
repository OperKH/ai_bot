import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RadarRequest } from './prompts';
import { radarContent, radarMonday, radarRows, ReleaseRadar, writeRadarIntro } from './releases';
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
        { game: 'The Witcher 3: Wild Hunt Remastered', platforms: 'PS5, Xbox Series X|S, PC', date: '2026-09-29' },
        { game: 'Ace Combat 8: Wings of Theve', platforms: 'PS5, Xbox Series X|S, PC', date: '2026-10-02' },
        { game: 'Minecraft Dungeons II', platforms: 'Xbox Series X|S, PC, PS5, Switch 2', date: '2026-09-28' },
        { game: 'ace combat 8: wings of theve', platforms: 'PS5', date: '2026-10-02' },
        { game: 'Gears of War: E-Day', platforms: 'Xbox Series X|S, PC', date: '2026-10-06' },
        { game: 'Toem 2', platforms: 'PS5, Switch 2', date: 'TBA' },
      ],
      monday,
    );
    assert.deepEqual(
      rows.map((row) => [row.game, row.day]),
      [
        ['Minecraft Dungeons II', 'пн, 28 вересня'],
        ['The Witcher 3: Wild Hunt Remastered', 'вт, 29 вересня'],
        ['Ace Combat 8: Wings of Theve', 'пт, 2 жовтня'],
      ],
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ game: `Game ${i}`, platforms: 'PC', date: '2026-10-01' }));
    assert.equal(radarRows(many, monday).length, 8);
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

  function setup(roundups = [{ sourceId: 'xbox-wire', title: 'Next Week on XBOX: New Games for September 28 to October 2', summary: 'Minecraft Dungeons II – September 28' }]) {
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
        return { result: [{ game: 'Minecraft Dungeons II', platforms: 'Xbox Series X|S, PC', date: '2026-09-28' }], costUsd: 0.0005 };
      },
      radar: async () => ({ result: { text: '🐦‍⬛🐦‍⬛ Кубічний тиждень.' }, costUsd: 0.0002 }),
    };
    return { store, writers, planned, extracted };
  }

  it('posts the week once in each chat on its Monday, from the roundups only, prepared once', async () => {
    const { store, writers, planned, extracted } = setup();
    const kyivNoon = new ReleaseRadar(store, writers, () => new Date('2026-09-28T09:00:00Z'));
    const state = await kyivNoon.job().run({});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1'], 'UTC is not at eleven yet');
    assert.equal(extracted.length, 1);
    assert.ok(extracted[0].startsWith('28 вересня – 4 жовтня 2026'));
    assert.ok(!extracted[0].includes('Free Play Days'), 'only the roundups');
    const utcNoon = new ReleaseRadar(store, writers, () => new Date('2026-09-28T12:00:00Z'));
    const next = await utcNoon.job().run(state ?? {});
    await utcNoon.job().run(next ?? {});
    assert.deepEqual(planned.map((p) => p.chatId), ['-1', '-2']);
    assert.equal(extracted.length, 1, 'one extraction a week');
  });

  it('goes without a post in a week with no roundups', async () => {
    const { store, writers, planned, extracted } = setup([]);
    await new ReleaseRadar(store, writers, () => new Date('2026-09-28T09:00:00Z')).job().run({});
    assert.deepEqual(planned, []);
    assert.deepEqual(extracted, []);
  });
});
