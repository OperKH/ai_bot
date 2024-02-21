import { Command } from './command.class.js';

export class StartCommand extends Command {
  public command = 'start';
  public description = '👋 Привітатися';

  handle(): void {
    this.bot.start((ctx) => {
      ctx.reply(
        'Привіт, я вмію розпізнавати мову і представляти її у вигляді тексту, погано реагую на грубу мову і незабаром навчуся взаємодіяти з картинками.',
      );
    });
  }

  async dispose() {}
}
