import { Command } from './command.class';
import { ClockLoader } from '../loaders/clockLoader.class';

export class ClockCommand extends Command {
  public command = 'clock';
  public description = '🕓 Демо годинника';

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      console.log('Clock started');
      try {
        await ctx.deleteMessage();
      } catch (e) {
        console.log("Can't delete clock message");
      }
      const clockLoader = new ClockLoader(ctx);
      await clockLoader.start();
      await new Promise((resolve) => setTimeout(resolve, 25000));
      const messageId = clockLoader.stop();
      if (messageId) {
        await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
      }
      console.log('Clock stopped');
    });
  }

  async dispose() {}
}
