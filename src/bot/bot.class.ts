import { session, Telegraf } from 'telegraf';
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
    for (const Command of commands) {
      const command = new Command(this.bot);
      this.commands.push(command);
      command.handle();
    }
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
