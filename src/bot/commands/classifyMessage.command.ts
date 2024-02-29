import { message } from 'telegraf/filters';

import { Command } from './command.class.js';
import { AIService } from '../../services/ai.service.js';

export class ClassifyMessageCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();

  handle(): void {
    this.bot.on(message('text'), async (ctx) => {
      const maxToxicScore = await this.aiService.getMaxToxicScore(ctx.message.text);
      if (maxToxicScore > 0.85) {
        await ctx.react('😈');
      } else if (maxToxicScore > 0.7) {
        await ctx.react('🌚');
      }
    });
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
