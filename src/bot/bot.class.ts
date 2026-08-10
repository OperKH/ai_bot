import { session, Telegraf, TelegramError } from 'telegraf';
import { BotCommand } from 'telegraf/types';
import { DataSource } from 'typeorm';
import { Command } from './commands/command.class';
import { IBotContext } from './context/context.interface';
import { ConfigService } from '../config/config.service';
import { retry } from '../utils/retry.utils';

/**
 * Telegram client errors (invalid token, malformed payload) will not fix
 * themselves, so retrying them is pointless. Rate limits and server errors
 * are worth another attempt, and so is anything that is not a Telegram API
 * response at all — transport failures such as ETIMEDOUT.
 */
const isTransientTelegramError = (error: unknown) =>
  error instanceof TelegramError ? error.code === 429 || error.code >= 500 : true;

export class Bot {
  private bot: Telegraf<IBotContext>;
  private commands: Command[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.bot = new Telegraf<IBotContext>(this.configService.get('TG_TOKEN'), { handlerTimeout: Infinity });
    this.bot.use(session());
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
    console.log('Bot started');
  }

  async stop(reason?: string) {
    for (const command of this.commands) {
      await command.dispose();
    }
    this.bot.stop(reason);
  }
}
