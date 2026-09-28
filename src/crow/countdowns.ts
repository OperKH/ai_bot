import { getLinkChatId } from '../bot/telegramLinks';
import { allowedNumbers, textProblems, writeText } from './arcValidation';
import { type CategoryId, GTA6_RELEASE_DAY } from './categories';
import { endOfDay, isQuiet, localDate, localMoment } from './chatClock';
import type { PostContent } from './crowMessage';
import type { Priced } from './crowLlm';
import type { CrowJobDefinition } from './jobs';
import type { CountdownRequest, TalkResult } from './prompts';
import type { CrowStore } from './store';
import { daysLabel } from './words';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LOG_PREFIX = '[Crow]';
export const MAX_COUNTDOWN_LENGTH = 400;
const COUNTDOWN_INTERVAL_MS = 30 * MINUTE;
/** A mark's post is planned this long before its minute, so the scheduler sends it at the minute, not at the job's turn */
const PLAN_AHEAD_MS = 60 * MINUTE;
/** The news of a countdown's game its posts may tell of: its stories of this long, the latest first */
const NEWS_WINDOW_MS = 14 * DAY;
const NEWS_STORIES = 4;
const NEWS_FACTS = 4;

/**
 * A game the crow counts down to (docs/crow/behavior.md#countdowns): which chats hear its countdown, which news
 * feed it, and whether her arcs of it end with how long is left. A new countdown is an entry here, not code.
 */
export interface Countdown {
  id: string;
  /** As the posts name it */
  game: string;
  /** The release day, `YYYY-MM-DD`: every chat counts the days to it in its own zone */
  day: string;
  /** The chats of these categories hear its countdown */
  categories: CategoryId[];
  /** The stories its posts take a fresh fact from: of these categories, and whose title names it, if `match` is set */
  news: { categories: CategoryId[]; match?: RegExp };
  /** The posts of the arcs of these categories end with how long is left until the release */
  lineCategories?: CategoryId[];
}

export const COUNTDOWNS: readonly Countdown[] = [
  {
    id: 'gta6',
    game: 'GTA VI',
    day: GTA6_RELEASE_DAY,
    categories: ['gta6'],
    news: { categories: ['gta6'] },
    lineCategories: ['gta6'],
  },
];

/**
 * The days a countdown speaks on: the Fibonacci numbers, closer as the day comes — one post a mark, and the day
 * before the release two, since the series has 1 twice. Every day would be the same number over and over.
 */
export const COUNTDOWN_MARKS: readonly number[] = [55, 34, 21, 13, 8, 5, 3, 2, 1];

/** The times of day of a mark's posts in the chat's zone: the day before the release twice, morning and evening */
export function markSlots(days: number): { slot: CountdownRequest['slot']; hour: number; minute: number }[] {
  return days === 1
    ? [
        { slot: 'morning', hour: 11, minute: 11 },
        { slot: 'evening', hour: 19, minute: 37 },
      ]
    : [{ slot: 'day', hour: 11, minute: 11 }];
}

/** How many days are left until a release day in the chat's zone: its calendar days, not 24-hour spans */
export function daysTo(day: string, now: Date, timeZone: string): number {
  return localDate(now, timeZone).until(Temporal.PlainDate.from(day)).days;
}


/**
 * A post of an arc with the countdown under it — «⏳ До релізу — 52 дні», the days of the chat's zone — while a
 * countdown of its categories is ahead; any other post as it is
 */
export function withReleaseLine(content: PostContent, categories: readonly string[], now: Date, timeZone: string): PostContent {
  const countdown = COUNTDOWNS.find((c) => c.lineCategories?.some((id) => categories.includes(id)));
  const days = countdown ? daysTo(countdown.day, now, timeZone) : 0;
  return countdown && days > 0 ? { ...content, text: `${content.text}\n⏳ До релізу — ${daysLabel(days)}` } : content;
}

/** What is wrong with a countdown post: the number of days said before the release, and the arcs' checks */
export function countdownProblems(text: string, days: number, allowed: Set<string>): string[] {
  return [
    ...(days > 1 && !text.includes(String(days)) ? [`у тексті має бути, скільки днів лишилося: ${days}`] : []),
    ...textProblems(text, allowed, MAX_COUNTDOWN_LENGTH),
  ];
}

type CountdownStore = Pick<CrowStore, 'eventChats' | 'recentStories' | 'planCountdown'>;

/**
 * The countdowns (docs/crow/behavior.md#countdowns): on a mark, a post in each chat that hears the game, at its
 * times of the chat's day, with a fresh fact of its news. One text a mark and a slot for every chat, written by the
 * talk model and checked as an arc message is; one that fails after its rewrite leaves the slot without a post.
 */
export class Countdowns {
  constructor(
    private readonly store: CountdownStore,
    private readonly write: (request: CountdownRequest) => Promise<Priced<TalkResult>>,
    private readonly countdowns: readonly Countdown[] = COUNTDOWNS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return {
      name: 'countdowns',
      nextRun: (startedAt) => new Date(startedAt.getTime() + COUNTDOWN_INTERVAL_MS),
      run: async (state) => {
        const now = this.clock();
        const texts: Record<string, string | null> = { ...(state.texts as Record<string, string | null> | undefined) };
        const told: Record<string, true> = { ...(state.told as Record<string, true> | undefined) };
        for (const countdown of this.countdowns) {
          if (daysTo(countdown.day, now, 'UTC') < -1) continue;
          for (const chat of await this.store.eventChats(countdown.categories)) {
            const { timeZone } = chat;
            const days = daysTo(countdown.day, now, timeZone);
            if (!COUNTDOWN_MARKS.includes(days)) continue;
            const today = localDate(now, timeZone);
            const slots = markSlots(days).map((s) => ({
              ...s,
              at: new Date(localMoment(today, s.hour * 60 + s.minute, timeZone)),
            }));
            // The latest slot whose planning has come: a chat that was quiet then gets it once it is not
            const slot = slots.filter((s) => now.getTime() >= s.at.getTime() - PLAN_AHEAD_MS).at(-1);
            if (!slot || isQuiet(now, timeZone, chat.quietFrom, chat.quietTo)) continue;
            const key = `${countdown.id}:${days}:${slot.slot}`;
            if (told[`${key}:${chat.chatId}`]) continue;
            told[`${key}:${chat.chatId}`] = true;
            if (!(key in texts)) texts[key] = await this.text(countdown, days, slot.slot, Object.values(texts), now);
            const text = texts[key];
            if (!text) continue;
            await this.store.planCountdown(chat.chatId, {
              text,
              extras: null,
              notBefore: slot.at > now ? slot.at : now,
              expiresAt: endOfDay(now, timeZone),
            });
            console.log(`${LOG_PREFIX} Countdown of ${countdown.game}, ${days} days (${slot.slot}), planned in chat ${getLinkChatId(Number(chat.chatId))}`);
          }
        }
        return { ...state, texts, told: forgetOld(told, this.countdowns, now) };
      },
    };
  }

  /** The text of a mark's slot for every chat, or null when it failed its checks after the rewrite */
  private async text(countdown: Countdown, days: number, slot: CountdownRequest['slot'], previous: (string | null)[], now: Date) {
    const stories = await this.store.recentStories(countdown.news.categories, new Date(now.getTime() - NEWS_WINDOW_MS), NEWS_STORIES * 3);
    const news = stories
      .filter((story) => !countdown.news.match || countdown.news.match.test(story.title))
      .slice(0, NEWS_STORIES)
      .map((story) => ({ title: story.title, facts: story.facts.slice(0, NEWS_FACTS) }));
    const request: CountdownRequest = {
      game: countdown.game,
      days,
      slot,
      news,
      previous: previous.filter((text) => text !== null),
      maxLength: MAX_COUNTDOWN_LENGTH,
    };
    const allowed = allowedNumbers(String(days), countdown.game, ...news.flatMap((story) => [story.title, ...story.facts.map((fact) => fact.text)]));
    const { text, attempts } = await writeText(this.write, request, (post) => countdownProblems(post, days, allowed));
    if (text === null) {
      const problems = attempts.at(-1)!.problems;
      console.warn(`${LOG_PREFIX} Countdown of ${countdown.game}, ${days} days, failed its checks:\n  ${problems.join('\n  ')}`);
    }
    return text;
  }
}

/** The chats told of a countdown that is over are forgotten */
function forgetOld(told: Record<string, true>, countdowns: readonly Countdown[], now: Date): Record<string, true> {
  const live = new Set(countdowns.filter((c) => daysTo(c.day, now, 'UTC') >= -1).map((c) => c.id));
  return Object.fromEntries(Object.entries(told).filter(([key]) => live.has(key.split(':')[0])));
}
