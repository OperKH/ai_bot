import { getLinkChatId } from '../bot/telegramLinks';
import { allowedNumbers, attemptsCost, textProblems, writeText, type WrittenText } from './arcValidation';
import { categoriesLabel, type Importance } from './categories';
import { localDate, localMoment } from './chatClock';
import type { Priced } from './crowLlm';
import { type CrowJobDefinition, oncePerChat } from './jobs';
import type { MorningRequest, TalkResult } from './prompts';
import type { CrowStore, WaitingNews } from './store';
import { memoryLine } from './words';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The digest is written this long before the quiet hours end, so it is there when they do */
export const MORNING_LEAD_MS = 15 * MINUTE;
/** After a downtime a digest is still made this long after the quiet hours ended */
export const MORNING_GRACE_MS = 2 * HOUR;
/** One piece of news is not a digest: it goes as it is */
export const MIN_DIGEST_STORIES = 2;
/** More would make a wall of text; the rest go one by one after the digest */
export const MAX_DIGEST_STORIES = 6;
const MAX_DIGEST_LENGTH = 1500;
/** A digest waits this long for a chat that keeps the crow quiet in the morning */
const DIGEST_TTL_MS = 12 * HOUR;
const MORNING_INTERVAL_MS = 5 * MINUTE;
/** The crow's latest posts in the chat that the digest's prompt gets, not to repeat itself */
const MEMORY_POSTS = 10;
const OPENING_FACTS = 3;

/**
 * The end of the chat's quiet hours that `now` is near — from `MORNING_LEAD_MS`
 * before it to `MORNING_GRACE_MS` after — in the chat's zone, or null. Quiet
 * hours may cross midnight, and a change of time moves nothing by an hour.
 */
export function morningEnd(now: Date, timeZone: string, quietFrom: number | null, quietTo: number | null): Date | null {
  if (quietFrom === null || quietTo === null || quietFrom === quietTo) return null;
  const today = localDate(now, timeZone);
  for (const days of [-1, 0, 1]) {
    const end = localMoment(today.add({ days }), quietTo, timeZone);
    if (now.getTime() >= end - MORNING_LEAD_MS && now.getTime() < end + MORNING_GRACE_MS) return new Date(end);
  }
  return null;
}

/** The news the digest tells, the most important first; null when there is too little for a digest */
export function digestNews<T extends Pick<WaitingNews, 'importance' | 'notBefore'>>(waiting: T[]): T[] | null {
  if (waiting.length < MIN_DIGEST_STORIES) return null;
  return [...waiting]
    .sort((a, b) => b.importance - a.importance || a.notBefore.getTime() - b.notBefore.getTime())
    .slice(0, MAX_DIGEST_STORIES);
}

/** What is wrong with a digest, in words the model gets back when it rewrites it */
export function digestProblems(text: string, stories: number, allowed: Set<string>): string[] {
  const bullets = text.split('\n').filter((line) => line.trimStart().startsWith('•')).length;
  return [
    ...(bullets === stories ? [] : [`пунктів «• » має бути рівно ${stories}, а не ${bullets}`]),
    ...textProblems(text, allowed, MAX_DIGEST_LENGTH),
  ];
}

/** Writes a digest as the arcs are written: an attempt, the checks, one rewrite with the problems listed */
export function writeDigest(
  write: (request: MorningRequest) => Promise<Priced<TalkResult>>,
  request: MorningRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => digestProblems(text, request.stories.length, allowed));
}

/**
 * The morning digest (docs/crow/behavior.md#the-morning-digest): the news that
 * came while a chat slept goes out as one post when its quiet hours end, instead
 * of a pile of openings. It is written a little before the end, so the dispatcher
 * finds it waiting, and the openings it tells share its fate.
 */
export class MorningDigests {
  constructor(
    private readonly store: Pick<
      CrowStore,
      'quietChats' | 'plannedSince' | 'waitingNews' | 'recentPosts' | 'createDigest'
    >,
    private readonly write: (request: MorningRequest) => Promise<Priced<TalkResult>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return oncePerChat({
      name: 'morning',
      intervalMs: MORNING_INTERVAL_MS,
      clock: this.clock,
      chats: () => this.store.quietChats(),
      moment: (chat, now) => morningEnd(now, chat.timeZone, chat.quietFrom, chat.quietTo),
      at: (end) => end,
      keepMs: MORNING_GRACE_MS,
      prepare: (chat, end, now) => this.prepare(chat.chatId, end, now),
      failed: 'Morning digest for chat',
    });
  }

  /** Writes the chat's digest if two or more stories wait for the morning */
  private async prepare(chatId: string, end: Date, now: Date) {
    if (await this.store.plannedSince(chatId, 'digest', new Date(end.getTime() - MORNING_LEAD_MS))) return;
    // Before the end, the news due by the end; after a downtime, what is due now
    const news = digestNews(await this.store.waitingNews(chatId, now < end ? end : now, now));
    if (!news) return;

    const recentPosts = (await this.store.recentPosts(chatId, MEMORY_POSTS)).map((post) => memoryLine(post, now));
    const request: MorningRequest = {
      stories: news.map((item) => {
        const told = item.facts.filter((fact) => item.factIds.includes(fact.id));
        return {
          title: item.title,
          categoryName: categoriesLabel(item.categories, now),
          importance: item.importance,
          facts: told.length > 0 ? told : item.facts.slice(0, OPENING_FACTS),
          opening: item.opening,
        };
      }),
      recentPosts,
      maxLength: MAX_DIGEST_LENGTH,
    };
    const allowed = allowedNumbers(
      ...request.stories.flatMap((story) => [story.title, story.opening, ...story.facts.map((fact) => fact.text)]),
      ...recentPosts,
    );
    const digest = await writeDigest(this.write, request, allowed);
    const costUsd = attemptsCost(digest.attempts);
    const chat = getLinkChatId(Number(chatId));
    if (digest.text === null) {
      console.warn(
        `${LOG_PREFIX} The morning digest for chat ${chat} failed its checks, the news goes one by one:\n  ` +
          digest.attempts.at(-1)!.problems.join('\n  '),
      );
      return;
    }
    const notBefore = now < end ? end : now;
    const id = await this.store.createDigest(
      chatId,
      {
        text: digest.text,
        importance: Math.max(...news.map((item) => item.importance)) as Importance,
        notBefore,
        expiresAt: new Date(notBefore.getTime() + DIGEST_TTL_MS),
      },
      news.map((item) => item.postId),
    );
    if (id === null) {
      console.warn(`${LOG_PREFIX} The morning digest for chat ${chat} is dropped: its news went out meanwhile`);
      return;
    }
    console.log(
      `${LOG_PREFIX} Morning digest ${id} of ${news.length} stories planned in chat ${chat} ($${costUsd.toFixed(4)})`,
    );
  }
}
