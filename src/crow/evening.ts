import { getLinkChatId } from '../bot/telegramLinks';
import { allowedNumbers, attemptsCost, textProblems, writeText, type WrittenText } from './arcValidation';
import { localDate, localMoment } from './chatClock';
import type { Priced } from './crowLlm';
import { type CrowJobDefinition, oncePerChat } from './jobs';
import type { GoodbyeRequest, TalkResult } from './prompts';
import type { CrowStore } from './store';
import { memoryLine } from './words';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;

/** The goodbye goes this long before the quiet hours begin; after it the crow keeps quiet till then */
export const GOODBYE_BEFORE_QUIET_MS = 20 * MINUTE;
/** It is written within this long before it is due, so the dispatcher finds it waiting */
const GOODBYE_LEAD_MS = 15 * MINUTE;
/** A day with fewer posts than this is not worth a goodbye */
export const MIN_POSTS_FOR_GOODBYE = 2;
const MAX_GOODBYE_LENGTH = 400;
const EVENING_INTERVAL_MS = 5 * MINUTE;
/** Today's posts the goodbye's prompt gets */
const DAY_POSTS = 15;
const PREVIOUS_GOODBYES = 3;

/** The chat's evening: when its quiet hours begin, and when its day began — at the end of the last quiet hours */
export interface Evening {
  quietStart: Date;
  dayStart: Date;
}

/**
 * The evening `now` is in: from `GOODBYE_LEAD_MS` before the goodbye is due up to
 * the start of the quiet hours, in the chat's zone — or null. The day began when
 * the quiet hours before ended; the quiet hours may cross midnight either way.
 */
export function eveningAt(
  now: Date,
  timeZone: string,
  quietFrom: number | null,
  quietTo: number | null,
): Evening | null {
  if (quietFrom === null || quietTo === null || quietFrom === quietTo) return null;
  const today = localDate(now, timeZone);
  for (const days of [0, 1]) {
    const date = today.add({ days });
    const quietStart = localMoment(date, quietFrom, timeZone);
    const opens = quietStart - GOODBYE_BEFORE_QUIET_MS - GOODBYE_LEAD_MS;
    if (now.getTime() < opens || now.getTime() >= quietStart) continue;
    const endOfLastQuiet = localMoment(date, quietTo, timeZone);
    const dayStart =
      endOfLastQuiet < quietStart ? endOfLastQuiet : localMoment(date.subtract({ days: 1 }), quietTo, timeZone);
    return { quietStart: new Date(quietStart), dayStart: new Date(dayStart) };
  }
  return null;
}

/** What is wrong with a goodbye, in words the model gets back when it rewrites it */
export function goodbyeProblems(text: string, allowed: Set<string>): string[] {
  return textProblems(text, allowed, MAX_GOODBYE_LENGTH);
}

/** Writes a goodbye as the arcs are written: an attempt, the checks, one rewrite with the problems listed */
export function writeGoodbye(
  write: (request: GoodbyeRequest) => Promise<Priced<TalkResult>>,
  request: GoodbyeRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => goodbyeProblems(text, allowed));
}

/**
 * The crow's goodbye at the end of a chat's day (docs/crow/behavior.md#the-evening-goodbye):
 * once a day, shortly before the quiet hours, if she posted there at least twice
 * that day. It replaces the farewell each arc used to end with, which came
 * whenever the arc's last gap ran out — mostly right after the night. After it
 * the crow keeps quiet till the quiet hours: it is the day's last post.
 */
export class EveningGoodbyes {
  constructor(
    private readonly store: Pick<
      CrowStore,
      | 'quietChats'
      | 'plannedSince'
      | 'postsSince'
      | 'dayVerdicts'
      | 'continuingStories'
      | 'recentGoodbyes'
      | 'planGoodbye'
    >,
    private readonly write: (request: GoodbyeRequest) => Promise<Priced<TalkResult>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return oncePerChat({
      name: 'evening',
      intervalMs: EVENING_INTERVAL_MS,
      clock: this.clock,
      chats: () => this.store.quietChats(),
      moment: (chat, now) => eveningAt(now, chat.timeZone, chat.quietFrom, chat.quietTo),
      at: (evening) => evening.quietStart,
      keepMs: 0,
      prepare: (chat, evening, now) => this.prepare(chat.chatId, evening, now),
      failed: 'Evening goodbye for chat',
    });
  }

  private async prepare(chatId: string, evening: Evening, now: Date) {
    if (await this.store.plannedSince(chatId, 'goodbye', evening.dayStart)) return;
    const today = await this.store.postsSince(chatId, evening.dayStart, DAY_POSTS);
    if (today.length < MIN_POSTS_FOR_GOODBYE) return;

    const recentPosts = today.map((post) => memoryLine(post, now));
    const request: GoodbyeRequest = {
      recentPosts,
      verdicts: await this.store.dayVerdicts(chatId, evening.dayStart),
      continuing: await this.store.continuingStories(chatId),
      previousGoodbyes: await this.store.recentGoodbyes(chatId, PREVIOUS_GOODBYES),
      maxLength: MAX_GOODBYE_LENGTH,
    };
    const allowed = allowedNumbers(...recentPosts, ...request.verdicts, ...request.continuing);
    const goodbye = await writeGoodbye(this.write, request, allowed);
    const costUsd = attemptsCost(goodbye.attempts);
    const chat = getLinkChatId(Number(chatId));
    if (goodbye.text === null) {
      console.warn(
        `${LOG_PREFIX} The evening goodbye for chat ${chat} failed its checks, no goodbye tonight:\n  ` +
          goodbye.attempts.at(-1)!.problems.join('\n  '),
      );
      return;
    }
    const due = new Date(evening.quietStart.getTime() - GOODBYE_BEFORE_QUIET_MS);
    await this.store.planGoodbye(chatId, {
      text: goodbye.text,
      notBefore: now < due ? due : now,
      // A goodbye after the quiet hours began is not a goodbye: dropped
      expiresAt: evening.quietStart,
    });
    console.log(`${LOG_PREFIX} Evening goodbye planned in chat ${chat} ($${costUsd.toFixed(4)})`);
  }
}
