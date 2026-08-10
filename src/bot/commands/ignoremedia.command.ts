import { Command } from './command.class.js';
import { AIService } from '../../services/ai.service.js';
import { VideoService } from '../../services/video.service.js';
import { IgnoredMedia, ChatPhotoMessage } from '../../entity/index.js';
import { getLinkChatId } from '../../utils/telegram.utils.js';

export class IgnoreMediaCommand extends Command {
  public command = 'ignoremedia';
  public description = '🙈 Ігнорувати медіа (reply на фото/відео)';
  private aiService = AIService.getInstance();
  private videoService = VideoService.getInstance();

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

      const isPhoto = 'photo' in replyToMessage && replyToMessage.photo;
      const isVideo = 'video' in replyToMessage && replyToMessage.video;

      if (!isPhoto && !isVideo) {
        await ctx.reply('⚠️ Ця команда працює тільки з фото або відео.', {
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      try {
        const chatId = ctx.chat.id;
        const ignoredMediaRepository = this.dataSource.getRepository(IgnoredMedia);
        const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);

        type ExistingResult = {
          id: string;
          chatId: string;
        };

        // Handle photo
        if (isPhoto) {
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
            const fileId = replyToMessage.photo.at(-1)?.file_id;
            if (!fileId) {
              await ctx.reply('⚠️ Не вдалося отримати ID фото.', {
                reply_parameters: { message_id: messageId },
              });
              return;
            }

            const fileUrl = await this.bot.telegram.getFileLink(fileId);
            embeddingString = await this.aiService.getEmbeddingStringByImageUrl(fileUrl);
          }

          // Check if similar embedding already exists for this chat
          await this.dataSource.query('SET vchordrq.probes = 10');
          const existing = await ignoredMediaRepository
            .createQueryBuilder('ignored')
            .select('ignored.id', 'id')
            .addSelect('ignored.chatId', 'chatId')
            .where('embedding <<=>> sphere(:embedding::vector, :radius)')
            .setParameters({
              embedding: embeddingString,
              radius: 1 - this.configService.get('MATCH_IMAGE_THRESHOLD'),
            })
            .getRawMany<ExistingResult>()
            .then((results) => results.find((r) => r.chatId === String(chatId)));

          if (existing) {
            const linkChatId = getLinkChatId(chatId);
            console.log(
              'Media already in Ignore List',
              `https://t.me/c/${linkChatId}/${replyToMessage.message_id}`,
              `id: ${existing.id}`,
            );
            await ctx.reply('ℹ️ Це медіа вже є у списку ігнорування.', {
              reply_parameters: { message_id: messageId },
            });
            return;
          }

          const ignoredMedia = new IgnoredMedia();
          ignoredMedia.chatId = String(chatId);
          ignoredMedia.messageId = String(replyToMessage.message_id);
          ignoredMedia.embedding = embeddingString;
          await ignoredMediaRepository.save(ignoredMedia);

          await ctx.reply('✅ Фото додано до списку ігнорування.', {
            reply_parameters: { message_id: messageId },
          });
        }
        // Handle video
        else if (isVideo) {
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
            const fileId = replyToMessage.video.file_id;
            if (!fileId) {
              await ctx.reply('⚠️ Не вдалося отримати ID відео.', {
                reply_parameters: { message_id: messageId },
              });
              return;
            }

            const fileUrl = await this.bot.telegram.getFileLink(fileId);

            // Download video file
            const videoBuffer = await fetch(fileUrl.href)
              .then((res) => res.arrayBuffer())
              .then((ab) => Buffer.from(ab));

            // Extract frames from video
            const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);

            if (frames.length === 0) {
              await ctx.reply('⚠️ Не вдалося витягнути кадри з відео.', {
                reply_parameters: { message_id: messageId },
              });
              return;
            }

            // Process each frame and collect embeddings
            frameEmbeddings = [];
            for (const frame of frames) {
              try {
                const rawImage = await this.videoService.frameBufferToRawImage(frame.buffer);
                const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
                const imageEmbeddingString = JSON.stringify(imageEmbedding);
                frameEmbeddings.push(imageEmbeddingString);
              } catch (e) {
                console.log(`Error processing frame ${frame.frameIndex}:`, e);
              }
            }

            if (frameEmbeddings.length === 0) {
              await ctx.reply('⚠️ Не вдалося обробити кадри відео.', {
                reply_parameters: { message_id: messageId },
              });
              return;
            }
          }

          // Check if any frame already exists in ignored list
          await this.dataSource.query('SET vchordrq.probes = 10');
          for (const embeddingString of frameEmbeddings) {
            const existing = await ignoredMediaRepository
              .createQueryBuilder('ignored')
              .select('ignored.id', 'id')
              .addSelect('ignored.chatId', 'chatId')
              .where('embedding <<=>> sphere(:embedding::vector, :radius)')
              .setParameters({
                embedding: embeddingString,
                radius: 1 - this.configService.get('MATCH_IMAGE_THRESHOLD'),
              })
              .getRawMany<ExistingResult>()
              .then((results) => results.find((r) => r.chatId === String(chatId)));

            if (existing) {
              const linkChatId = getLinkChatId(chatId);
              console.log(
                'Media already in Ignore List',
                `https://t.me/c/${linkChatId}/${replyToMessage.message_id}`,
                `id: ${existing.id}`,
              );
              await ctx.reply('ℹ️ Це відео вже є у списку ігнорування.', {
                reply_parameters: { message_id: messageId },
              });
              return;
            }
          }

          // Save all frame embeddings to ignored list
          const ignoredMediaEntities = frameEmbeddings.map((embedding) => {
            const ignoredMedia = new IgnoredMedia();
            ignoredMedia.chatId = String(chatId);
            ignoredMedia.messageId = String(replyToMessage.message_id);
            ignoredMedia.embedding = embedding;
            return ignoredMedia;
          });

          await ignoredMediaRepository.save(ignoredMediaEntities);

          await ctx.reply(`✅ Відео додано до списку ігнорування (${ignoredMediaEntities.length} кадрів).`, {
            reply_parameters: { message_id: messageId },
          });
        }
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
