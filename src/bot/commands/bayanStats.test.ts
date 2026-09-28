import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InputRichMessage } from 'grammy/types';
import { type BayanRow, type BayanStatsPort, bayanStatsMessage, dueWindow, monthMayEnd, postDueStats, summarize } from './bayanStats';

const at = (iso: string) => new Date(iso);
const row = (messageId: number, authorId: string, first: number, previous: number, copies: number, authorName = `Кіт ${authorId}`): BayanRow => ({
  messageId: String(messageId),
  authorId,
  authorName,
  firstMessageId: String(first),
  previousMessageId: String(previous),
  copies,
});

describe('monthMayEnd', () => {
  it('looks for the statistics from the last day of a month to the second of the next in UTC, which every zone’s end falls into', () => {
    assert.equal(monthMayEnd(at('2026-10-30T23:59:00Z')), false);
    assert.equal(monthMayEnd(at('2026-10-31T00:00:00Z')), true);
    assert.equal(monthMayEnd(at('2026-11-02T23:59:00Z')), true);
    assert.equal(monthMayEnd(at('2026-11-03T00:00:00Z')), false);
    assert.equal(monthMayEnd(at('2027-02-28T12:00:00Z')), true);
    // The earliest end is in UTC+14, the latest grace in UTC−12
    assert.ok(dueWindow(at('2026-10-31T05:42:00Z'), 'Pacific/Kiritimati') && monthMayEnd(at('2026-10-31T05:42:00Z')));
    assert.ok(dueWindow(at('2026-11-02T07:41:00Z'), 'Etc/GMT+12') && monthMayEnd(at('2026-11-02T07:41:00Z')));
  });
});

describe('dueWindow', () => {
  it('is due from 19:42 of the month’s last day in the chat’s zone, for a day, from the end of the month before', () => {
    // 31.10, 19:42 in Kyiv is 17:42 UTC: winter time since the 25th
    assert.equal(dueWindow(at('2026-10-31T17:41:00Z'), 'Europe/Kyiv'), null);
    assert.deepEqual(dueWindow(at('2026-10-31T17:42:00Z'), 'Europe/Kyiv'), {
      month: '2026-10',
      label: 'жовтня',
      // 30.09, 19:42 in Kyiv, summer time
      from: at('2026-09-30T16:42:00Z'),
      to: at('2026-10-31T17:42:00Z'),
    });
    assert.equal(dueWindow(at('2026-11-01T10:00:00Z'), 'Europe/Kyiv')?.month, '2026-10', 'late, the bot was down');
    assert.equal(dueWindow(at('2026-11-01T17:42:00Z'), 'Europe/Kyiv'), null, 'a day late is too late');
    assert.equal(dueWindow(at('2026-10-15T12:00:00Z'), 'Europe/Kyiv'), null);
  });

  it('counts a chat without a zone in UTC, and knows February', () => {
    assert.equal(dueWindow(at('2026-10-31T19:41:00Z'), 'UTC'), null);
    assert.equal(dueWindow(at('2026-10-31T19:42:00Z'), 'UTC')?.month, '2026-10');
    assert.equal(dueWindow(at('2027-02-28T19:42:00Z'), 'UTC')?.label, 'лютого');
  });
});

describe('summarize', () => {
  const rows = [
    row(1500, '1', 100, 1400, 3, 'Олег'),
    row(1510, '2', 1505, 1505, 1),
    row(1600, '1', 900, 1590, 9, 'Олег Б.'),
    row(1700, '3', 1698, 1698, 1),
  ];

  it('ranks who posted most, by the name they last had, and finds the bayan of the month, the oldest and the quickest', () => {
    const stats = summarize(rows, 120);
    assert.equal(stats.media, 120);
    assert.equal(stats.bayans, 4);
    assert.deepEqual(stats.authors, [
      { name: 'Олег Б.', bayans: 2 },
      { name: 'Кіт 2', bayans: 1 },
      { name: 'Кіт 3', bayans: 1 },
    ]);
    assert.deepEqual(stats.top, { messageId: '1600', time: 10 });
    assert.deepEqual(stats.oldest, { messageId: '1500', authorName: 'Олег', messagesSince: 1400 });
    assert.deepEqual(stats.quickest, { messageId: '1700', authorName: 'Кіт 3', messagesSince: 2 });
  });

  it('has no bayan of the month among bayans seen twice, and never counts fewer media than bayans', () => {
    const stats = summarize([row(10, '1', 5, 5, 1), row(20, '2', 15, 15, 1)], 0);
    assert.equal(stats.top, null);
    assert.equal(stats.media, 2, 'media stored before their time was kept');
  });
});

describe('bayanStatsMessage', () => {
  const window = { month: '2026-10', label: 'жовтня', from: at('2026-09-30T16:42:00Z'), to: at('2026-10-31T17:42:00Z') };

  it('shows the month, the share, the table of bayanists and the lines with links, names as text', () => {
    const message = bayanStatsMessage(
      summarize([row(1500, '1', 100, 1400, 3, 'Олег'), row(1600, '1', 900, 1590, 9, 'Олег'), row(1700, '3', 1698, 1698, 1, 'Іра')], 40),
      window,
      -1001234567890,
    );
    const text = JSON.stringify(message.blocks);
    assert.deepEqual(message.blocks?.[0], { type: 'heading', text: '📊 Баяни жовтня', size: 2 });
    assert.deepEqual(message.blocks?.[1], { type: 'paragraph', text: 'Медіа за місяць: 40, з них баянів: 3 — 8%.' });
    assert.match(text, /"text":"Олег"\}.*"text":"2"/);
    assert.match(text, /🔁 Баян місяця: чат бачить його вже 10-й раз\./);
    assert.match(text, /через 1400 повідомлень після першої появи/);
    assert.match(text, /лише через 2 повідомлення після попереднього/);
    assert.match(text, /https:\/\/t\.me\/c\/1234567890\/1600/);
    assert.doesNotMatch(text, /mention/);
  });

  it('leaves out the quickest when it is the oldest too', () => {
    const blocks = bayanStatsMessage(summarize([row(50, '1', 10, 10, 1)], 3), window, -1001234567890).blocks;
    assert.equal(JSON.stringify(blocks).includes('Найшвидший'), false);
    assert.equal(JSON.stringify(blocks).includes('Найдавніший'), true);
  });
});

describe('postDueStats', () => {
  function fake(chats: Awaited<ReturnType<BayanStatsPort['chats']>>, rows: BayanRow[]) {
    const sent: { chatId: string; message: InputRichMessage }[] = [];
    const posted: string[] = [];
    const port: BayanStatsPort = {
      chats: async () => chats,
      bayans: async () => rows,
      mediaCount: async () => 50,
      markPosted: async (chatId, month) => {
        posted.push(`${chatId}:${month}`);
        const chat = chats.find((c) => c.chatId === chatId);
        if (chat) chat.postedMonth = month;
      },
      send: async (chatId, message) => {
        sent.push({ chatId, message });
      },
    };
    return { port, sent, posted };
  }

  it('sends each chat its month once, in its own zone', async () => {
    const since = at('2026-09-27T12:00:00Z');
    const chats = [
      { chatId: '-100111', timeZone: 'Europe/Kyiv', postedMonth: '2026-09', trackedSince: since },
      { chatId: '-100222', timeZone: null, postedMonth: null, trackedSince: since },
    ];
    const { port, sent, posted } = fake(chats, [row(1500, '1', 100, 1400, 3)]);
    await postDueStats(port, at('2026-10-31T17:45:00Z'));
    assert.deepEqual(sent.map((s) => s.chatId), ['-100111'], 'still 17:45 in UTC');
    await postDueStats(port, at('2026-10-31T17:50:00Z'));
    await postDueStats(port, at('2026-10-31T19:42:00Z'));
    assert.deepEqual(sent.map((s) => s.chatId), ['-100111', '-100222']);
    assert.deepEqual(posted, ['-100111:2026-10', '-100222:2026-10']);
  });

  it('marks a month without bayans and sends nothing', async () => {
    const { port, sent, posted } = fake([{ chatId: '-100111', timeZone: 'UTC', postedMonth: null, trackedSince: at('2026-09-01T00:00:00Z') }], []);
    await postDueStats(port, at('2026-10-31T20:00:00Z'));
    assert.deepEqual(sent, []);
    assert.deepEqual(posted, ['-100111:2026-10']);
  });

  it('skips the month the bot began to watch in — deployed on the 27th of September, its first statistics are October’s', async () => {
    const chats = [{ chatId: '-100111', timeZone: 'Europe/Kyiv', postedMonth: null, trackedSince: at('2026-09-27T12:00:00Z') as Date | null }];
    const { port, sent, posted } = fake(chats, [row(1500, '1', 100, 1400, 3)]);
    await postDueStats(port, at('2026-09-30T16:45:00Z'));
    assert.equal(sent.length, 0, 'September was watched three days only');
    assert.deepEqual(posted, ['-100111:2026-09']);
    await postDueStats(port, at('2026-10-31T17:45:00Z'));
    assert.deepEqual(sent.map((s) => s.chatId), ['-100111']);
    const unwatched = fake([{ chatId: '-100222', timeZone: 'UTC', postedMonth: null, trackedSince: null }], [row(1500, '1', 100, 1400, 3)]);
    await postDueStats(unwatched.port, at('2026-10-31T20:00:00Z'));
    assert.deepEqual(unwatched.sent, []);
  });
});
