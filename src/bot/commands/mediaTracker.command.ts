import { Context, NarrowedContext } from 'telegraf';
import { CallbackQuery, InlineKeyboardMarkup, Message, Update } from 'telegraf/types';
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
  private isMediaImporting = false;

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
      if (ctx.payload) {
        await this.searchAndReplyPaginated(ctx, ctx.chat.id, ctx.message.message_id, ctx.payload, 0);
      } else {
        await ctx.reply(`ℹ️ Додай пошуковий запит після команди, наприклад: /${this.command} ігрова консоль`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
    });
    this.bot.action(/^islm-(.+)$/, async (ctx) => {
      const payload = JSON.parse(ctx.match[1]) as unknown;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        't' in payload &&
        'o' in payload &&
        typeof payload.t === 'string' &&
        typeof payload.o === 'number'
      ) {
        const { t, o } = payload;
        const chat = await ctx.getChat();
        await this.searchAndReplyPaginated(ctx, chat.id, undefined, t, o);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      }
    });
    this.bot.command('starthistoryimport', async (ctx) => {
      // Allow run in background and release message queue
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.startHistoryImport(ctx);
    });
  }

  private async messageHandler(ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>, fileId: string) {
    if (this.isMediaImporting) return;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    try {
      // DB similarity search
      const imageEmbeddingString = await this.getEmbeddingStringByImageFileId(fileId);
      type Messages = {
        messageId: string;
        similarity: number;
      };
      const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
      const t1 = performance.now();
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
      const t2 = performance.now();
      console.log(`DB query time: ${Math.round(t2 - t1)} ms`);
      // When similar
      if (messages.length > 0) {
        await ctx.reply('🕵️‍♀️ Здається, я це вже десь бачив...', {
          reply_parameters: { message_id: messageId },
        });
        let replyMessageCount = 0;
        for (const { messageId, similarity } of messages) {
          const variantNumber = replyMessageCount++ % this.similarFoundVariants.length;
          await ctx.reply(`${this.similarFoundVariants[variantNumber]} (${Math.round(similarity * 1e4) / 1e2}%)`, {
            reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true },
            disable_notification: true,
          });
          // Wait 1 second before send next message
          await new Promise((r) => setTimeout(r, 1000));
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

  private async searchAndReplyPaginated(
    ctx:
      | NarrowedContext<IBotContext, Update.MessageUpdate<Message>>
      | Context<Update.CallbackQueryUpdate<CallbackQuery>>,
    chatId: number,
    firstMessageId: number | undefined,
    text: string,
    offset: number,
  ) {
    const textEmbedding = await this.aiService.getTextClipEmbedding(text);
    const textEmbeddingString = JSON.stringify(textEmbedding);
    type Messages = {
      messageId: string;
      similarity: number;
    };
    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
    const t1 = performance.now();
    const limit = this.configService.get('MATCH_IMAGE_COUNT');
    const messages = await chatPhotoMessageRepository
      .createQueryBuilder('msg')
      .select('msg.messageId', 'messageId')
      .addSelect('1 - (embedding <=> :embedding)', 'similarity')
      .where('msg.chatId = :chatId')
      .andWhere('1 - (embedding <=> :embedding) > :matchImageThreshold')
      .orderBy('similarity', 'DESC')
      .offset(offset)
      .limit(limit)
      .setParameters({
        chatId,
        embedding: textEmbeddingString,
        matchImageThreshold: this.configService.get('MATCH_TEXT_THRESHOLD'),
      })
      .getRawMany<Messages>();
    const t2 = performance.now();
    console.log(`DB query time: ${Math.round(t2 - t1)} ms`);
    // When similar
    if (messages.length > 0) {
      const hasMore = messages.length === limit;
      if (firstMessageId) {
        await ctx.reply('🔎 Ось, що мені вдалось знайти:', {
          reply_parameters: { message_id: firstMessageId },
        });
      }
      for (const message of messages) {
        const { messageId, similarity } = message;
        const isLast = message === messages.at(-1);
        let reply_markup: InlineKeyboardMarkup | undefined;
        if (isLast && hasMore) {
          const payload = JSON.stringify({ t: text, o: offset + limit });
          reply_markup = { inline_keyboard: [[{ text: 'Ще', callback_data: `islm-${payload}` }]] };
        }
        try {
          await ctx.reply(`${text} (${similarity.toPrecision(4)})`, {
            reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: true },
            disable_notification: true,
            reply_markup,
          });
        } catch (e) {
          console.log(`messageId: ${messageId}`, e);
        }
        // Wait 1 second before send next message
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!hasMore) {
        await ctx.reply('💃 Це все!');
      }
    } else {
      if (firstMessageId) {
        await ctx.reply('🤷‍♂️ Нічого нема.', {
          reply_parameters: { message_id: firstMessageId },
        });
      } else {
        await ctx.reply('💃 Це все!');
      }
    }
  }

  private async startHistoryImport(ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>) {
    const messageId = ctx.message.message_id;
    if (this.isMediaImporting) {
      await ctx.reply('😡 Я тут працюю, тужуся, а ти відволікаєш.', {
        reply_parameters: { message_id: messageId },
      });
      return;
    }
    this.isMediaImporting = true;
    try {
      const chatId = ctx.chat.id;
      const chatStateRepository = this.dataSource.getRepository(ChatState);
      const chatState = await chatStateRepository.findOneBy({ chatId: String(chatId) });
      const isMediaImported = chatState?.isMediaImported ?? false;
      if (isMediaImported) {
        await ctx.reply('🍧 Нема потреби. Усе же зроблено.', {
          reply_parameters: { message_id: messageId },
        });
      } else {
        await ctx.reply('🏃 Взяв у роботу!', {
          reply_parameters: { message_id: messageId },
        });

        const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
        const [latestChatPhotoMessage] = await chatPhotoMessageRepository.find({
          where: { chatId: String(chatId) },
          order: { messageId: 'DESC' },
          take: 1,
        });
        const lastImportedMessageId = latestChatPhotoMessage ? Number(latestChatPhotoMessage.messageId) : 0;
        await this.importChatMessages(chatId, lastImportedMessageId, messageId);
        // Save to DB
        const chatState = new ChatState();
        chatState.chatId = String(chatId);
        (chatState.isMediaImported = true), await chatStateRepository.save(chatState);

        await ctx.reply('😮‍💨 Фух... Усе підтягнув!', {
          reply_parameters: { message_id: messageId },
        });
      }
    } catch (e) {
      console.log(e);
      await ctx.reply('📛 Халепа!', {
        reply_parameters: { message_id: messageId },
      });
    } finally {
      this.isMediaImporting = false;
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
        try {
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
            console.log(
              `Imported message ${message.id}/${lastMessageId} ${Math.round((message.id / lastMessageId) * 1e4) / 1e2}% (${Math.round(t2 - t1)} ms)`,
            );
          }
        } catch (e) {
          console.log(chatId, message.id, message.video || message.photo, fleLocation, e);
        }
      }
    }
    await this.tgClient.destroy();
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
