import { message } from 'telegraf/filters';

import { Command } from './command.class';
import { AIService } from '../../services/ai.service';

/**
 * Thresholds on the toxicity score, measured on the chat's own messages: from
 * 0.98 about 9 in 10 reactions are right and 86% of toxic messages get one,
 * from 0.995 it is 19 in 20. The model's scores bunch up just below 1, hence
 * the thresholds so close to it.
 *
 * The two levels are confidence, not kind: no model tested could tell an
 * insult from casual swearing in this chat, so 😈 is "clearly toxic", not
 * "aimed at someone".
 */
const DEVIL_THRESHOLD = 0.995;
const MOON_THRESHOLD = 0.98;

export class ClassifyMessageCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();

  handle(): void {
    this.bot.on(message('text'), async (ctx, next) => {
      const textContent = ctx.message.text;
      if (!textContent.startsWith('/')) {
        const toxicScore = await this.aiService.getToxicScore(textContent);
        if (toxicScore >= DEVIL_THRESHOLD) {
          await ctx.react('😈');
        } else if (toxicScore >= MOON_THRESHOLD) {
          await ctx.react('🌚');
        }
      }
      return next();
    });
  }
}
