import { Context, NarrowedContext } from 'telegraf';
import { CallbackQuery, InlineKeyboardMarkup, Message, Update } from 'telegraf/types';
import { message } from 'telegraf/filters';
import { TelegramClient, Api, sessions } from 'telegram';
import { Command } from './command.class';
import { IBotContext } from '../context/context.interface';
import { AIService } from '../../services/ai.service';
import { ChatPhotoMessage, ChatState, IgnoredMedia } from '../../entity/index';

export class MediaTrackerCommand extends Command {
  public command = 'searchmedia';
  public description = '[text] 🖼 Пошук медіа за описом';
  private aiService = AIService.getInstance();
  private tgClient: TelegramClient | null = null;
  private similarFoundVariants = ['ось тут', 'ще тут', 'і ось', 'навіть це', 'і оце щось схоже'];
  private isMediaImporting = false;
  private chatCountCache: number | null = null;
  private chatCountCacheTime: number = 0;
  private readonly CHAT_COUNT_CACHE_TTL = 20 * 60 * 1000; // 20 minutes

  handle(): void {
    this.bot.on(message('photo'), async (ctx) => {
      const fileId = ctx.message.photo.at(-1)?.file_id;
      if (fileId) {
        try {
          await this.messageHandler(ctx, fileId);
        } catch (e) {
          console.log(e);
        }
      }
    });
    this.bot.on(message('video'), async (ctx) => {
      const fileId = ctx.message.video.thumbnail?.file_id;
      if (fileId) {
        try {
          await this.messageHandler(ctx, fileId);
        } catch (e) {
          console.log(e);
        }
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
    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const imageEmbeddingString = await this.aiService.getEmbeddingStringByImageUrl(fileUrl);

    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
    const ignoredMediaRepository = this.dataSource.getRepository(IgnoredMedia);

    try {
      // Check if media is in ignored list
      type IgnoredResult = {
        id: string;
        chatId: string;
      };
      await this.dataSource.query('SET vchordrq.probes = 10');
      const isIgnored = await ignoredMediaRepository
        .createQueryBuilder('ignored')
        .select('ignored.id')
        .addSelect('ignored.chatId', 'chatId')
        .where('embedding <<=>> sphere(:embedding::vector, :radius)')
        .setParameters({
          embedding: imageEmbeddingString,
          radius: 1 - this.configService.get('MATCH_IMAGE_THRESHOLD'),
        })
        .getRawMany<IgnoredResult>()
        .then((results) => results.some((r) => r.chatId === String(chatId)));

      if (isIgnored) {
        const linkChatId = Math.abs(chatId) % 10000000000;
        console.log('mediaIgnored', `https://t.me/c/${linkChatId}/${messageId}`);
      } else {
        // DB similarity search
        type Messages = {
          messageId: string;
          similarity: number;
        };
        const limit = this.configService.get('MATCH_IMAGE_COUNT');
        const multiplier = await this.getQueryMultiplier();
        const t1 = performance.now();
        const messages = await chatPhotoMessageRepository
          .createQueryBuilder('msg')
          .select('msg.messageId', 'messageId')
          .addSelect('msg.chatId', 'chatId')
          .addSelect('1 - (embedding <=> :embedding)', 'similarity')
          .where('embedding <<=>> sphere(:embedding::vector, :radius)')
          .orderBy('similarity', 'DESC')
          .limit(limit * multiplier)
          .setParameters({
            embedding: imageEmbeddingString,
            radius: 1 - this.configService.get('MATCH_IMAGE_THRESHOLD'),
          })
          .getRawMany<Messages & { chatId: string }>()
          .then((messages) => messages.filter((m) => m.chatId === String(chatId)).slice(0, limit));
        const t2 = performance.now();
        console.log(`DB query time for message: ${Math.round(t2 - t1)} ms`);
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
      }
    } catch (e) {
      console.log(e);
    }

    try {
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
      chatId: string;
      similarity: number;
    };
    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
    const limit = this.configService.get('MATCH_IMAGE_COUNT');
    const multiplier = await this.getQueryMultiplier();
    const t1 = performance.now();
    await this.dataSource.query('SET vchordrq.probes = 10');
    const messages = await chatPhotoMessageRepository
      .createQueryBuilder('msg')
      .select('msg.messageId', 'messageId')
      .addSelect('msg.chatId', 'chatId')
      .addSelect('1 - (embedding <=> :embedding::vector)', 'similarity')
      .where('embedding <<=>> sphere(:embedding::vector, :radius)')
      .orderBy('similarity', 'DESC')
      .limit((limit + offset * multiplier) * multiplier)
      .setParameters({
        embedding: textEmbeddingString,
        radius: 1 - this.configService.get('MATCH_TEXT_THRESHOLD'),
      })
      .getRawMany<Messages>()
      .then((messages) => messages.filter((m) => m.chatId === String(chatId)).slice(offset, limit + offset));
    const t2 = performance.now();
    console.log(`DB query time for search: ${Math.round(t2 - t1)} ms`);
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
        chatState.isMediaImported = true;
        await chatStateRepository.save(chatState);

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

  private async getQueryMultiplier(): Promise<number> {
    const now = Date.now();

    if (this.chatCountCache !== null && now - this.chatCountCacheTime < this.CHAT_COUNT_CACHE_TTL) {
      return this.chatCountCache;
    }

    const result = await this.dataSource
      .getRepository(ChatPhotoMessage)
      .createQueryBuilder('msg')
      .select('COUNT(DISTINCT msg.chatId)', 'count')
      .getRawOne<{ count: string }>();

    const chatCount = parseInt(result?.count || '1', 10);

    this.chatCountCache = chatCount === 1 ? 1 : Math.min(chatCount * 5, 50);
    this.chatCountCacheTime = now;

    return this.chatCountCache;
  }

  private async importChatMessages(
    chatId: number,
    lastImportedMessageId: number,
    lastMessageId: number,
  ): Promise<void> {
    const apiId = this.configService.get('TG_API_ID');
    const apiHash = this.configService.get('TG_API_HASH');
    const stringSession = new sessions.StringSession(this.configService.get('TG_API_SESSION'));
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
