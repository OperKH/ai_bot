import { Command } from './command.class';

export class StartCommand extends Command {
  public command = 'start';
  public description = '👋 Привітатися';

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      try {
        await ctx.reply(
          'Привіт, я вмію розпізнавати мову і представляти її у вигляді тексту, щильно стежу за всіма медіа щоб не було ждогого баяну та погано реагую на грубу мову.',
        );
      } catch (e) {
        console.log(ctx.chat, e);
      }
    });
  }
}
