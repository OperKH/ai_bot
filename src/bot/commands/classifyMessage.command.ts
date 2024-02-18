import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

import { Command } from './command.class.js';
import { IBotContext } from '../context/context.interface.js';
import { AIService } from '../../services/ai.service.js';

export class ClassifyMessageCommand extends Command {
  private aiService = AIService.getInstance();

  constructor(bot: Telegraf<IBotContext>) {
    super(bot);
  }

  handle(): void {
    this.bot.on(message('text'), async (ctx) => {
      const maxToxicScore = await this.aiService.getMaxToxicScore(ctx.message.text);
      if (maxToxicScore > 0.85) {
        ctx.react('😈');
      } else if (maxToxicScore > 0.7) {
        ctx.react('🌚');
      }
    });
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
