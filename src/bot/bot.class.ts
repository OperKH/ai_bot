import { setTimeout as sleep } from 'node:timers/promises';
import { Bot as GrammyBot, GrammyError } from 'grammy';
import type { BotCommand } from 'grammy/types';
import { DataSource } from 'typeorm';
import { ApiCallMonitor, installApiTransformers } from './apiTransformers';
import { Command } from './commands/command.class';
import type { BotApi, BotContext, TelegramBot } from './context/context.interface';
import { UpdateQueue } from './updateQueue';
import { ConfigService } from '../config/config.service';
import { retry } from '../utils/retry.utils';

const API_STATS_INTERVAL_MS = 60 * 1000;

/**
 * How long a stop waits for the work in progress — updates and background work
 * such as a transcription; keep it under docker-compose's stop_grace_period
 */
const STOP_TIMEOUT_MS = 25 * 1000;

/**
 * Telegram client errors (invalid token, malformed payload) will not fix
 * themselves, so retrying them is pointless. Server errors are worth another
 * attempt, and so is anything that is not a Telegram API response at all —
 * transport failures such as ETIMEDOUT. Rate limits (429) are already retried
 * one layer down, in the API transformers, so they are not repeated here.
 */
const isTransientTelegramError = (error: unknown) => (error instanceof GrammyError ? error.error_code >= 500 : true);

/**
 * Tells the chat that what the user asked for failed. For `bot.catch` and for
 * work a handler handed over to the background, where `bot.catch` cannot reach.
 * Failing to say so is only logged.
 */
export function apologize(ctx: BotContext) {
  ctx.reply('😵 Щось пішло не так, спробуй ще раз').catch((e) => console.error('Failed to report the error:', e));
}

export class Bot {
  private bot: TelegramBot;
  private commands: Command[] = [];
  private readonly apiMonitor = new ApiCallMonitor();
  private readonly updates: UpdateQueue;
  private apiStatsTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    const token = this.configService.get('TG_TOKEN');
    this.bot = new GrammyBot<BotContext, BotApi>(token);
    installApiTransformers(this.bot.api, token, this.apiMonitor);
    this.updates = new UpdateQueue(this.bot, this.configService.get('TG_UPDATE_CONCURRENCY'));
    this.catchHandlerErrors();
  }

  /**
   * The runner hands a failed update to `bot.catch` and carries on with the
   * rest; without a handler the error would land in the log under the runner's
   * "::: ERROR ERROR ERROR :::" banner.
   *
   * Only work the user actually asked for gets an apology in the chat. Most
   * updates are handled passively (every text message goes through toxicity
   * analysis), and a systemic failure over a 100-update backlog would answer
   * with 100 messages — enough to hit the chat rate limit, and waiting that out
   * stalls the real queue.
   */
  private catchHandlerErrors() {
    this.bot.catch(({ error, ctx }) => {
      const updateType = Object.keys(ctx.update).find((key) => key !== 'update_id');
      console.error(`Update ${ctx.update.update_id} (${updateType}) failed:`, error);
      const isRequested = !!ctx.callbackQuery || !!ctx.message?.text?.startsWith('/');
      if (isRequested) apologize(ctx);
    });
  }

  private logApiStats() {
    const entries = this.apiMonitor.take();
    if (entries.length === 0) return;
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const breakdown = entries
      .sort(([, a], [, b]) => b - a)
      .map(([method, count]) => `${method} ${count}`)
      .join(', ');
    console.log(`Telegram API: ${total} calls/min (${breakdown}), queue: ${this.updates.waiting}`);
  }

  registerCommands(
    commands: Array<{
      new (bot: TelegramBot, dataSource: DataSource, configService: ConfigService): Command;
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
    retry(() => this.bot.api.setMyCommands(botCommands), {
      shouldRetry: isTransientTelegramError,
      onRetry: (e, attempt, nextDelayMs) =>
        console.warn(`setMyCommands failed (attempt ${attempt}), retrying in ${nextDelayMs} ms:`, e),
    }).catch((e) => console.error('Failed to set bot commands:', e));
  }

  /** Starts long polling; see `UpdateQueue.start` for when the promise settles */
  start(): Promise<void> {
    const polling = this.updates.start(this.bot);
    this.apiStatsTimer = setInterval(() => this.logApiStats(), API_STATS_INTERVAL_MS).unref();
    console.log('Bot started');
    return polling;
  }

  /**
   * Stops fetching and lets the work in progress finish: first the updates, then
   * the commands are disposed, which lets their background work finish too (a
   * running transcription). All of it gets STOP_TIMEOUT_MS together, then the
   * shutdown goes on without it. The AI models go after this, released once by
   * the caller, so none is released under running work unless time ran out.
   */
  async stop() {
    const finished = this.finishWork().then(() => true);
    if (!(await Promise.race([finished, sleep(STOP_TIMEOUT_MS, false, { ref: false })]))) {
      console.warn(`Stopping with work unfinished (${this.updates.size} updates in progress)`);
    }
    clearInterval(this.apiStatsTimer);
  }

  /** A command that fails to dispose is logged and the rest still are: the shutdown has to go on */
  private async finishWork() {
    await this.updates.stop();
    for (const command of this.commands) {
      try {
        await command.dispose();
      } catch (e) {
        console.error(`Failed to dispose ${command.constructor.name}:`, e);
      }
    }
  }
}
