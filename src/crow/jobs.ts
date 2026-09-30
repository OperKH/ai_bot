import { getLinkChatId } from '../bot/telegramLinks';
import { isPassingError } from '../services/openai.service';
import { isSourceDown } from './sources/feed';

const LOG_PREFIX = '[Crow]';

/** What a job keeps between its runs, e.g. a feed's ETag */
export type JobState = Record<string, unknown>;

/**
 * A periodic job of the crow. The schedule is kept in `crow_job`, so after a
 * restart a job knows it missed its turn.
 */
export interface CrowJobDefinition {
  name: string;
  /** When the job runs next after a run that started at `startedAt` */
  nextRun(startedAt: Date): Date;
  /**
   * Whether a run that was due at `dueAt` still makes sense at `now`. After a
   * downtime a job runs once, not once per missed turn; one whose moment has
   * passed — a morning digest in the evening — skips to its next turn instead.
   */
  stillWorth?(dueAt: Date, now: Date): boolean;
  /** Returns the new state, or nothing to keep the old one */
  run(state: JobState): Promise<JobState | void>;
}

/**
 * Whether a run failed for a while — a source or OpenAI down, busy or out of reach — rather than for the bot: the job
 * only tries again at its next turn, and the log warns
 */
export function isPassingFailure(e: unknown): e is Error {
  return isSourceDown(e) || isPassingError(e);
}

export type JobAction = 'wait' | 'run' | 'skip';

export function jobAction(job: CrowJobDefinition, nextRunAt: Date, now: Date): JobAction {
  if (nextRunAt > now) return 'wait';
  return job.stillWorth && !job.stillWorth(nextRunAt, now) ? 'skip' : 'run';
}

/**
 * A job that gives each chat one try at its moment — the end of its night, its evening, Friday's digest, her
 * birthday — whatever came of it: a text that failed its checks is not written again. A moment tried is kept in
 * the job's state until `keepMs` after it.
 */
export function oncePerChat<Chat extends { chatId: string }, Moment>(job: {
  name: string;
  intervalMs: number;
  clock: () => Date;
  chats: () => Promise<Chat[]>;
  /** The chat's moment that `now` falls into, if any */
  moment: (chat: Chat, now: Date) => Moment | null;
  /** When a moment is, which its try is remembered by */
  at: (moment: Moment) => Date;
  keepMs: number;
  prepare: (chat: Chat, moment: Moment, now: Date) => Promise<void>;
  /** What failed, for the log, up to the chat: «Morning digest for chat» */
  failed: string;
}): CrowJobDefinition {
  return {
    name: job.name,
    nextRun: (startedAt) => new Date(startedAt.getTime() + job.intervalMs),
    run: async (state) => {
      const now = job.clock();
      const tried: Record<string, string> = { ...(state.tried as Record<string, string> | undefined) };
      for (const chat of await job.chats()) {
        const moment = job.moment(chat, now);
        if (moment === null) continue;
        const at = job.at(moment).toISOString();
        if (tried[chat.chatId] === at) continue;
        tried[chat.chatId] = at;
        await job
          .prepare(chat, moment, now)
          .catch((e) => console.error(`${LOG_PREFIX} ${job.failed} ${getLinkChatId(Number(chat.chatId))} failed:`, e));
      }
      for (const [chatId, at] of Object.entries(tried)) {
        if (new Date(at).getTime() + job.keepMs < now.getTime()) delete tried[chatId];
      }
      return { ...state, tried };
    },
  };
}
