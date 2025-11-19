import { Command } from './command.class.js';
import { AIService } from '../../services/ai.service.js';
import { IgnoredMedia } from '../../entity/index.js';

export class IgnoreMediaCommand extends Command {
  public command = 'ignoremedia';
  public description = '🙈 Ігнорувати медіа (reply на фото/відео)';
  private aiService = AIService.getInstance();

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      const messageId = ctx.message.message_id;
      const replyToMessage = ctx.message.reply_to_message;

      if (!replyToMessage) {
        await ctx.reply('⚠️ Використовуй цю команду як reply на фото або відео.', {
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      let fileId: string | undefined;

      if ('photo' in replyToMessage && replyToMessage.photo) {
        fileId = replyToMessage.photo.at(-1)?.file_id;
      } else if ('video' in replyToMessage && replyToMessage.video) {
        fileId = replyToMessage.video.thumbnail?.file_id;
      }

      if (!fileId) {
        await ctx.reply('⚠️ Ця команда працює тільки з фото або відео.', {
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      try {
        const chatId = ctx.chat.id;
        const fileUrl = await this.bot.telegram.getFileLink(fileId);
        const embeddingString = await this.aiService.getEmbeddingStringByImageUrl(fileUrl);

        const ignoredMediaRepository = this.dataSource.getRepository(IgnoredMedia);

        type ExistingResult = {
          id: string;
          chatId: string;
        };

        // Check if similar embedding already exists for this chat
        await this.dataSource.query('SET vchordrq.probes = 10');
        const existing = await ignoredMediaRepository
          .createQueryBuilder('ignored')
          .select('ignored.id')
          .addSelect('ignored.chatId', 'chatId')
          .where('embedding <<=>> sphere(:embedding::vector, :radius)')
          .setParameters({
            embedding: embeddingString,
            radius: 1 - this.configService.get('MATCH_IMAGE_THRESHOLD'),
          })
          .getRawMany<ExistingResult>()
          .then((results) => results.find((r) => r.chatId === String(chatId)));

        if (existing) {
          await ctx.reply('ℹ️ Це медіа вже є у списку ігнорування.', {
            reply_parameters: { message_id: messageId },
          });
          return;
        }

        const ignoredMedia = new IgnoredMedia();
        ignoredMedia.chatId = String(chatId);
        ignoredMedia.embedding = embeddingString;
        await ignoredMediaRepository.save(ignoredMedia);

        await ctx.reply('✅ Медіа додано до списку ігнорування.', {
          reply_parameters: { message_id: messageId },
        });
      } catch (e) {
        console.log(e);
        await ctx.reply('📛 Сталася помилка при додаванні медіа до списку ігнорування.', {
          reply_parameters: { message_id: messageId },
        });
      }
    });
  }

  async dispose() {}
}
