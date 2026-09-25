import { Command } from './command.class.js';
import { AIService } from '../../services/ai.service.js';
import { VideoService } from '../../services/video.service.js';
import { IgnoredMedia, ChatPhotoMessage } from '../../entity/index.js';
import { messageLink } from '../telegramLinks.js';
import { findIgnoredMedia } from '../../dataSource/vectorSearch.js';
import { downloadTelegramFile } from '../telegramFiles.js';

export class IgnoreMediaCommand extends Command {
  public command = 'ignoremedia';
  public description = '🙈 Ігнорувати медіа (reply на фото/відео)';
  private aiService = AIService.getInstance();
  private videoService = VideoService.getInstance();

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      const messageId = ctx.msg.message_id;
      const replyToMessage = ctx.msg.reply_to_message;
      const reply = (text: string) => ctx.reply(text, { reply_parameters: { message_id: messageId } });

      if (!replyToMessage) {
        await reply('⚠️ Використовуй цю команду як reply на фото або відео.');
        return;
      }

      const { photo, video } = replyToMessage;

      if (!photo && !video) {
        await reply('⚠️ Ця команда працює тільки з фото або відео.');
        return;
      }

      try {
        const chatId = ctx.chat.id;
        const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);

        // Handle photo
        if (photo) {
          // First, try to find existing embeddings in chat_photo_message table
          const existingPhotoMessage = await chatPhotoMessageRepository.findOne({
            select: { embedding: true },
            where: {
              chatId: String(chatId),
              messageId: String(replyToMessage.message_id),
              mediaType: 'photo',
            },
          });

          let embeddingString: string;

          if (existingPhotoMessage) {
            // Reuse existing embedding
            embeddingString = JSON.stringify(existingPhotoMessage.embedding);
          } else {
            // Fallback: download and process photo
            const fileId = photo.at(-1)?.file_id;
            if (!fileId) {
              await reply('⚠️ Не вдалося отримати ID фото.');
              return;
            }

            const imageBuffer = await downloadTelegramFile(this.bot.api, fileId);
            embeddingString = await this.aiService.getEmbeddingStringByImageBuffer(imageBuffer);
          }

          await this.addToIgnoreList(chatId, replyToMessage.message_id, 'photo', [embeddingString], reply);
        }
        // Handle video
        else if (video) {
          // First, try to find existing embeddings in chat_photo_message table
          const existingVideoMessages = await chatPhotoMessageRepository.find({
            select: { embedding: true },
            where: {
              chatId: String(chatId),
              messageId: String(replyToMessage.message_id),
              mediaType: 'video',
            },
            order: {
              frameIndex: 'ASC',
            },
          });

          let frameEmbeddings: string[];

          if (existingVideoMessages.length > 0) {
            // Reuse existing embeddings
            frameEmbeddings = existingVideoMessages.map((msg) => JSON.stringify(msg.embedding));
          } else {
            // Fallback: download and process video
            const fileId = video.file_id;
            if (!fileId) {
              await reply('⚠️ Не вдалося отримати ID відео.');
              return;
            }

            // Download video file
            const videoBuffer = await downloadTelegramFile(this.bot.api, fileId);

            // Extract frames from video
            const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);

            if (frames.length === 0) {
              await reply('⚠️ Не вдалося витягнути кадри з відео.');
              return;
            }

            frameEmbeddings = (await this.aiService.getFrameEmbeddings(frames)).map(({ embedding }) => embedding);

            if (frameEmbeddings.length === 0) {
              await reply('⚠️ Не вдалося обробити кадри відео.');
              return;
            }
          }

          await this.addToIgnoreList(chatId, replyToMessage.message_id, 'video', frameEmbeddings, reply);
        }
      } catch (e) {
        console.log(e);
        await reply('📛 Сталася помилка при додаванні медіа до списку ігнорування.');
      }
    });
  }

  /** Adds a photo or a video (one embedding per frame) to the chat's ignore list, unless it is there already */
  private async addToIgnoreList(
    chatId: number,
    messageId: number,
    mediaType: 'photo' | 'video',
    embeddings: string[],
    reply: (text: string) => Promise<unknown>,
  ) {
    const threshold = this.configService.get('MATCH_IMAGE_THRESHOLD');
    const existing = await findIgnoredMedia(this.dataSource, chatId, embeddings, threshold);
    if (existing) {
      console.log('Media already in Ignore List', messageLink(chatId, messageId), `id: ${existing.id}`);
      await reply(
        mediaType === 'photo' ? 'ℹ️ Це медіа вже є у списку ігнорування.' : 'ℹ️ Це відео вже є у списку ігнорування.',
      );
      return;
    }

    const repository = this.dataSource.getRepository(IgnoredMedia);
    await repository.save(
      embeddings.map((embedding) =>
        repository.create({ chatId: String(chatId), messageId: String(messageId), embedding }),
      ),
    );
    await reply(
      mediaType === 'photo'
        ? '✅ Фото додано до списку ігнорування.'
        : `✅ Відео додано до списку ігнорування (${embeddings.length} кадрів).`,
    );
  }
}
