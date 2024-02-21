import { Command } from './command.class.js';
import { ClockLoader } from '../loaders/clockLoader.class.js';

export class ClockCommand extends Command {
  public command = 'clock';
  public description = '🕓 Демо годинника';

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      await ctx.deleteMessage();
      const clockLoader = new ClockLoader(ctx);
      await clockLoader.start();
      await new Promise((resolve) => setTimeout(resolve, 25000));
      const messageId = clockLoader.stop();
      if (messageId) {
        await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
      }
    });
  }

  async dispose() {}
}
