import type { ReactionTypeEmoji } from 'grammy/types';

import { Command } from './command.class';
import { AIService } from '../../services/ai.service';

type LabelKey = 'insult' | 'obscene' | 'toxic' | 'sexy' | 'cute';
type Reaction = ReactionTypeEmoji['emoji'];
type LabelValue = {
  minScore: number;
  reaction: Reaction;
};

export class ClassifyMessageCommand extends Command {
  public command = null;
  public description = null;
  private aiService = AIService.getInstance();
  private labelsMap: Record<LabelKey, LabelValue> = {
    insult: { minScore: 0.93, reaction: '😈' },
    obscene: { minScore: 0.88, reaction: '🌚' },
    toxic: { minScore: 0.88, reaction: '🤮' },
    sexy: { minScore: 0.92, reaction: '🌭' },
    cute: { minScore: 0.82, reaction: '🦄' },
  };
  private labelList = Object.keys(this.labelsMap);

  handle(): void {
    this.bot.on('message:text', async (ctx, next) => {
      const { labels, scores } = await this.aiService.zeroShotClassification(ctx.msg.text, this.labelList);

      let reaction: Reaction | null = null;
      for (let i = 0; i < scores.length && !reaction; i++) {
        if (reaction) break;
        const label = labels[i] as LabelKey;
        const score = scores[i];
        if (score >= this.labelsMap[label].minScore) {
          reaction = this.labelsMap[label].reaction;
        }
      }

      if (reaction) {
        await ctx.react(reaction);
      }

      return next();
    });
  }
}
