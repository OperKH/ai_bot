import { Command } from './command.class';

export class StartCommand extends Command {
  public command = 'start';
  public description = '👋 Привітатися';

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      try {
        // The second paragraph: the members must know the crow reads the chat before she jabs anyone or hears
        // their talk by its meaning — the Gemma Terms forbid monitoring people without their knowing (docs/ai-models.md)
        await ctx.reply(
          '👋 Привіт, я вмію розпізнавати мову і представляти її у вигляді тексту, щильно стежу за всіма медіа щоб не було ждогого баяну та погано реагую на грубу мову.\n\n' +
            '🐦‍⬛ А ще в мене живе ворона Кара з новинами — /crow. Вона читає чат, щоб устрявати в розмови про свої новини й підколювати котів по їхніх темах; не хочеш — /crow і «🙅 Не чіпай мене».',
        );
      } catch (e) {
        console.log(ctx.chat, e);
      }
    });
  }
}
