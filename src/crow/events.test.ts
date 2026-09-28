import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CrowEvent, CrowEventTexts } from '../entity/CrowEvent.entity';
import {
  announcedStart,
  CrowEvents,
  eventText,
  reminderTime,
  streamMoments,
  streamTextsProblems,
  writeStreamTexts,
} from './events';
import { allowedNumbers } from './arcValidation';
import type { StreamResult, StreamTextsResult } from './prompts';
import { parseYouTubeUploads, parseYouTubeVideos, STREAM_SOURCES } from './sources/streamSources';
import type { EventChat, EventPost, FoundEvent } from './store';

const at = (iso: string) => new Date(iso);
const result = (patch: Partial<StreamResult>): StreamResult => ({
  announces: true,
  title: 'State of Play',
  date: '2026-10-22',
  time: '14:00',
  zone: 'PT',
  ...patch,
});

describe('announcedStart', () => {
  it('reads the time in its zone, with the zone’s summer time', () => {
    // Late October: Europe is on winter time already, California not yet
    assert.deepEqual(announcedStart(result({ date: '2026-10-29', time: '7:00' })), at('2026-10-29T14:00:00Z'));
    assert.deepEqual(announcedStart(result({ date: '2026-12-03', time: '7:00' })), at('2026-12-03T15:00:00Z'));
    assert.deepEqual(announcedStart(result({ zone: 'cest', time: '16:00' })), at('2026-10-22T14:00:00Z'));
  });

  it('takes no start without an announcement, a known zone or a real time', () => {
    assert.equal(announcedStart(result({ announces: false })), null);
    assert.equal(announcedStart(result({ zone: 'Pacific' })), null);
    assert.equal(announcedStart(result({ time: '7am' })), null);
    assert.equal(announcedStart(result({ date: '2026-13-01' })), null);
  });
});

describe('streamMoments and eventText', () => {
  const texts: CrowEventTexts = {
    announcement: '🐦‍⬛🐦‍⬛ State of Play — {when:start}.',
    reminder: '🐦‍⬛ Збираємось, почнеться {when:start}!',
    nightReminder: '🐦‍⬛ Поки ви спатимете, о {when:start}.',
  };

  it('shows the start as a day and time with how far off, how soon, or the time alone', () => {
    assert.equal(eventText(texts, 'event'), '🐦‍⬛🐦‍⬛ State of Play — {when:start} ({when:in}).');
    assert.equal(eventText(texts, 'reminder'), '🐦‍⬛ Збираємось, почнеться {when:in}!');
    assert.equal(eventText(texts, 'night'), '🐦‍⬛ Поки ви спатимете, о {when:at}.');
    const moments = streamMoments(at('2026-10-22T21:00:00Z'), 'Europe/Kyiv');
    assert.deepEqual(moments.start, { unixTime: 1792702800, format: 'wDt', fallback: '23 жовтня, 00:00 (Київ)' });
    assert.equal(moments.in.format, 'r');
    assert.deepEqual(moments.at, { unixTime: 1792702800, format: 't', fallback: '00:00 (Київ)' });
  });
});

describe('reminderTime', () => {
  const kyiv: Pick<EventChat, 'timeZone' | 'quietFrom' | 'quietTo'> = { timeZone: 'Europe/Kyiv', quietFrom: 1380, quietTo: 600 };
  const NOW = at('2026-10-20T10:00:00Z');

  it('reminds half an hour before a stream in the chat’s day', () => {
    assert.deepEqual(reminderTime(at('2026-10-22T14:00:00Z'), kyiv, NOW), {
      night: false,
      notBefore: at('2026-10-22T13:30:00Z'),
      expiresAt: at('2026-10-22T14:10:00Z'),
    });
    assert.equal(reminderTime(at('2026-10-22T14:00:00Z'), { ...kyiv, quietFrom: null, quietTo: null }, NOW)?.night, false);
  });

  it('reminds of a stream in the quiet hours an hour before they begin, ahead of the goodbye', () => {
    // 00:00 in Kyiv: the quiet hours began at 23:00 the evening before
    assert.deepEqual(reminderTime(at('2026-10-22T21:00:00Z'), kyiv, NOW), {
      night: true,
      notBefore: at('2026-10-22T19:00:00Z'),
      expiresAt: at('2026-10-22T20:00:00Z'),
    });
    // 09:00 in Kyiv, still quiet: the evening before
    assert.deepEqual(reminderTime(at('2026-10-23T06:00:00Z'), kyiv, NOW)?.expiresAt, at('2026-10-22T20:00:00Z'));
  });

  it('has no reminder once its time is past', () => {
    assert.equal(reminderTime(at('2026-10-20T10:05:00Z'), kyiv, at('2026-10-20T10:20:00Z')), null);
    assert.equal(reminderTime(at('2026-10-20T21:00:00Z'), kyiv, at('2026-10-20T20:30:00Z')), null, 'the quiet hours began');
  });
});

describe('the texts of a stream', () => {
  const good: StreamTextsResult = {
    announcement: '🐦‍⬛🐦‍⬛ State of Play — {when:start}. Готуйте попкорн.',
    reminder: '🐦‍⬛ Коти, збираємось, я вже з попкорном.',
    nightReminder: '🐦‍⬛ Поки ви спатимете, о {when:start} — хто не спить, я з вами.',
  };

  it('wants the start in the announcement and the night reminder, never as digits', () => {
    assert.deepEqual(streamTextsProblems(good, allowedNumbers()), []);
    assert.deepEqual(
      streamTextsProblems({ ...good, announcement: '🐦‍⬛🐦‍⬛ State of Play о 16:00.', reminder: '🐦‍⬛ {when:start}{when:start}' }, allowedNumbers()),
      [
        'announcement: `{when:start}` має бути рівно один раз',
        'reminder: `{when:start}` — не більше одного разу',
        'announcement: час доби цифрами заборонений',
        'announcement: числа 16 немає у фактах',
      ],
    );
  });

  it('goes with plain texts when the model’s still fail after the rewrite', async () => {
    let calls = 0;
    const written = await writeStreamTexts(
      async () => {
        calls++;
        return { result: { ...good, nightReminder: '🐦‍⬛ Уночі.' }, costUsd: 0.0004 };
      },
      { title: 'Nintendo Direct', organizer: 'Nintendo of America', categoryName: '🍄 Нінтендо' },
    );
    assert.equal(calls, 2);
    assert.equal(written.written, false);
    assert.equal(written.texts.announcement, '🐦‍⬛🐦‍⬛ Коти, Nintendo Direct — {when:start}. Я вже готую попкорн.');
  });
});

describe('YouTube', () => {
  it('reads the videos of a channel\'s uploads, and a live stream from a premiere by its length', () => {
    assert.deepEqual(
      parseYouTubeUploads(JSON.stringify({ items: [{ contentDetails: { videoId: 'j9epFget1W8' } }, { contentDetails: {} }] })),
      ['j9epFget1W8'],
    );
    const videos = parseYouTubeVideos(
      JSON.stringify({
        items: [
          {
            id: 'live1',
            snippet: { title: 'State of Play | 22.10.2026', liveBroadcastContent: 'upcoming' },
            contentDetails: { duration: 'P0D' },
            liveStreamingDetails: { scheduledStartTime: '2026-10-22T21:00:00Z' },
          },
          {
            id: 'prem1',
            snippet: { title: 'Trailer', liveBroadcastContent: 'upcoming' },
            contentDetails: { duration: 'PT1M30S' },
            liveStreamingDetails: { scheduledStartTime: '2026-10-21T15:00:00Z' },
          },
          { id: 'old', snippet: { title: 'Old', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT5M' } },
        ],
      }),
    );
    assert.deepEqual(
      videos.map((v) => [v.videoId, v.broadcast, v.isLive, v.scheduledStart?.toISOString() ?? null]),
      [
        ['live1', 'upcoming', true, '2026-10-22T21:00:00.000Z'],
        ['prem1', 'upcoming', false, '2026-10-21T15:00:00.000Z'],
        ['old', 'none', false, null],
      ],
    );
  });

  it('announces only the shows of the game channels, and every live stream of the labs', () => {
    const accept = (id: string, title: string) => {
      const source = STREAM_SOURCES.find((s) => s.id === id);
      return source?.kind === 'youtube' && (source.accept?.(title) ?? true);
    };
    assert.ok(accept('youtube-playstation', 'State of Play | 22.10.2026'));
    assert.equal(accept('youtube-playstation', 'Ghost of Yōtei - Launch Trailer | PS5 Games'), false);
    assert.ok(accept('youtube-nintendo', 'Nintendo Direct 10.22.2026'));
    assert.ok(accept('youtube-openai', 'OpenAI DevDay 2026'));
  });
});

/** A store of one stream in the making, and one chat that hears it */
function fakeStore(options: { event?: Partial<CrowEvent>; posts?: EventPost[]; chat?: Partial<EventChat> } = {}) {
  const event = {
    id: 1,
    key: 'youtube:live1',
    title: 'State of Play',
    categories: ['playstation'],
    url: 'https://www.youtube.com/watch?v=live1',
    startsAt: at('2026-10-22T14:00:00Z'),
    sources: [],
    videoId: 'live1',
    status: 'upcoming',
    texts: null,
    checkedAt: null,
    createdAt: at('2026-10-20T09:00:00Z'),
    ...options.event,
  } as unknown as CrowEvent;
  const found: FoundEvent[] = [];
  const planned: { chatId: string; posts: { kind: string; text: string; notBefore: Date; expiresAt: Date }[] }[] = [];
  const moved: { id: number; patch: object }[] = [];
  const store = {
    findEvent: async (candidate: FoundEvent) => {
      found.push(candidate);
      return { stored: { ...event, ...candidate } as unknown as CrowEvent, created: true, previousStart: null };
    },
    upcomingEvents: async () => [event],
    setEventTexts: async (_id: number, texts: CrowEventTexts) => {
      event.texts = texts;
    },
    checkedEvent: async () => undefined,
    setEventStatus: async (_id: number, status: CrowEvent['status']) => {
      event.status = status;
    },
    eventChats: async () => [{ chatId: '-1001', timeZone: 'Europe/Kyiv', quietFrom: 1380, quietTo: 600, ...options.chat }],
    eventPosts: async () => options.posts ?? [],
    planEventPosts: async (chatId: string, _eventId: number, posts: { kind: string; text: string; notBefore: Date; expiresAt: Date }[]) => {
      planned.push({ chatId, posts });
    },
    moveEventPost: async (id: number, patch: object) => {
      moved.push({ id, patch });
    },
    cancelEventPosts: async () => undefined,
    latestShooMessage: async () => 700,
  };
  return { store, event, found, planned, moved };
}

const texts: StreamTextsResult = {
  announcement: '🐦‍⬛🐦‍⬛ State of Play — {when:start}. Готуйте попкорн.',
  reminder: '🐦‍⬛ Коти, збираємось, я вже з попкорном.',
  nightReminder: '🐦‍⬛ Поки ви спатимете, о {when:start}.',
};
const writers = {
  extract: async () => ({ result: result({}), costUsd: 0.0003 }),
  texts: async () => ({ result: texts, costUsd: 0.0004 }),
};

describe('CrowEvents', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('writes the words once, as the organizer that told of it, and plans the announcement and the reminder', async () => {
    const { store, event, planned } = fakeStore({
      event: { sources: [{ kind: 'youtube', name: 'Anthropic', url: 'https://www.youtube.com/watch?v=live1', startsAt: '' }] },
    });
    const organizers: string[] = [];
    const edits: unknown[] = [];
    const events = new CrowEvents(
      store,
      STREAM_SOURCES,
      { ...writers, texts: async (request) => (organizers.push(request.organizer), writers.texts()) },
      { edit: async (...args) => void edits.push(args) },
      '',
      () => at('2026-10-20T10:00:00Z'),
    );
    const streams = events.jobs().find((job) => job.name === 'streams')!;
    await streams.run({});
    assert.deepEqual(organizers, ['Anthropic'], 'not the first channel of the category');
    assert.equal(event.texts?.announcement, texts.announcement);
    assert.deepEqual(planned[0].posts, [
      {
        kind: 'event',
        text: '🐦‍⬛🐦‍⬛ State of Play — {when:start} ({when:in}). Готуйте попкорн.',
        notBefore: at('2026-10-20T10:00:00Z'),
        expiresAt: at('2026-10-22T13:15:00Z'),
      },
      { kind: 'reminder', text: texts.reminder, notBefore: at('2026-10-22T13:30:00Z'), expiresAt: at('2026-10-22T14:10:00Z') },
    ]);
    assert.ok(
      events.jobs().every((job) => !job.name.startsWith('stream:youtube')),
      'without a key the channels are not polled: their feeds give no start',
    );
  });

  it('does not announce a stream more than a week ahead, or plan a chat twice', async () => {
    const far = fakeStore({ event: { startsAt: at('2026-11-20T14:00:00Z') } });
    await new CrowEvents(far.store, STREAM_SOURCES, writers, { edit: async () => undefined }, '', () => at('2026-10-20T10:00:00Z'))
      .jobs()
      .find((job) => job.name === 'streams')!
      .run({});
    assert.equal(far.planned.length, 0);
    const done = fakeStore({ posts: [{ id: 5, chatId: '-1001', kind: 'event', status: 'planned', text: '', tgMessageId: null }] });
    await new CrowEvents(done.store, STREAM_SOURCES, writers, { edit: async () => undefined }, '', () => at('2026-10-20T10:00:00Z'))
      .jobs()
      .find((job) => job.name === 'streams')!
      .run({});
    assert.equal(done.planned.length, 0);
  });

  it('finds an upcoming live stream of a channel through YouTube, and skips its premieres and old videos', async () => {
    const { store, found } = fakeStore();
    const uploads = { items: [{ contentDetails: { videoId: 'live1' } }, { contentDetails: { videoId: 'prem1' } }] };
    const api = {
      items: [
        {
          id: 'live1',
          snippet: { title: 'State of Play | 22.10.2026', liveBroadcastContent: 'upcoming' },
          contentDetails: { duration: 'P0D' },
          liveStreamingDetails: { scheduledStartTime: '2026-10-22T14:00:00Z' },
        },
        {
          id: 'prem1',
          snippet: { title: 'State of Play trailer', liveBroadcastContent: 'upcoming' },
          contentDetails: { duration: 'PT1M' },
          liveStreamingDetails: { scheduledStartTime: '2026-10-21T14:00:00Z' },
        },
      ],
    };
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(JSON.stringify(url.includes('/playlistItems?') ? uploads : api), { status: 200 });
    }) as typeof fetch;
    const events = new CrowEvents(store, STREAM_SOURCES, writers, { edit: async () => undefined }, 'test-key', () =>
      at('2026-10-20T10:00:00Z'),
    );
    const job = events.jobs().find((j) => j.name === 'stream:youtube-playstation')!;
    const state = await job.run({});
    assert.ok(requested[0]!.includes('playlistId=UU-2Y8dQb0S6DtpxNgAKoJKA'));
    assert.deepEqual(found.map((f) => [f.key, f.startsAt.toISOString(), f.url]), [
      ['youtube:live1', '2026-10-22T14:00:00.000Z', 'https://www.youtube.com/watch?v=live1'],
    ]);
    assert.deepEqual((state as { seen: string[] }).seen, ['live1', 'prem1']);
    // The next poll asks YouTube about new videos only
    requested.length = 0;
    await job.run(state ?? {});
    assert.equal(requested.filter((url) => url.includes('/videos?')).length, 0);
  });

  it('moves the reminders of a stream that moved, and edits its announcements sent already', async () => {
    const posts: EventPost[] = [
      { id: 10, chatId: '-1001', kind: 'event', status: 'sent', text: '🐦‍⬛🐦‍⬛ State of Play — {when:start} ({when:in}).', tgMessageId: 700 },
      { id: 11, chatId: '-1001', kind: 'reminder', status: 'planned', text: texts.reminder, tgMessageId: null },
    ];
    const { store, moved } = fakeStore({ posts, event: { texts, checkedAt: at('2026-10-20T00:00:00Z') } });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'live1',
              snippet: { title: 'State of Play', liveBroadcastContent: 'upcoming' },
              contentDetails: { duration: 'P0D' },
              liveStreamingDetails: { scheduledStartTime: '2026-10-22T21:00:00Z' },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const edits: { chatId: string; messageId: number; withShoo: boolean; text: unknown }[] = [];
    const events = new CrowEvents(
      store,
      STREAM_SOURCES,
      writers,
      { edit: async (chatId, messageId, _postId, message, withShoo) => void edits.push({ chatId, messageId, withShoo, text: message.blocks?.[0] }) },
      'test-key',
      () => at('2026-10-20T10:00:00Z'),
    );
    await events.jobs().find((job) => job.name === 'streams')!.run({});
    assert.equal(edits.length, 1);
    assert.deepEqual([edits[0].chatId, edits[0].messageId, edits[0].withShoo], ['-1001', 700, true]);
    // Midnight in Kyiv is in the quiet hours: the reminder goes the evening before, as the night one
    assert.deepEqual(moved, [
      {
        id: 11,
        patch: { text: '🐦‍⬛ Поки ви спатимете, о {when:at}.', notBefore: at('2026-10-22T19:00:00Z'), expiresAt: at('2026-10-22T20:00:00Z') },
      },
    ]);
  });
});
