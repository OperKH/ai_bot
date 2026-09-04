import { Context, NarrowedContext, Types } from 'telegraf';
import { CallbackQuery, InlineKeyboardMarkup, Message, Update } from 'telegraf/types';
import { message } from 'telegraf/filters';
import { TelegramClient, Api, sessions } from 'telegram';
import { Command } from './command.class';
import { IBotContext } from '../context/context.interface';
import { AIService } from '../../services/ai.service';
import { VideoService } from '../../services/video.service';
import { ChatPhotoMessage, ChatState, IgnoredMedia } from '../../entity/index';
import { getLinkChatId } from '../../utils/telegram.utils.js';

/** Media messages added during an import, plus the chat's media count afterwards */
type ImportStats = { photos: number; videos: number; total: number };

export class MediaTrackerCommand extends Command {
  public command = 'searchmedia';
  public description = '[text] 🖼 Пошук медіа за описом';
  private aiService = AIService.getInstance();
  private videoService = VideoService.getInstance();
  private tgClient: TelegramClient | null = null;
  private similarFoundVariants = ['ось тут', 'ще тут', 'і ось', 'навіть це', 'і оце щось схоже'];
  private isMediaImporting = false;
  private chatCountCache: number | null = null;
  private chatCountCacheTime: number = 0;
  private readonly CHAT_COUNT_CACHE_TTL = 20 * 60 * 1000; // 20 minutes

  handle(): void {
    this.bot.on(message('photo'), async (ctx, next) => {
      const fileId = ctx.message.photo.at(-1)?.file_id;
      if (fileId) {
        try {
          await this.photoMessageHandler(ctx, fileId);
        } catch (e) {
          console.log(e);
        }
      }
      return next();
    });
    this.bot.on(message('video'), async (ctx, next) => {
      const fileId = ctx.message.video.file_id;
      if (fileId) {
        try {
          await this.videoMessageHandler(ctx, fileId);
        } catch (e) {
          console.log(e);
        }
      }
      return next();
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

  private async photoMessageHandler(ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>, fileId: string) {
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
        const linkChatId = getLinkChatId(chatId);
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
      chatPhotoMessage.mediaType = 'photo';
      chatPhotoMessage.frameIndex = 0;
      chatPhotoMessage.embedding = imageEmbeddingString;
      await chatPhotoMessageRepository.save(chatPhotoMessage);
    } catch (e) {
      console.log(e);
    }
  }

  private async videoMessageHandler(ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>, fileId: string) {
    if (this.isMediaImporting) return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const fileUrl = await this.bot.telegram.getFileLink(fileId);

    // Download video file
    const videoBuffer = await fetch(fileUrl.href)
      .then((res) => res.arrayBuffer())
      .then((ab) => Buffer.from(ab));

    // Extract frames from video
    const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);

    if (frames.length === 0) {
      console.log('No frames extracted from video, skipping');
      return;
    }

    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
    const ignoredMediaRepository = this.dataSource.getRepository(IgnoredMedia);

    // Process each frame
    const frameEmbeddings: Array<{ frameIndex: number; embedding: string }> = [];
    for (const frame of frames) {
      try {
        const rawImage = await this.videoService.frameBufferToRawImage(frame.buffer);
        const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
        const imageEmbeddingString = JSON.stringify(imageEmbedding);
        frameEmbeddings.push({
          frameIndex: frame.frameIndex,
          embedding: imageEmbeddingString,
        });
      } catch (e) {
        console.log(`Error processing frame ${frame.frameIndex}:`, e);
      }
    }

    if (frameEmbeddings.length === 0) {
      console.log('No frame embeddings generated, skipping');
      return;
    }

    try {
      // Check if any frame is in ignored list
      await this.dataSource.query('SET vchordrq.probes = 10');
      let isIgnored = false;
      for (const { embedding: imageEmbeddingString } of frameEmbeddings) {
        type IgnoredResult = {
          id: string;
          chatId: string;
        };
        const ignored = await ignoredMediaRepository
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

        if (ignored) {
          isIgnored = true;
          break;
        }
      }

      if (isIgnored) {
        const linkChatId = getLinkChatId(chatId);
        console.log('mediaIgnored', `https://t.me/c/${linkChatId}/${messageId}`);
      } else {
        // DB similarity search - check all frames
        type Messages = {
          messageId: string;
          chatId: string;
          similarity: number;
        };
        const limit = this.configService.get('MATCH_IMAGE_COUNT');
        const multiplier = await this.getQueryMultiplier();
        const t1 = performance.now();

        // Collect similar messages from all frames
        const allSimilarMessages = new Map<string, Messages>();

        for (const { embedding: imageEmbeddingString } of frameEmbeddings) {
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
            .getRawMany<Messages>()
            .then((messages) => messages.filter((m) => m.chatId === String(chatId)));

          // Keep the highest similarity for each message
          for (const msg of messages) {
            const existing = allSimilarMessages.get(msg.messageId);
            if (!existing || msg.similarity > existing.similarity) {
              allSimilarMessages.set(msg.messageId, msg);
            }
          }
        }

        // Sort by similarity and take top N
        const topMessages = Array.from(allSimilarMessages.values())
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, limit);

        const t2 = performance.now();
        console.log(`DB query time for video: ${Math.round(t2 - t1)} ms`);

        // When similar
        if (topMessages.length > 0) {
          await ctx.reply('🕵️‍♀️ Здається, я це вже десь бачив...', {
            reply_parameters: { message_id: messageId },
          });
          let replyMessageCount = 0;
          for (const { messageId, similarity } of topMessages) {
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
      // Save all frames to DB
      const chatPhotoMessages = frameEmbeddings.map(({ frameIndex, embedding }) => {
        const chatPhotoMessage = new ChatPhotoMessage();
        chatPhotoMessage.chatId = String(chatId);
        chatPhotoMessage.messageId = String(messageId);
        chatPhotoMessage.mediaType = 'video';
        chatPhotoMessage.frameIndex = frameIndex;
        chatPhotoMessage.embedding = embedding;
        return chatPhotoMessage;
      });
      await chatPhotoMessageRepository.save(chatPhotoMessages);
    } catch (e) {
      console.log(e);
    }
  }

  private async searchAndReplyPaginated(
    ctx:
      NarrowedContext<IBotContext, Update.MessageUpdate<Message>> | Context<Update.CallbackQueryUpdate<CallbackQuery>>,
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
    const allMessages = await chatPhotoMessageRepository
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
      .getRawMany<Messages>();

    // Group by messageId and keep the highest similarity
    const messageMap = new Map<string, Messages>();
    for (const msg of allMessages) {
      if (msg.chatId !== String(chatId)) continue;
      const existing = messageMap.get(msg.messageId);
      if (!existing || msg.similarity > existing.similarity) {
        messageMap.set(msg.messageId, msg);
      }
    }

    // Sort by similarity and apply pagination
    const messages = Array.from(messageMap.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(offset, limit + offset);

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

  private async startHistoryImport(
    ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>> & Types.CommandContextExtn,
  ) {
    const messageId = ctx.message.message_id;
    if (this.isMediaImporting) {
      await ctx.reply('😡 Я тут працюю, тужуся, а ти відволікаєш.', {
        reply_parameters: { message_id: messageId },
      });
      return;
    }

    const importWindow = this.parseImportWindow(ctx.payload);

    this.isMediaImporting = true;
    try {
      const chatId = ctx.chat.id;
      const chatStateRepository = this.dataSource.getRepository(ChatState);
      const chatState = await chatStateRepository.findOneBy({ chatId: String(chatId) });
      const isMediaImported = chatState?.isMediaImported ?? false;
      const isVideoImportedByFrames = chatState?.isVideoImportedByFrames ?? false;

      // Case 2: Need to reindex videos only
      if (isMediaImported && !isVideoImportedByFrames) {
        await ctx.reply('🎬 Переіндексовую відео з новим форматом (по кадрах)...', {
          reply_parameters: { message_id: messageId },
        });

        // Reindex videos with frames
        // Note: old video entries (imported from thumbnails with mediaType='photo')
        // will be deleted automatically in importChatMessages for each message
        const stats = await this.importChatMessages(chatId, messageId, { filter: new Api.InputMessagesFilterVideo() });

        chatState!.isVideoImportedByFrames = true;
        await chatStateRepository.save(chatState!);

        await ctx.reply(`😮‍💨 Відео переіндексовано!\n${this.formatImportStats(stats)}`, {
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      // Case 3: already imported. A gap-fill pass has to be asked for
      // explicitly — with a window or `all` — so a stray command does not
      // re-walk the whole history.
      if (isMediaImported && importWindow === undefined) {
        await ctx.reply(
          '🍧 Нема потреби. Усе вже зроблено.\n' +
            'ℹ️ Дошукати пропущені медіа: /starthistoryimport 30 (за 30 днів) або /starthistoryimport all (уся історія).',
          { reply_parameters: { message_id: messageId } },
        );
        return;
      }

      // Case 1 (never imported) and Case 3 (already imported) share the same
      // gap-fill pass: walk the chat's media and embed only what the DB lacks.
      // Live handlers keep writing to the DB regardless of import state, so
      // resuming from max(messageId) would skip everything older than the
      // newest live message — hence no cursor, only the skip set.
      const sinceDays = typeof importWindow === 'number' ? importWindow : undefined;
      const windowLabel = sinceDays ? `за останні ${sinceDays} дн.` : 'за всю історію';
      await ctx.reply(
        isMediaImported
          ? `🧹 Шукаю пропущені медіа ${windowLabel}...`
          : `🏃 Взяв у роботу! Імпортую медіа ${windowLabel}...`,
        { reply_parameters: { message_id: messageId } },
      );

      const stats = await this.importChatMessages(chatId, messageId, { sinceDays });

      if (!isMediaImported) {
        const newChatState = new ChatState();
        newChatState.chatId = String(chatId);
        newChatState.isMediaImported = true;
        newChatState.isVideoImportedByFrames = true;
        await chatStateRepository.save(newChatState);
      }

      await ctx.reply(this.formatImportResult(stats), {
        reply_parameters: { message_id: messageId },
      });
    } catch (e) {
      console.log(e);
      await ctx.reply('📛 Халепа!', {
        reply_parameters: { message_id: messageId },
      });
    } finally {
      this.isMediaImporting = false;
    }
  }

  /**
   * Process a video message from Telegram API and return ChatPhotoMessage entities
   */
  private async processVideoFromApi(
    videoApi: Api.Document,
    chatId: number,
    messageId: number,
    lastMessageId: number,
  ): Promise<ChatPhotoMessage[]> {
    const t1 = performance.now();
    const { id, fileReference, accessHash } = videoApi;
    const fileLocation = new Api.InputDocumentFileLocation({ id, fileReference, accessHash, thumbSize: '' });
    const videoBuffer = await this.tgClient!.downloadFile(fileLocation);

    if (!(videoBuffer instanceof Buffer)) {
      return [];
    }

    // Extract frames from video
    const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);

    if (frames.length === 0) {
      return [];
    }

    // Process each frame
    const chatPhotoMessages: ChatPhotoMessage[] = [];
    for (const frame of frames) {
      try {
        const rawImage = await this.videoService.frameBufferToRawImage(frame.buffer);
        const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
        const imageEmbeddingString = JSON.stringify(imageEmbedding);

        const chatPhotoMessage = new ChatPhotoMessage();
        chatPhotoMessage.chatId = String(chatId);
        chatPhotoMessage.messageId = String(messageId);
        chatPhotoMessage.mediaType = 'video';
        chatPhotoMessage.frameIndex = frame.frameIndex;
        chatPhotoMessage.embedding = imageEmbeddingString;
        chatPhotoMessages.push(chatPhotoMessage);
      } catch (e) {
        console.log(`Error processing frame ${frame.frameIndex} of video ${messageId}:`, e);
      }
    }

    const t2 = performance.now();
    console.log(
      `Imported video ${messageId}/${lastMessageId} ${Math.round((messageId / lastMessageId) * 1e4) / 1e2}% (${frames.length} frames, ${Math.round(t2 - t1)} ms)`,
    );

    return chatPhotoMessages;
  }

  /**
   * Process a photo message from Telegram API and return ChatPhotoMessage entity
   */
  private async processPhotoFromApi(
    photoApi: Api.Photo,
    chatId: number,
    messageId: number,
    lastMessageId: number,
  ): Promise<ChatPhotoMessage | null> {
    const t1 = performance.now();
    const { id, fileReference, accessHash } = photoApi;
    const thumbSize = photoApi.sizes.at(-1)?.type ?? 'm';
    const fleLocation = new Api.InputPhotoFileLocation({ id, fileReference, accessHash, thumbSize });
    const imageBuffer = await this.tgClient!.downloadFile(fleLocation);

    if (!(imageBuffer instanceof Buffer)) {
      return null;
    }

    // Get image embedding
    const rawImage = await this.aiService.getRawImageFromBuffer(imageBuffer);
    const imageEmbedding = await this.aiService.getImageClipEmbedding(rawImage);
    const imageEmbeddingString = JSON.stringify(imageEmbedding);

    // Create entity
    const chatPhotoMessage = new ChatPhotoMessage();
    chatPhotoMessage.chatId = String(chatId);
    chatPhotoMessage.messageId = String(messageId);
    chatPhotoMessage.mediaType = 'photo';
    chatPhotoMessage.frameIndex = 0;
    chatPhotoMessage.embedding = imageEmbeddingString;

    const t2 = performance.now();
    console.log(
      `Imported photo ${messageId}/${lastMessageId} ${Math.round((messageId / lastMessageId) * 1e4) / 1e2}% (${Math.round(t2 - t1)} ms)`,
    );

    return chatPhotoMessage;
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

  /**
   * `/starthistoryimport` takes an optional window: a positive number of days,
   * or `all` for the whole history. Anything else counts as no argument.
   */
  private parseImportWindow(payload: string): number | 'all' | undefined {
    const arg = payload.trim().toLowerCase();
    if (arg === 'all') return 'all';
    const days = Number(arg);
    return arg && Number.isInteger(days) && days > 0 ? days : undefined;
  }

  private formatImportStats({ photos, videos, total }: ImportStats): string {
    const added = photos + videos;
    // No breakdown when nothing was added — "0 (📷 0, 🎬 0)" is just noise
    const addedLine = added > 0 ? `📥 Додано: ${added} (📷 ${photos}, 🎬 ${videos})` : '📥 Додано: 0';
    return `${addedLine}\n🗂 Усього в базі: ${total}`;
  }

  /**
   * Headline scaled to the work done. A video costs a download plus five
   * frames, so it weighs more than a photo when picking the tone.
   */
  private formatImportResult(stats: ImportStats): string {
    const { photos, videos } = stats;
    const effort = photos + videos * 5;
    let headline: string;
    if (effort === 0) headline = '🤷 Нічого нового — усе вже було на місці.';
    else if (effort <= 20) headline = '😌 Легко! Кілька штук — і готово.';
    else if (effort <= 200) headline = '💪 Непогано попрацював.';
    else if (effort <= 2000) headline = '😮‍💨 Фух... Усе підтягнув!';
    else if (effort < 10_000) headline = '🥵 Оце була робота! Ледь не впав.';
    else headline = '🏋️ Це був справжній марафон.';
    return `${headline}\n${this.formatImportStats(stats)}`;
  }

  /**
   * Resolves the id of the newest message older than `sinceDays`, so a date
   * window can be walked with the well-trodden `offsetId + reverse` path.
   * `offsetDate` is not passed to the filtered iterator on purpose: gramjs maps
   * it to `maxDate` of `messages.Search`, whose meaning under `reverse` is murky.
   */
  private async resolveMessageIdBeforeDays(chatId: number, sinceDays: number): Promise<number> {
    const offsetDate = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60; // unix seconds
    const [message] = await this.tgClient!.getMessages(chatId, { limit: 1, offsetDate });
    return message?.id ?? 0;
  }

  /**
   * Walks the chat's media and embeds what the DB lacks. Returns how many
   * messages were added by type plus the chat's total media count afterwards.
   *
   * A message is skipped when it already has rows of the media type being
   * walked. For the videos-only walk that means `mediaType='video'`, so legacy
   * thumbnail rows (`mediaType='photo'`) do not count and get replaced — which
   * also makes the reindex resumable after a crash.
   *
   * @param options.sinceDays - Only look at messages from the last N days; default is the whole history
   * @param options.filter - Which media to walk; default is photos + videos
   */
  private async importChatMessages(
    chatId: number,
    lastMessageId: number,
    options: { sinceDays?: number; filter?: Api.TypeMessagesFilter } = {},
  ): Promise<ImportStats> {
    const { sinceDays, filter = new Api.InputMessagesFilterPhotoVideo() } = options;
    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);
    const added = { photos: 0, videos: 0 };

    const apiId = this.configService.get('TG_API_ID');
    const apiHash = this.configService.get('TG_API_HASH');
    const stringSession = new sessions.StringSession(this.configService.get('TG_API_SESSION'));
    this.tgClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await this.tgClient.connect();

    try {
      const offsetId = sinceDays ? await this.resolveMessageIdBeforeDays(chatId, sinceDays) : 0;

      // Only ids the walk can meet: newer than the window start, of the walked media type
      const existingQuery = chatPhotoMessageRepository
        .createQueryBuilder('msg')
        .select('DISTINCT msg.messageId', 'messageId')
        .where('msg.chatId = :chatId', { chatId: String(chatId) })
        .andWhere('msg.messageId > :offsetId', { offsetId });
      if (filter instanceof Api.InputMessagesFilterVideo) {
        existingQuery.andWhere('msg.mediaType = :mediaType', { mediaType: 'video' });
      }
      const existingRows = await existingQuery.getRawMany<{ messageId: string }>();
      const existingMessageIds = new Set(existingRows.map(({ messageId }) => Number(messageId)));

      for await (const message of this.tgClient.iterMessages(chatId, { offsetId, reverse: true, filter })) {
        if (existingMessageIds.has(message.id)) continue;

        if (message.video) {
          try {
            // Replace legacy thumbnail rows when reindexing; a no-op on a plain gap-fill
            await chatPhotoMessageRepository.delete({
              chatId: String(chatId),
              messageId: String(message.id),
            });

            const chatPhotoMessages = await this.processVideoFromApi(message.video, chatId, message.id, lastMessageId);
            if (chatPhotoMessages.length > 0) {
              await this.dataSource.manager.save(chatPhotoMessages);
              added.videos++;
            }
          } catch (e) {
            console.log(chatId, message.id, 'video', e);
          }
        } else if (message.photo) {
          try {
            const photo = message.photo as Api.Photo;
            const chatPhotoMessage = await this.processPhotoFromApi(photo, chatId, message.id, lastMessageId);
            if (chatPhotoMessage) {
              await this.dataSource.manager.save(chatPhotoMessage);
              added.photos++;
            }
          } catch (e) {
            console.log(chatId, message.id, 'photo', e);
          }
        }
      }
    } finally {
      await this.tgClient.destroy();
      this.tgClient = null;
    }

    // Video frames share a messageId, so count messages rather than rows
    const totalRow = await chatPhotoMessageRepository
      .createQueryBuilder('msg')
      .select('COUNT(DISTINCT msg.messageId)', 'count')
      .where('msg.chatId = :chatId', { chatId: String(chatId) })
      .getRawOne<{ count: string }>();

    return { ...added, total: parseInt(totalRow?.count ?? '0', 10) };
  }

  async dispose() {
    await this.aiService.dispose();
  }
}
