import { session, Telegraf } from 'telegraf';
import { BotCommand } from 'telegraf/types';
import { DataSource } from 'typeorm';
import { Command } from './commands/command.class';
import { IBotContext } from './context/context.interface';
import { ConfigService } from '../config/config.service';

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

  async registerCommands(
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
    await this.bot.telegram.setMyCommands(botCommands);
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
