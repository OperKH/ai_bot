import { message } from 'telegraf/filters';

import { Command } from './command.class';
import { AIService } from '../../services/ai.service';

export class ClassifyMessageCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();

  handle(): void {
    this.bot.on(message('text'), async (ctx, next) => {
      const textContent = ctx.message.text;
      if (!textContent.startsWith('/')) {
        const maxToxicScore = await this.aiService.getMaxToxicScore(textContent);
        if (maxToxicScore > 0.85) {
          await ctx.react('😈');
        } else if (maxToxicScore > 0.7) {
          await ctx.react('🌚');
        }
      }
      return next();
    });
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
