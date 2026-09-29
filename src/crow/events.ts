import type { InputRichMessage } from 'grammy/types';
import { FALLBACK_TIME_ZONE, zoneLabel } from '../bot/commands/timeZones';
import { getLinkChatId } from '../bot/telegramLinks';
import type { CrowEvent, CrowEventTexts } from '../entity/CrowEvent.entity';
import type { CrowMoment } from '../entity/CrowPost.entity';
import { allowedNumbers, type Attempt, attemptsCost, crowPrefix, textProblems, writeChecked } from './arcValidation';
import { categoriesLabel } from './categories';
import { formatMinutes, isQuiet, localDate, localMoment, zoned } from './chatClock';
import type { Priced } from './crowLlm';
import { crowRichMessage, type PostContent, type PostLink } from './crowMessage';
import type { CrowJobDefinition, JobState } from './jobs';
import type { StreamResult, StreamTextsRequest, StreamTextsResult } from './prompts';
import { BROWSER_HEADERS, fetchText, htmlToText, metaContent, parseFeed } from './sources/feed';
import { redirectTarget, type StreamSource, youtubeUploads, youtubeVideos } from './sources/streamSources';
import type { CrowStore, EventChat, EventPost, FoundEvent } from './store';
import { clip, dateLabel } from './words';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A stream is announced in the chats once it is a week away */
export const ANNOUNCE_AHEAD_MS = 7 * DAY;
/** …and no later than this before it begins: the reminder does the rest */
export const ANNOUNCE_UNTIL_MS = 45 * MINUTE;
export const REMINDER_BEFORE_MS = 30 * MINUTE;
/** A reminder that could not go before the start is still worth this long after it */
const REMINDER_LATE_MS = 10 * MINUTE;
/** A stream in the quiet hours is reminded of this long before they begin, ahead of the evening goodbye */
export const NIGHT_REMINDER_BEFORE_QUIET_MS = 60 * MINUTE;
/** Two sources tell of one stream when they are of one category and their starts this close */
export const SAME_STREAM_MS = 3 * HOUR;
/** YouTube's schedule is checked again this often, and more often in the last hours */
const RECHECK_MS = 6 * HOUR;
const RECHECK_SOON_MS = 20 * MINUTE;
const SOON_MS = 2 * HOUR;
/** A start further than this is a placeholder, not a date */
const MAX_AHEAD_MS = 60 * DAY;
/** An entry of a feed older than this announces nothing any more */
const ANNOUNCEMENT_MAX_AGE_MS = 7 * DAY;
const EVENTS_INTERVAL_MS = 5 * MINUTE;
const SEEN_KEPT = 60;
const PAGE_TEXT_MAX = 4000;
/** The limits of a stream's texts, which the prompt states as they are (prompts.ts) */
export const MAX_ANNOUNCEMENT_LENGTH = 400;
export const MAX_STREAM_REMINDER_LENGTH = 250;

/** The zones announcements name, as IANA zones: Temporal knows each one's summer time */
const ZONES: Record<string, string> = {
  PT: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  MT: 'America/Denver',
  MDT: 'America/Denver',
  MST: 'America/Denver',
  CT: 'America/Chicago',
  CDT: 'America/Chicago',
  CST: 'America/Chicago',
  ET: 'America/New_York',
  EDT: 'America/New_York',
  EST: 'America/New_York',
  GMT: 'Europe/London',
  BST: 'Europe/London',
  CET: 'Europe/Berlin',
  CEST: 'Europe/Berlin',
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  UTC: 'UTC',
};

/**
 * The start an announcement names, as a moment: its local time in its zone,
 * which Temporal turns into one with the zone's summer time — PT and Kyiv are 9
 * hours apart one week a year, 10 the rest. Null when the zone is unknown or the
 * time is no time.
 */
export function announcedStart(result: StreamResult): Date | null {
  const zone = ZONES[result.zone.trim().toUpperCase()];
  const time = /^(\d{1,2}):(\d{2})$/.exec(result.time.trim());
  if (!result.announces || !zone || !time) return null;
  try {
    const local = Temporal.PlainDateTime.from(`${result.date.trim()}T${time[1].padStart(2, '0')}:${time[2]}`);
    return new Date(local.toZonedDateTime(zone).epochMilliseconds);
  } catch {
    return null;
  }
}

/**
 * The moments of a stream's posts, from its start: the day and time (`start`),
 * how far off (`in`) and the time alone (`at`). Old clients see them in the
 * chat's zone, named.
 */
export function streamMoments(startsAt: Date, timeZone: string): Record<string, CrowMoment> {
  const local = zoned(startsAt, timeZone);
  const time = formatMinutes(local.hour * 60 + local.minute);
  const zone = timeZone === 'UTC' ? 'UTC' : zoneLabel(timeZone);
  const unixTime = Math.floor(startsAt.getTime() / 1000);
  return {
    start: { unixTime, format: 'wDt', fallback: `${dateLabel(local.toPlainDate())}, ${time} (${zone})` },
    in: { unixTime, format: 'r', fallback: `о ${time} (${zone})` },
    at: { unixTime, format: 't', fallback: `${time} (${zone})` },
  };
}

/** Where to watch a stream, at the end of its posts */
function watchLink(event: Pick<CrowEvent, 'url'>): PostLink {
  const url = new URL(event.url);
  return { label: url.hostname.replace(/^www\./, ''), url: url.href };
}

/**
 * What a stream's post shows besides its text, sent or edited: its start from the stream's row, in the chat's zone,
 * so a stream that moved shows its new start, and where to watch it
 */
export function streamContent(
  event: Pick<CrowEvent, 'url' | 'startsAt'>,
  timeZone: string,
): Pick<PostContent, 'moments' | 'links' | 'linksLabel'> {
  return { moments: streamMoments(event.startsAt, timeZone), links: [watchLink(event)], linksLabel: '📺 Дивитися:' };
}

export type EventPostKind = 'event' | 'reminder' | 'night';

/** A stream as the crow handles it */
type StreamEvent = Pick<CrowEvent, 'id' | 'title' | 'categories' | 'url' | 'startsAt' | 'sources' | 'texts' | 'videoId' | 'checkedAt'>;

/**
 * A stream's text as a post of `kind` shows it: the announcement the day and time
 * with how far off, the reminder how soon, the night reminder the time
 */
export function eventText(texts: CrowEventTexts, kind: EventPostKind): string {
  if (kind === 'event') return texts.announcement.replace('{when:start}', '{when:start} ({when:in})');
  if (kind === 'reminder') return texts.reminder.replace('{when:start}', '{when:in}');
  return texts.nightReminder.replace('{when:start}', '{when:at}');
}

/** The start of the quiet hours that `at` falls into */
function quietStartBefore(at: Date, timeZone: string, quietFrom: number): Date {
  const local = localDate(at, timeZone);
  const today = localMoment(local, quietFrom, timeZone);
  return new Date(today <= at.getTime() ? today : localMoment(local.subtract({ days: 1 }), quietFrom, timeZone));
}

/**
 * When a chat hears a stream's reminder: half an hour before it — or, when that
 * falls into the chat's quiet hours, an hour before they begin, ahead of the
 * evening goodbye; null when that has passed
 */
export function reminderTime(
  startsAt: Date,
  chat: Pick<EventChat, 'timeZone' | 'quietFrom' | 'quietTo'>,
  now: Date,
): { night: boolean; notBefore: Date; expiresAt: Date } | null {
  const { timeZone } = chat;
  const at = new Date(startsAt.getTime() - REMINDER_BEFORE_MS);
  if (chat.quietFrom === null || !isQuiet(at, timeZone, chat.quietFrom, chat.quietTo)) {
    const expiresAt = new Date(startsAt.getTime() + REMINDER_LATE_MS);
    return expiresAt > now ? { night: false, notBefore: at, expiresAt } : null;
  }
  const quietStart = quietStartBefore(at, timeZone, chat.quietFrom);
  if (quietStart <= now) return null;
  return { night: true, notBefore: new Date(quietStart.getTime() - NIGHT_REMINDER_BEFORE_QUIET_MS), expiresAt: quietStart };
}

const whens = (text: string) => text.split('{when:start}').length - 1;

/** What is wrong with a stream's texts, in words the model gets back when it rewrites them */
export function streamTextsProblems(texts: StreamTextsResult, allowed: Set<string>): string[] {
  const problems: string[] = [];
  if (whens(texts.announcement) !== 1) problems.push('announcement: `{when:start}` має бути рівно один раз');
  if (whens(texts.reminder) > 1) problems.push('reminder: `{when:start}` — не більше одного разу');
  if (whens(texts.nightReminder) !== 1) problems.push('nightReminder: `{when:start}` має бути рівно один раз');
  problems.push(
    ...textProblems(texts.announcement, allowed, MAX_ANNOUNCEMENT_LENGTH).map((p) => `announcement: ${p}`),
    ...textProblems(texts.reminder, allowed, MAX_STREAM_REMINDER_LENGTH).map((p) => `reminder: ${p}`),
    ...textProblems(texts.nightReminder, allowed, MAX_STREAM_REMINDER_LENGTH).map((p) => `nightReminder: ${p}`),
  );
  return problems;
}

/** The texts of a stream when the model's still fail after the rewrite: plain, but they say what matters */
export function fallbackTexts(title: string): CrowEventTexts {
  return {
    announcement: `🐦‍⬛🐦‍⬛ Коти, ${title} — {when:start}. Я вже готую попкорн.`,
    reminder: `🐦‍⬛ Коти, ${title} починається {when:start}. Збираємось!`,
    nightReminder: `🐦‍⬛ Коти, ${title} буде, поки ви спатимете, — о {when:start}. Хто не спить — я з вами.`,
  };
}

/** Writes a stream's texts as the arcs are written: an attempt, the checks, one rewrite; the plain ones after that */
export async function writeStreamTexts(
  write: (request: StreamTextsRequest) => Promise<Priced<StreamTextsResult>>,
  request: StreamTextsRequest,
): Promise<{ texts: CrowEventTexts; written: boolean; attempts: Attempt[] }> {
  const allowed = allowedNumbers(request.title);
  const { value: texts, problems, attempts } = await writeChecked(
    write,
    request,
    (result): CrowEventTexts => ({
      announcement: crowPrefix(result.announcement.trim()).text,
      reminder: crowPrefix(result.reminder.trim()).text,
      nightReminder: crowPrefix(result.nightReminder.trim()).text,
    }),
    (texts) => streamTextsProblems(texts, allowed),
  );
  return problems.length === 0
    ? { texts, written: true, attempts }
    : { texts: fallbackTexts(request.title), written: false, attempts };
}

/** The model's calls about streams: reading an announcement, and the crow's words */
export interface EventWriters {
  extract: (published: Date, text: string) => Promise<Priced<StreamResult>>;
  texts: (request: StreamTextsRequest) => Promise<Priced<StreamTextsResult>>;
}

/** Telegram's side of a stream that moved or was called off: its announcements sent already are edited */
export interface EventEditor {
  /** Replaces a sent announcement, with «Кш!» under it when it is still the chat's latest post */
  edit(chatId: string, messageId: number, postId: number, message: InputRichMessage, withShoo: boolean): Promise<void>;
}

/**
 * The streams the crow announces (docs/crow/behavior.md#streams): a job per
 * source finds them — YouTube's schedule, and the organizers' announcements read
 * by the model — and the `streams` job checks YouTube's schedule again before
 * the start, writes the crow's words once for every chat, and plans each chat's
 * announcement and reminder. A stream that moves has its announcements edited
 * and its reminders moved; one that is called off, its announcements say so.
 */
export class CrowEvents {
  constructor(
    private readonly store: Pick<
      CrowStore,
      | 'findEvent'
      | 'upcomingEvents'
      | 'setEventTexts'
      | 'checkedEvent'
      | 'setEventStatus'
      | 'eventChats'
      | 'eventPosts'
      | 'planEventPosts'
      | 'moveEventPost'
      | 'cancelEventPosts'
      | 'latestShooMessage'
    >,
    private readonly sources: readonly StreamSource[],
    private readonly write: EventWriters,
    private readonly editor: EventEditor,
    /** The YouTube Data API key; without it the channels are not polled */
    private readonly youtubeKey: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  jobs(): CrowJobDefinition[] {
    const polled = this.sources.filter((source) => source.kind !== 'youtube' || this.youtubeKey);
    return [...polled.map((source) => this.sourceJob(source)), this.streamsJob()];
  }

  private sourceJob(source: StreamSource): CrowJobDefinition {
    return {
      name: `stream:${source.id}`,
      nextRun: (startedAt) => new Date(startedAt.getTime() + source.intervalMs),
      run: async (state) => {
        if (source.kind === 'youtube') return this.pollYouTube(source, state);
        if (source.kind === 'feed') return this.pollFeed(source, state);
        return this.pollRedirect(source, state);
      },
    };
  }

  /** New videos of a channel are looked up once: a live stream that is still ahead is a stream to announce */
  private async pollYouTube(source: Extract<StreamSource, { kind: 'youtube' }>, state: JobState): Promise<JobState> {
    const seen = new Set((state.seen as string[] | undefined) ?? []);
    const ids = (await youtubeUploads(source.channelId, this.youtubeKey)).filter((id) => !seen.has(id));
    if (ids.length === 0) return state;
    const now = this.clock();
    for (const video of await youtubeVideos(ids, this.youtubeKey)) {
      if (video.broadcast !== 'upcoming' || !video.isLive || !video.scheduledStart) continue;
      if (source.accept && !source.accept(video.title)) continue;
      const url = `https://www.youtube.com/watch?v=${video.videoId}`;
      await this.found(
        {
          key: `youtube:${video.videoId}`,
          title: video.title,
          categories: source.categories,
          url,
          startsAt: video.scheduledStart,
          videoId: video.videoId,
          source: {
            kind: 'youtube',
            name: source.name,
            url,
            startsAt: video.scheduledStart.toISOString(),
          },
        },
        source,
        now,
      );
    }
    return { ...state, seen: [...seen, ...ids].slice(-SEEN_KEPT) };
  }

  /** An organizer's blog: a fresh entry that may announce a stream is read by the model for its start */
  private async pollFeed(source: Extract<StreamSource, { kind: 'feed' }>, state: JobState): Promise<JobState> {
    const fetched = await fetchText(source.url, {}, BROWSER_HEADERS);
    if (fetched.notModified) return state;
    const now = this.clock();
    const seen = new Set((state.seen as string[] | undefined) ?? []);
    const fresh = parseFeed(fetched.body).filter(
      (item) =>
        !seen.has(item.key) &&
        item.url !== null &&
        (item.publishedAt === null || now.getTime() - item.publishedAt.getTime() < ANNOUNCEMENT_MAX_AGE_MS),
    );
    for (const item of fresh) {
      if (!source.mayAnnounce(item)) continue;
      const text = `${item.title}\n\n${clip(item.summary, PAGE_TEXT_MAX)}`;
      await this.read(source, item.url!, item.url!, item.publishedAt ?? now, text, now);
    }
    return { ...state, seen: [...seen, ...fresh.map((item) => item.key)].slice(-SEEN_KEPT) };
  }

  /** A page that points at the current stream, Nintendo's Direct: a new target is a new stream, read by the model */
  private async pollRedirect(source: Extract<StreamSource, { kind: 'redirect' }>, state: JobState): Promise<JobState> {
    const target = await redirectTarget(source.url);
    if (!target || target === state.target) return state;
    const page = await fetchText(target, {}, BROWSER_HEADERS);
    if (page.notModified) return state;
    const now = this.clock();
    const text = [
      metaContent(page.body, 'og:title'),
      metaContent(page.body, 'og:description') ?? metaContent(page.body, 'description'),
      `URL: ${target}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.read(source, target, target, now, clip(text || htmlToText(page.body), PAGE_TEXT_MAX), now);
    return { ...state, target };
  }

  /** The model reads an announcement; a stream still ahead, with its time and zone, is found */
  private async read(source: StreamSource, key: string, url: string, published: Date, text: string, now: Date) {
    const { result, costUsd } = await this.write.extract(published, text);
    const startsAt = announcedStart(result);
    const read = startsAt ? `«${result.title}» at ${startsAt.toISOString()}` : 'no stream ahead';
    console.log(`${LOG_PREFIX} Stream source ${source.id}: ${key} — ${read} ($${costUsd.toFixed(4)})`);
    if (!startsAt) return;
    await this.found(
      {
        key,
        title: result.title.trim() || source.name,
        categories: source.categories,
        url,
        startsAt,
        videoId: null,
        source: { kind: 'page', name: source.name, url, startsAt: startsAt.toISOString() },
      },
      source,
      now,
    );
  }

  /**
   * A stream a source told of: kept if it is ahead and not a placeholder, joined to the stream another
   * source told of, and moved when YouTube's start differs from what the chats were told
   */
  private async found(event: FoundEvent, source: StreamSource, now: Date) {
    if (event.startsAt <= now || event.startsAt.getTime() - now.getTime() > MAX_AHEAD_MS) return;
    const { stored, created, previousStart } = await this.store.findEvent(event, SAME_STREAM_MS);
    if (created) {
      console.log(`${LOG_PREFIX} Stream ${stored.id} «${stored.title}» found by ${source.id}: ${stored.startsAt.toISOString()}`);
    } else if (previousStart && previousStart.getTime() !== stored.startsAt.getTime()) {
      await this.moved(stored, previousStart, now);
    }
  }

  private streamsJob(): CrowJobDefinition {
    return {
      name: 'streams',
      nextRun: (startedAt) => new Date(startedAt.getTime() + EVENTS_INTERVAL_MS),
      run: async () => {
        const now = this.clock();
        if (this.youtubeKey) await this.recheck(now);
        for (const event of await this.store.upcomingEvents()) {
          if (event.startsAt.getTime() < now.getTime() - HOUR) {
            await this.store.setEventStatus(event.id, 'over');
            continue;
          }
          if (event.startsAt.getTime() - now.getTime() > ANNOUNCE_AHEAD_MS) continue;
          await this.announce(event, now).catch((e) => console.error(`${LOG_PREFIX} Stream ${event.id} failed:`, e));
        }
      },
    };
  }

  /** YouTube's schedule again: a moved start moves the chats' posts, a stream gone calls them off */
  private async recheck(now: Date) {
    const due = (await this.store.upcomingEvents()).filter((event) => {
      if (!event.videoId || event.startsAt <= now) return false;
      const every = event.startsAt.getTime() - now.getTime() < SOON_MS ? RECHECK_SOON_MS : RECHECK_MS;
      return !event.checkedAt || now.getTime() - event.checkedAt.getTime() >= every;
    });
    if (due.length === 0) return;
    const videos = new Map(
      (await youtubeVideos(due.map((event) => event.videoId!), this.youtubeKey)).map((video) => [video.videoId, video]),
    );
    for (const event of due) {
      const video = videos.get(event.videoId!);
      if (!video || video.broadcast === 'none' || !video.scheduledStart) {
        await this.cancelled(event);
        continue;
      }
      const start = video.scheduledStart;
      await this.store.checkedEvent(event.id, now, start);
      if (start.getTime() !== event.startsAt.getTime()) await this.moved({ ...event, startsAt: start }, event.startsAt, now);
    }
  }

  /** Writes the crow's words about the stream once, then plans them into every chat that has not got them */
  private async announce(event: StreamEvent, now: Date) {
    let texts = event.texts;
    if (!texts) {
      const written = await writeStreamTexts(this.write.texts, {
        title: event.title,
        organizer: event.sources[0]?.name ?? '',
        categoryName: categoriesLabel(event.categories, now),
      });
      const costUsd = attemptsCost(written.attempts);
      if (!written.written) {
        console.warn(
          `${LOG_PREFIX} Stream ${event.id}: the texts failed their checks, plain ones go instead:\n  ` +
            written.attempts.at(-1)!.problems.join('\n  '),
        );
      }
      texts = written.texts;
      await this.store.setEventTexts(event.id, texts);
      console.log(`${LOG_PREFIX} Stream ${event.id} «${event.title}»: texts written ($${costUsd.toFixed(4)})`);
    }
    const planned = new Set((await this.store.eventPosts(event.id)).map((post) => post.chatId));
    let chats = 0;
    for (const chat of await this.store.eventChats(event.categories)) {
      if (planned.has(chat.chatId)) continue;
      const posts: { kind: 'event' | 'reminder'; text: string; notBefore: Date; expiresAt: Date }[] = [];
      if (event.startsAt.getTime() - now.getTime() > ANNOUNCE_UNTIL_MS) {
        posts.push({
          kind: 'event',
          text: eventText(texts, 'event'),
          notBefore: now,
          expiresAt: new Date(event.startsAt.getTime() - ANNOUNCE_UNTIL_MS),
        });
      }
      const reminder = reminderTime(event.startsAt, chat, now);
      if (reminder) {
        posts.push({
          kind: 'reminder',
          text: eventText(texts, reminder.night ? 'night' : 'reminder'),
          notBefore: reminder.notBefore,
          expiresAt: reminder.expiresAt,
        });
      }
      if (posts.length === 0) continue;
      await this.store.planEventPosts(chat.chatId, event.id, posts);
      chats++;
    }
    if (chats > 0) console.log(`${LOG_PREFIX} Stream ${event.id} «${event.title}» planned in ${chats} chats`);
  }

  /**
   * The stream moved: the announcements sent already are edited — their moments come from its start — the
   * planned ones expire anew, and each reminder is planned again for the chat, by day or by night
   */
  private async moved(event: StreamEvent, previousStart: Date, now: Date) {
    console.log(
      `${LOG_PREFIX} Stream ${event.id} «${event.title}» moved: ${previousStart.toISOString()} → ${event.startsAt.toISOString()}`,
    );
    const chats = new Map((await this.store.eventChats(event.categories)).map((chat) => [chat.chatId, chat]));
    for (const post of await this.store.eventPosts(event.id)) {
      if (post.status === 'sent' && post.kind === 'event' && post.tgMessageId !== null) {
        await this.editAnnouncement(event, post, chats.get(post.chatId)?.timeZone ?? FALLBACK_TIME_ZONE, null);
        continue;
      }
      if (post.status !== 'planned') continue;
      if (post.kind === 'event') {
        await this.store.moveEventPost(post.id, {
          expiresAt: new Date(event.startsAt.getTime() - ANNOUNCE_UNTIL_MS),
        });
        continue;
      }
      const chat = chats.get(post.chatId);
      const reminder = chat ? reminderTime(event.startsAt, chat, now) : null;
      await this.store.moveEventPost(
        post.id,
        reminder && event.texts
          ? {
              text: eventText(event.texts, reminder.night ? 'night' : 'reminder'),
              notBefore: reminder.notBefore,
              expiresAt: reminder.expiresAt,
            }
          : { status: 'cancelled' },
      );
    }
  }

  /** The stream is gone: its posts still planned are called off, and its announcements sent already say so */
  private async cancelled(event: StreamEvent) {
    console.log(`${LOG_PREFIX} Stream ${event.id} «${event.title}» is gone from YouTube: called off`);
    await this.store.setEventStatus(event.id, 'cancelled');
    await this.store.cancelEventPosts(event.id);
    const chats = new Map((await this.store.eventChats(event.categories)).map((chat) => [chat.chatId, chat]));
    for (const post of await this.store.eventPosts(event.id)) {
      if (post.status === 'sent' && post.kind === 'event' && post.tgMessageId !== null) {
        const timeZone = chats.get(post.chatId)?.timeZone ?? FALLBACK_TIME_ZONE;
        await this.editAnnouncement(event, post, timeZone, '❌ UPD: ефір скасували.');
      }
    }
  }

  /** An announcement sent already, shown again with the stream's start as it is now, and a line added */
  private async editAnnouncement(event: StreamEvent, post: EventPost, timeZone: string, added: string | null) {
    const message = crowRichMessage({
      text: added ? `${post.text}\n${added}` : post.text,
      ...streamContent(event, timeZone),
    });
    const withShoo = (await this.store.latestShooMessage(post.chatId)) === post.tgMessageId;
    try {
      await this.editor.edit(post.chatId, post.tgMessageId!, post.id, message, withShoo);
    } catch (e) {
      const chat = getLinkChatId(Number(post.chatId));
      console.warn(`${LOG_PREFIX} Could not edit the announcement of stream ${event.id} in chat ${chat}:`, e);
    }
  }
}
