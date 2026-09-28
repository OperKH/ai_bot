import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type DispatchCandidate, type DispatchChat, isLoud, LIMITED_KINDS, nextPostTime } from './dispatch';

const NOW = new Date('2026-09-26T12:00:00Z'); // 15:00 in Kyiv
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const minutesLater = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const chat = (patch: Partial<DispatchChat> = {}): DispatchChat => ({
  boldness: 'bold',
  timeZone: 'Europe/Kyiv',
  quietFrom: 1380,
  quietTo: 600,
  snoozedUntil: null,
  nextPostAt: null,
  ...patch,
});

let nextId = 1;
const candidate = (patch: Partial<DispatchCandidate> = {}): DispatchCandidate => ({
  postId: nextId++,
  kind: 'arc',
  storyId: 1,
  isFirst: false,
  optional: false,
  importance: 2,
  notBefore: minutesAgo(1),
  expiresAt: null,
  storyLastSentAt: minutesAgo(10),
  ...patch,
});

const quietSent = { lastHour: 0, today: 0 };

describe('decide', () => {
  it('sends the post whose turn has come', () => {
    const post = candidate();
    assert.deepEqual(decide(chat(), [post], quietSent, NOW), { send: post, skip: [] });
  });

  it('counts the quiet hours in UTC when the chat has not set its zone', () => {
    const post = candidate();
    const at = new Date('2026-09-26T22:00:00Z'); // 01:00 in Kyiv, 22:00 UTC
    assert.equal(decide(chat(), [post], quietSent, at).send, null, 'quiet in Kyiv');
    assert.equal(decide(chat({ timeZone: 'UTC' }), [post], quietSent, at).send, post, 'not yet quiet in UTC');
  });

  it('waits out the minimal gap, a snooze and the quiet hours', () => {
    const post = candidate();
    assert.equal(decide(chat({ nextPostAt: minutesLater(1) }), [post], quietSent, NOW).send, null);
    assert.equal(decide(chat({ snoozedUntil: minutesLater(30) }), [post], quietSent, NOW).send, null);
    assert.equal(decide(chat({ quietFrom: 900, quietTo: 960 }), [post], quietSent, NOW).send, null); // 15:00–16:00
    assert.equal(decide(chat({ snoozedUntil: minutesAgo(1) }), [post], quietSent, NOW).send, post);
  });

  it('drops out-of-date posts, even while waiting', () => {
    const stale = candidate({ optional: true, expiresAt: minutesAgo(1) });
    const decision = decide(chat({ snoozedUntil: minutesLater(30) }), [stale], quietSent, NOW);
    assert.deepEqual(decision, { send: null, skip: [stale] });
  });

  it('puts the news first, then the core of arcs, then filler', () => {
    const filler = candidate({ optional: true, importance: 3 });
    const core = candidate({ importance: 1 });
    const news = candidate({ isFirst: true, importance: 1, storyLastSentAt: null });
    assert.equal(decide(chat(), [filler, core, news], quietSent, NOW).send, news);
    assert.equal(decide(chat(), [filler, core], quietSent, NOW).send, core);
  });

  it('prefers the more important story, then the one not heard of for longer', () => {
    const minor = candidate({ importance: 1, storyLastSentAt: minutesAgo(10) });
    const major = candidate({ importance: 3, storyLastSentAt: minutesAgo(10) });
    assert.equal(decide(chat(), [minor, major], quietSent, NOW).send, major);
    const forgotten = candidate({ importance: 1, storyLastSentAt: minutesAgo(8 * 60) });
    assert.equal(decide(chat(), [major, forgotten], quietSent, NOW).send, forgotten);
  });

  it('breaks ties by the earlier turn', () => {
    const later = candidate({ notBefore: minutesAgo(1) });
    const earlier = candidate({ notBefore: minutesAgo(5) });
    assert.equal(decide(chat(), [later, earlier], quietSent, NOW).send, earlier);
  });

  it('over the hourly limit lets only the news of a mega story through', () => {
    const core = candidate({ importance: 3 });
    const minorNews = candidate({ isFirst: true, importance: 2 });
    const megaNews = candidate({ isFirst: true, importance: 3 });
    const sent = { lastHour: 6, today: 6 };
    assert.equal(decide(chat(), [core, minorNews], sent, NOW).send, null);
    assert.equal(decide(chat(), [core, minorNews, megaNews], sent, NOW).send, megaNews);
    // A restrained crow hits its limit sooner
    assert.equal(decide(chat({ boldness: 'restrained' }), [core], { lastHour: 3, today: 3 }, NOW).send, null);
  });

  it('over the daily limit drops filler and goes on with mega stories only', () => {
    const filler = candidate({ optional: true, importance: 3 });
    const minor = candidate({ importance: 2 });
    const mega = candidate({ importance: 3 });
    const decision = decide(chat(), [filler, minor, mega], { lastHour: 0, today: 24 }, NOW);
    assert.deepEqual(decision, { send: mega, skip: [filler] });
  });

  it('lets the goodbye and the introduction through the limits: they are not news', () => {
    const goodbye = candidate({ kind: 'goodbye', storyId: null, isFirst: true, importance: 1, storyLastSentAt: null });
    const intro = candidate({ kind: 'intro', storyId: null, isFirst: true, importance: 3, storyLastSentAt: null });
    assert.equal(decide(chat(), [goodbye], { lastHour: 0, today: 24 }, NOW).send, goodbye);
    assert.equal(decide(chat(), [goodbye], { lastHour: 6, today: 6 }, NOW).send, goodbye);
    assert.equal(decide(chat(), [intro], { lastHour: 6, today: 6 }, NOW).send, intro);
  });

  it('lets the weekly digest, a bet’s outcome and the streams through the limits, and stops a bet and a UPD', () => {
    const over = { lastHour: 6, today: 24 };
    for (const kind of ['weekly', 'outcome', 'event', 'reminder'] as const) {
      const post = candidate({ kind, storyId: null, isFirst: true, storyLastSentAt: null });
      assert.equal(decide(chat(), [post], over, NOW).send, post, kind);
    }
    for (const kind of ['bet', 'update'] as const) {
      assert.equal(decide(chat(), [candidate({ kind })], over, NOW).send, null, kind);
    }
  });

  it('sends the news of a story before the goodbye due with it', () => {
    const goodbye = candidate({ kind: 'goodbye', storyId: null, isFirst: true, importance: 1, storyLastSentAt: null });
    const news = candidate({ isFirst: true, importance: 2, storyLastSentAt: null });
    const core = candidate({ importance: 3 });
    assert.equal(decide(chat(), [goodbye, news], quietSent, NOW).send, news);
    assert.equal(decide(chat(), [goodbye, core], quietSent, NOW).send, goodbye, 'the rest of an arc waits for the morning');
  });
});

describe('nextPostTime', () => {
  const sentAt = new Date('2026-09-26T19:40:00Z');
  it('is the minimal gap after a post', () => {
    assert.equal(nextPostTime({ kind: 'arc', expiresAt: null }, sentAt, 6 * 60_000).toISOString(), '2026-09-26T19:46:00.000Z');
  });

  it('keeps the crow quiet after her goodbye until the quiet hours begin', () => {
    const quietStart = new Date('2026-09-26T20:00:00Z');
    assert.equal(nextPostTime({ kind: 'goodbye', expiresAt: quietStart }, sentAt, 6 * 60_000), quietStart);
    // Sent at the last moment, the minimal gap is longer
    const late = new Date('2026-09-26T19:58:00Z');
    assert.equal(nextPostTime({ kind: 'goodbye', expiresAt: quietStart }, late, 6 * 60_000).toISOString(), '2026-09-26T20:04:00.000Z');
  });
});

describe('isLoud', () => {
  it('rings for the news and keeps filler silent', () => {
    assert.equal(isLoud({ isFirst: true, importance: 1 }, 'bold'), true);
    assert.equal(isLoud({ isFirst: false, importance: 3 }, 'bold'), false);
  });

  it('rings only for mega news when restrained, and for everything when pestering', () => {
    assert.equal(isLoud({ isFirst: true, importance: 2 }, 'restrained'), false);
    assert.equal(isLoud({ isFirst: true, importance: 3 }, 'restrained'), true);
    assert.equal(isLoud({ isFirst: false, importance: 1 }, 'pestering'), true);
  });

  it('never rings for the evening goodbye', () => {
    assert.equal(isLoud({ isFirst: true, importance: 1 }, 'pestering', 'goodbye'), false);
  });

  it('rings for the reminder that games come or go, and keeps a quiz silent', () => {
    assert.equal(isLoud({ isFirst: false, importance: 2 }, 'bold', 'due'), true);
    assert.equal(isLoud({ isFirst: false, importance: 2 }, 'bold', 'quiz'), false);
    assert.ok(LIMITED_KINDS.includes('quiz'), 'a quiz is part of its arc');
    assert.ok(!LIMITED_KINDS.includes('due') && !LIMITED_KINDS.includes('countdown'));
  });

  it('rings for the UPD to a confirmed rumor as for its news', () => {
    assert.equal(isLoud({ isFirst: false, importance: 2 }, 'bold', 'update'), true);
    assert.equal(isLoud({ isFirst: false, importance: 2 }, 'restrained', 'update'), false);
  });
});
