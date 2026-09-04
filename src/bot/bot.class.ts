import { setTimeout as sleep } from 'node:timers/promises';
import { session, Telegraf, TelegramError } from 'telegraf';
import { BotCommand } from 'telegraf/types';
import { DataSource } from 'typeorm';
import { Command } from './commands/command.class';
import { IBotContext } from './context/context.interface';
import { ConfigService } from '../config/config.service';
import { retry } from '../utils/retry.utils';
import { Semaphore } from '../utils/semaphore.utils';

/** Give up on a call that keeps hitting 429 after this many waits */
const MAX_RATE_LIMIT_RETRIES = 5;
const API_STATS_INTERVAL_MS = 60 * 1000;

/**
 * Telegram client errors (invalid token, malformed payload) will not fix
 * themselves, so retrying them is pointless. Server errors are worth another
 * attempt, and so is anything that is not a Telegram API response at all —
 * transport failures such as ETIMEDOUT. Rate limits (429) are already retried
 * one layer down, in the `callApi` wrapper, so they are not repeated here.
 */
const isTransientTelegramError = (error: unknown) => (error instanceof TelegramError ? error.code >= 500 : true);

export class Bot {
  private bot: Telegraf<IBotContext>;
  private commands: Command[] = [];
  private readonly updateSemaphore: Semaphore;
  private apiCallCounts = new Map<string, number>();
  private apiStatsTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.bot = new Telegraf<IBotContext>(this.configService.get('TG_TOKEN'), { handlerTimeout: Infinity });
    this.wrapCallApi();

    // Telegraf runs a whole getUpdates batch (up to 100 updates) through
    // Promise.all, so after downtime the backlog would mean dozens of
    // concurrent Whisper/CLIP runs and a burst of replies. Gate every update
    // through a semaphore before anything else sees it.
    this.updateSemaphore = new Semaphore(this.configService.get('TG_UPDATE_CONCURRENCY'));
    this.bot.use((_ctx, next) => {
      if (this.updateSemaphore.pending > 0 && this.updateSemaphore.pending % 50 === 0) {
        console.log(`Update queue: ${this.updateSemaphore.pending} waiting`);
      }
      return this.updateSemaphore.run(next);
    });
    this.bot.use(session());
  }

  /**
   * Every outgoing call — ctx.reply, ctx.react, getFileLink, getUpdates — goes
   * through `callApi`, which makes it the one place to handle rate limits and
   * to see the real outgoing rate. On 429 Telegram says how long to wait in
   * `retry_after`; sleeping here holds the caller's semaphore slot, so the
   * whole update queue pauses rather than piling more calls onto the limit.
   */
  private wrapCallApi() {
    const telegram = this.bot.telegram;
    const callApi = telegram.callApi.bind(telegram);
    telegram.callApi = async (method, payload, options) => {
      // getUpdates is long polling, not load — leave it out of the stats
      if (method !== 'getUpdates') this.apiCallCounts.set(method, (this.apiCallCounts.get(method) ?? 0) + 1);
      for (let attempt = 1; ; attempt++) {
        try {
          return await callApi(method, payload, options);
        } catch (e) {
          const retryAfter = e instanceof TelegramError && e.code === 429 ? e.parameters?.retry_after : undefined;
          if (retryAfter === undefined || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
          console.warn(`Telegram 429 on ${method} (attempt ${attempt}), waiting ${retryAfter}s`);
          await sleep(retryAfter * 1000);
        }
      }
    };
  }

  private logApiStats() {
    const entries = [...this.apiCallCounts];
    this.apiCallCounts.clear();
    if (entries.length === 0) return;
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const breakdown = entries
      .sort(([, a], [, b]) => b - a)
      .map(([method, count]) => `${method} ${count}`)
      .join(', ');
    console.log(`Telegram API: ${total} calls/min (${breakdown}), queue: ${this.updateSemaphore.pending}`);
  }

  registerCommands(
    commands: Array<{
      new (bot: Telegraf<IBotContext>, dataSource: DataSource, configService: ConfigService): Command;
    }>,
  ) {
    const botCommands: BotCommand[] = [];
    for (const Command of commands) {
      const commandEntity = new Command(this.bot, this.dataSource, this.configService);
      commandEntity.handle();
      this.commands.push(commandEntity);
      const { command, description } = commandEntity;
      if (command && description) {
        botCommands.push({ command, description });
      }
    }
    // Only fills the command menu in the Telegram UI — handlers are already
    // registered above, so this runs in the background: a transient network
    // failure must not delay or stop startup.
    retry(() => this.bot.telegram.setMyCommands(botCommands), {
      shouldRetry: isTransientTelegramError,
      onRetry: (e, attempt, nextDelayMs) =>
        console.warn(`setMyCommands failed (attempt ${attempt}), retrying in ${nextDelayMs} ms:`, e),
    }).catch((e) => console.error('Failed to set bot commands:', e));
  }

  start() {
    // Promise alive until bot stopped
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.bot.launch();
    this.apiStatsTimer = setInterval(() => this.logApiStats(), API_STATS_INTERVAL_MS).unref();
    console.log('Bot started');
  }

  async stop(reason?: string) {
    clearInterval(this.apiStatsTimer);
    for (const command of this.commands) {
      await command.dispose();
    }
    this.bot.stop(reason);
  }
}
