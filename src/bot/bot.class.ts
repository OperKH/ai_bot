import { session, Telegraf } from 'telegraf';
import { BotCommand } from 'telegraf/types';
import { Command } from './commands/command.class.js';
import { IBotContext } from './context/context.interface.js';
import { ConfigService } from '../config/config.service.js';

export class Bot {
  private bot: Telegraf<IBotContext>;
  private commands: Command[] = [];

  constructor(private readonly configService: ConfigService) {
    this.bot = new Telegraf<IBotContext>(this.configService.get('TOKEN'), { handlerTimeout: Infinity });
    this.bot.use(session());
  }

  registerCommands(commands: Array<{ new (bot: Telegraf<IBotContext>): Command }>) {
    const botCommands: BotCommand[] = [];
    for (const Command of commands) {
      const commandEntity = new Command(this.bot);
      commandEntity.handle();
      this.commands.push(commandEntity);
      const { command, description } = commandEntity;
      if (command && description) {
        botCommands.push({ command, description });
      }
    }
    this.bot.telegram.setMyCommands(botCommands);
  }

  start() {
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
