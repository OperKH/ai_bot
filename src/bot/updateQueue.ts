import { setTimeout as sleep } from 'node:timers/promises';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
import { API_CONSTANTS } from 'grammy';
import type { TelegramBot } from './context/context.interface';

/** The update types the bot asks for */
const ALLOWED_UPDATES = API_CONSTANTS.DEFAULT_UPDATE_TYPES;

/**
 * How many fetched updates the runner holds at most — one getUpdates batch, as
 * with Telegraf. Telegram counts a fetched update as delivered, so whatever has
 * not started when the bot stops is lost; the runner's default would hold 500.
 */
const MAX_FETCHED_UPDATES = 100;

/**
 * How the bot takes updates in: long polling through `@grammyjs/runner`, updates
 * of one chat in order, and at most `concurrency` handled at a time.
 *
 * The runner hands every update of a getUpdates batch (up to 100) to the
 * middleware at once — its concurrency setting only sizes the next fetch — so
 * after downtime the backlog would mean dozens of concurrent Whisper/CLIP runs
 * and a burst of replies. The slots cap how many run at a time. Updates of one
 * chat line up in order before them: one waiting for its chat's turn must not
 * hold a slot another chat could use.
 */
export class UpdateQueue {
  private readonly slots: Slots;
  private runner?: RunnerHandle;
  private stopping = false;
  /** Updates fetched but not started: waiting for their chat's turn or for a slot */
  private waitingCount = 0;

  /** Installs the queue as the bot's first middleware, so it goes before any handler */
  constructor(bot: TelegramBot, concurrency: number) {
    this.slots = new Slots(concurrency);
    bot.use((_ctx, next) => {
      this.waitingCount++;
      if (this.waitingCount % 50 === 0) console.log(`Update queue: ${this.waitingCount} waiting`);
      return next();
    });
    bot.use(sequentialize((ctx) => ctx.chatId?.toString()));
    bot.use((_ctx, next) =>
      this.slots.run(() => {
        this.waitingCount--;
        // A stopping queue drops what has not started: it would not finish in time
        return this.stopping ? Promise.resolve() : next();
      }),
    );
  }

  /** Updates fetched but not started yet */
  get waiting(): number {
    return this.waitingCount;
  }

  /**
   * Starts long polling. The promise settles when polling ends: it resolves
   * after `stop()` and rejects when polling cannot go on — a revoked token
   * (401), another instance polling with the same token (409).
   */
  start(bot: TelegramBot): Promise<void> {
    this.runner = run(bot, {
      runner: { fetch: { allowed_updates: ALLOWED_UPDATES } },
      sink: { concurrency: MAX_FETCHED_UPDATES },
    });
    return this.runner.task() ?? Promise.resolve();
  }

  /**
   * Stops fetching, drops the updates that have not started and resolves once
   * the ones in progress are done. `runner.stop()` alone does not wait for them.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([this.runner?.stop(), this.untilEmpty()]);
  }

  /** Updates the runner still holds, running or waiting; for logs when a stop runs out of time */
  get size(): number {
    return this.runner?.size() ?? 0;
  }

  private async untilEmpty() {
    while (this.size > 0) await sleep(100, undefined, { ref: false });
  }
}

/** At most `limit` callers hold a slot at once, the rest wait in FIFO order */
class Slots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Slot limit must be a positive integer, got ${limit}`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * The slot is handed straight to the next waiter instead of being freed and
   * re-acquired — otherwise a newcomer could slip in between and push the
   * number of active tasks past the limit.
   */
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
