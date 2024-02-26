import { NarrowedContext } from 'telegraf';
import { Message, Update } from 'telegraf/types';
import { message } from 'telegraf/filters';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Command } from './command.class.js';
import { IBotContext } from '../context/context.interface.js';
import { AIService } from '../../services/ai.service.js';
import { FileService } from '../../services/file.service.js';
import { ChatPhotoMessage, ChatState } from '../../entity/index.js';

export class MediaTrackerCommand extends Command {
  public command = 'searchmedia';
  public description = '[text] 🖼 Пошук медіа за описом';
  private aiService = AIService.getInstance();
  private fileService = FileService.getInstance();
  private tgClient: TelegramClient | null = null;
  private similarFoundVariants = ['ось тут', 'ще тут', 'і ось', 'навіть це', 'і оце щось схоже'];

  handle(): void {
    this.bot.on(message('photo'), async (ctx) => {
      const fileId = ctx.message.photo.at(-1)?.file_id;
      if (fileId) {
        await this.messageHandler(ctx, fileId);
      }
    });
    this.bot.on(message('video'), async (ctx) => {
      const fileId = ctx.message.video.thumbnail?.file_id;
      if (fileId) {
        await this.messageHandler(ctx, fileId);
      }
    });
    this.bot.command(this.command, async (ctx) => {
      await ctx.reply('👾 Поки що в розробці.', {
        reply_parameters: { message_id: ctx.message.message_id },
      });
    });
  }

  private async messageHandler(ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>, fileId: string) {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const chatStateRepository = this.dataSource.getRepository(ChatState);
    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);

    try {
      // Check media import is done
      const chatState = await chatStateRepository.findOneBy({ chatId: String(chatId) });
      const isMediaImported = chatState?.isMediaImported ?? false;
      if (!isMediaImported) {
        const [latestChatPhotoMessage] = await chatPhotoMessageRepository.find({
          where: { chatId: String(chatId) },
          order: { messageId: 'DESC' },
          take: 1,
        });
        const lastImportedMessageId = latestChatPhotoMessage ? Number(latestChatPhotoMessage.messageId) : 0;
        const lastMessageId = messageId;
        await this.importChatMessages(chatId, lastImportedMessageId, lastMessageId);
        // Save to DB
        const chatState = new ChatState();
        chatState.chatId = String(chatId);
        (chatState.isMediaImported = true), await chatStateRepository.save(chatState);
      }
      // DB similarity search
      const imageEmbeddingString = await this.getEmbeddingStringByImageFileId(fileId);
      type Messages = {
        messageId: string;
        similarity: number;
      };
      const messages = await chatPhotoMessageRepository
        .createQueryBuilder('msg')
        .select('msg.messageId', 'messageId')
        .addSelect('1 - (embedding <=> :embedding)', 'similarity')
        .where('msg.chatId = :chatId')
        .andWhere('1 - (embedding <=> :embedding) > :matchImageThreshold')
        .orderBy('similarity', 'DESC')
        .limit(this.configService.get('MATCH_IMAGE_COUNT'))
        .setParameters({
          chatId,
          embedding: imageEmbeddingString,
          matchImageThreshold: this.configService.get('MATCH_IMAGE_THRESHOLD'),
        })
        .getRawMany<Messages>();
      // When similar
      if (messages.length > 0) {
        await ctx.reply('Здається, я це вже десь бачив...', {
          reply_parameters: { message_id: messageId },
        });
        let replyMessageCount = 0;
        for (const { messageId, similarity } of messages) {
          const variantNumber = replyMessageCount++ % this.similarFoundVariants.length;
          await ctx.reply(`${this.similarFoundVariants[variantNumber]} (${Math.round(similarity * 1e4) / 1e2}%)`, {
            reply_parameters: { message_id: Number(messageId) },
          });
          // Wait 300ms before send next message
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      // Save to DB
      const chatPhotoMessage = new ChatPhotoMessage();
      chatPhotoMessage.chatId = String(chatId);
      chatPhotoMessage.messageId = String(messageId);
      chatPhotoMessage.embedding = imageEmbeddingString;
      await chatPhotoMessageRepository.save(chatPhotoMessage);
    } catch (e) {
      console.log(e);
    }
  }

  private async getEmbeddingStringByImageFileId(fileId: string) {
    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const imageBuffer = await this.fileService.getBufferByUrl(fileUrl);
    const rawImage = await this.aiService.getRawImageFromBuffer(imageBuffer);
    const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
    const imageEmbeddingString = JSON.stringify(imageEmbedding);
    return imageEmbeddingString;
  }

  private async importChatMessages(
    chatId: number,
    lastImportedMessageId: number,
    lastMessageId: number,
  ): Promise<void> {
    const apiId = this.configService.get('TG_API_ID');
    const apiHash = this.configService.get('TG_API_HASH');
    const stringSession = new StringSession(this.configService.get('TG_API_SESSION'));
    this.tgClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await this.tgClient.connect();

    for await (const message of this.tgClient.iterMessages(chatId, {
      offsetId: lastImportedMessageId,
      reverse: true,
      filter: new Api.InputMessagesFilterPhotoVideo(),
    })) {
      if (message.id < lastMessageId) {
        const t1 = performance.now();
        let fleLocation: Api.InputPhotoFileLocation | Api.InputDocumentFileLocation | null = null;
        if (message.video) {
          const { id, fileReference, accessHash } = message.video;
          const thumbSize = message.video.thumbs?.findLast(({ className }) => className === 'PhotoSize')?.type ?? 'm';
          fleLocation = new Api.InputDocumentFileLocation({ id, fileReference, accessHash, thumbSize });
        } else if (message.photo) {
          const photo = message.photo as Api.Photo;
          const { id, fileReference, accessHash } = photo;
          const thumbSize = photo.sizes.at(-1)?.type ?? 'm';
          fleLocation = new Api.InputPhotoFileLocation({ id, fileReference, accessHash, thumbSize });
        }
        if (fleLocation) {
          const imageBuffer = await this.tgClient.downloadFile(fleLocation);
          if (imageBuffer instanceof Buffer) {
            // Get image embedding
            const rawImage = await this.aiService.getRawImageFromBuffer(imageBuffer);
            const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
            const imageEmbeddingString = JSON.stringify(imageEmbedding);
            // Save to DB
            const chatPhotoMessage = new ChatPhotoMessage();
            chatPhotoMessage.chatId = String(chatId);
            chatPhotoMessage.messageId = String(message.id);
            chatPhotoMessage.embedding = imageEmbeddingString;
            await this.dataSource.manager.save(chatPhotoMessage);
            // Logging
            const t2 = performance.now();
            console.log(`Imported message ${message.id}/${lastMessageId - 1} (${Math.round(t2 - t1)} ms)`);
          }
        }
      }
    }
    await this.tgClient.destroy();
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
