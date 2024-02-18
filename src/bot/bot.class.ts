import { session, Telegraf } from 'telegraf';
import { Command } from './commands/command.class.js';
import { IBotContext } from './context/context.interface.js';
import { ConfigService } from '../config/config.service.js';

export class Bot {
  private bot: Telegraf<IBotContext>;

  constructor(private readonly configService: ConfigService) {
    this.bot = new Telegraf<IBotContext>(this.configService.get('TOKEN'));
    this.bot.use(session());
  }

  registerCommands(commands: Array<{ new (bot: Telegraf<IBotContext>): Command }>) {
    for (const Command of commands) {
      const command = new Command(this.bot);
      command.handle();
    }
  }

  start() {
    this.bot.launch();
    console.log('Bot started');
  }

  stop(reason?: string) {
    this.bot.stop(reason);
  }
}
