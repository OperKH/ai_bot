import { setTimeout as sleep } from 'node:timers/promises';
import { Context, NarrowedContext } from 'telegraf';
import { CallbackQuery, Message, Update } from 'telegraf/types';
import { message } from 'telegraf/filters';
import { TelegramClient, Api, sessions, errors } from 'telegram';
import { FindOptionsWhere, LessThan } from 'typeorm';
import { Command } from './command.class';
import { IBotContext } from '../context/context.interface';
import { AIService, FrameEmbedding } from '../../services/ai.service';
import { VideoService } from '../../services/video.service';
import { ChatPhotoMessage, ChatState, MediaSearch } from '../../entity/index';
import { findIgnoredMedia, findSimilarMedia } from '../../dataSource/vectorSearch';
import { getLinkChatId } from '../../utils/telegram.utils.js';
import { MatchReplyPort, parseMoreCallback, replyWithDuplicates, showSearchPage } from './mediaMatchReplies';

/** Media messages added during an import so far */
type ImportCounters = { photos: number; videos: number };

type MessageContext = NarrowedContext<IBotContext, Update.MessageUpdate<Message>>;

/**
 * A context that can reply in a chat: a message, or a button press under one.
 * Imports and searches are started either way, by a command or by a button.
 */
type ReplyContext = MessageContext | Context<Update.CallbackQueryUpdate<CallbackQuery>>;

/** How often the running tally is logged, in added messages */
const IMPORT_TALLY_EVERY = 100;

/** Callback data of the keyboard offered when an import breaks: `himp-r`, `himp-r-30`, `himp-r-all`, `himp-c` */
const IMPORT_ACTION_RE = /^himp-(r|c)(?:-(\d+|all))?$/;

/** How long a "Ще" button keeps working; older searches are removed, and their buttons with them */
const SEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often expired searches are looked for */
const SEARCH_CLEANUP_EVERY_MS = 60 * 60 * 1000;

export class MediaTrackerCommand extends Command {
  public command = 'searchmedia';
  public description = '[text] 🖼 Пошук медіа за описом';
  private aiService = AIService.getInstance();
  private videoService = VideoService.getInstance();
  private tgClient: TelegramClient | null = null;
  private isMediaImporting = false;
  private searchCleanupTimer: NodeJS.Timeout | undefined;

  handle(): void {
    // The first pass also catches up on what expired while the bot was down
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.removeExpiredSearches();
    this.searchCleanupTimer = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.removeExpiredSearches();
    }, SEARCH_CLEANUP_EVERY_MS).unref();

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
        const search = await this.createSearch(ctx.chat.id, ctx.payload);
        await this.searchAndReplyPaginated(ctx, ctx.message.message_id, search);
      } else {
        await ctx.reply(`ℹ️ Додай пошуковий запит після команди, наприклад: /${this.command} ігрова консоль`, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
    });
    // Any `islm-` button: the old ones carry JSON and are told to search again
    this.bot.action(/^islm-/, async (ctx) => {
      const searchId = parseMoreCallback(ctx.match.input);
      const search =
        searchId === null || !ctx.chat
          ? null
          : await this.dataSource.getRepository(MediaSearch).findOneBy({ id: searchId, chatId: String(ctx.chat.id) });
      if (!search) {
        await ctx.answerCbQuery(`🙈 Цей пошук застарів, повтори /${this.command}`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        return;
      }
      await ctx.answerCbQuery();
      await this.searchAndReplyPaginated(ctx, undefined, search);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    });
    this.bot.command('starthistoryimport', async (ctx) => {
      // Run in background and release the update slot
      this.runImportInBackground(ctx, ctx.chat.id, ctx.message.message_id, this.parseImportWindow(ctx.payload));
    });
    // Keyboard offered when an import breaks partway. Either answer hides it,
    // so the dead buttons cannot be pressed again later.
    this.bot.action(IMPORT_ACTION_RE, async (ctx) => {
      const [, action, window] = ctx.match;
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      if (action === 'c') {
        await ctx.reply('🆗 Гаразд, залишаю як є.');
        return;
      }

      // The keyboard rides on a message the bot just sent, so this is only
      // missing if Telegram considers it inaccessible — nothing to reply to
      const message = ctx.callbackQuery.message;
      if (!message) return;

      this.runImportInBackground(ctx, message.chat.id, message.message_id, this.parseImportWindow(window ?? ''));
    });
  }

  private async photoMessageHandler(ctx: MessageContext, fileId: string) {
    if (this.isMediaImporting) return;

    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const embedding = await this.aiService.getEmbeddingStringByImageUrl(fileUrl);
    await this.trackMedia(ctx, 'photo', [{ frameIndex: 0, embedding }]);
  }

  private async videoMessageHandler(ctx: MessageContext, fileId: string) {
    if (this.isMediaImporting) return;

    const frameEmbeddings = await this.embedVideo(fileId);
    if (frameEmbeddings.length === 0) {
      console.log('No frame embeddings for the video, skipping');
      return;
    }
    await this.trackMedia(ctx, 'video', frameEmbeddings);
  }

  /**
   * Downloads a video and embeds its frames. A call of its own, so the video and
   * its frames can be collected before the replies go out: a suspended async
   * function keeps all its locals alive, used or not.
   */
  private async embedVideo(fileId: string): Promise<FrameEmbedding[]> {
    const fileUrl = await this.bot.telegram.getFileLink(fileId);
    const videoBuffer = await fetch(fileUrl.href)
      .then((res) => res.arrayBuffer())
      .then((ab) => Buffer.from(ab));
    const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);
    return this.aiService.getFrameEmbeddings(frames);
  }

  /**
   * What a photo and a video share once their embeddings are in hand (a photo has
   * one, a video one per frame): unless the media is on the ignore list, point at
   * the earlier messages it repeats; then store it.
   */
  private async trackMedia(ctx: MessageContext, mediaType: 'photo' | 'video', frames: FrameEmbedding[]) {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const embeddings = frames.map(({ embedding }) => embedding);
    const threshold = this.configService.get('MATCH_IMAGE_THRESHOLD');

    try {
      if (await findIgnoredMedia(this.dataSource, chatId, embeddings, threshold)) {
        console.log('mediaIgnored', `https://t.me/c/${getLinkChatId(chatId)}/${messageId}`);
      } else {
        const matches = await findSimilarMedia(this.dataSource, { chatId, embeddings, threshold });
        const limit = this.configService.get('MATCH_IMAGE_COUNT');
        await replyWithDuplicates(this.matchReplyPort(ctx, chatId), messageId, matches, limit);
      }
    } catch (e) {
      console.log(e);
    }

    try {
      const repository = this.dataSource.getRepository(ChatPhotoMessage);
      await repository.save(
        frames.map(({ frameIndex, embedding }) =>
          repository.create({ chatId: String(chatId), messageId: String(messageId), mediaType, frameIndex, embedding }),
        ),
      );
    } catch (e) {
      console.log(e);
    }
  }

  /**
   * Stores a new `/searchmedia` query with its embedding. The same query asked
   * again in the chat starts over and replaces the earlier search, so its "Ще"
   * does not carry on beside the new one. The embedding is computed afresh: an
   * earlier one may come from untranslated text, if the translator was down.
   */
  private async createSearch(chatId: number, text: string): Promise<MediaSearch> {
    const embedding = await this.aiService.getTextClipEmbedding(text);
    await this.removeSearches({ chatId: String(chatId), text });
    const repository = this.dataSource.getRepository(MediaSearch);
    return repository.save(repository.create({ chatId: String(chatId), text, embedding }));
  }

  /** Searches older than a "Ще" button's lifetime go, and so do their buttons */
  private async removeExpiredSearches() {
    try {
      const removed = await this.removeSearches({ createdAt: LessThan(new Date(Date.now() - SEARCH_TTL_MS)) });
      if (removed > 0) console.log(`Removed ${removed} expired searches`);
    } catch (e) {
      console.error('Could not remove expired searches:', e);
    }
  }

  /**
   * Deletes stored searches, taking their "Ще" buttons off first so nobody presses
   * them in vain; returns how many went
   */
  private async removeSearches(where: FindOptionsWhere<MediaSearch>): Promise<number> {
    const repository = this.dataSource.getRepository(MediaSearch);
    const searches = await repository.find({ select: { id: true, chatId: true, buttonMessageId: true }, where });
    for (const { id, chatId, buttonMessageId } of searches) {
      if (buttonMessageId === null) continue;
      try {
        await this.bot.telegram.editMessageReplyMarkup(Number(chatId), Number(buttonMessageId), undefined, {
          inline_keyboard: [],
        });
      } catch (e) {
        // The reply is gone or the bot left the chat: the row goes all the same,
        // and a button that survived answers that the search has expired
        console.log(`Could not take the button off search ${id}:`, e);
      }
    }
    if (searches.length > 0) await repository.delete(searches.map(({ id }) => id));
    return searches.length;
  }

  /** Shows the next page of a search and stores where it stopped (see `showSearchPage`) */
  private async searchAndReplyPaginated(ctx: ReplyContext, firstMessageId: number | undefined, search: MediaSearch) {
    const chatId = Number(search.chatId);
    const embeddingString = JSON.stringify(search.embedding);
    const { cursor, buttonMessageId } = await showSearchPage(this.matchReplyPort(ctx, chatId), {
      text: search.text,
      cursor:
        search.cursorMessageId === null || search.cursorSimilarity === null
          ? null
          : { messageId: search.cursorMessageId, similarity: search.cursorSimilarity },
      firstMessageId,
      limit: this.configService.get('MATCH_IMAGE_COUNT'),
      searchId: search.id,
      find: (after, count) =>
        findSimilarMedia(this.dataSource, {
          chatId,
          embeddings: [embeddingString],
          threshold: this.configService.get('MATCH_TEXT_THRESHOLD'),
          after,
          limit: count,
        }),
    });
    await this.dataSource.getRepository(MediaSearch).update(search.id, {
      cursorSimilarity: cursor?.similarity ?? null,
      cursorMessageId: cursor?.messageId ?? null,
      buttonMessageId: buttonMessageId === null ? null : String(buttonMessageId),
    });
  }

  /** Telegram and the database behind the replies of `mediaMatchReplies` */
  private matchReplyPort(ctx: ReplyContext, chatId: number): MatchReplyPort {
    return {
      send: async (text, replyToId) => {
        const sent = await ctx.reply(
          text,
          replyToId === undefined ? undefined : { reply_parameters: { message_id: replyToId } },
        );
        return sent.message_id;
      },
      replyToEarlier: async (replyToId, text, moreCallbackData) => {
        const reply = await ctx.reply(text, {
          reply_parameters: { message_id: replyToId, allow_sending_without_reply: true },
          disable_notification: true,
          reply_markup:
            moreCallbackData === undefined
              ? undefined
              : { inline_keyboard: [[{ text: 'Ще', callback_data: moreCallbackData }]] },
        });
        return { messageId: reply.message_id, attached: Boolean(reply.reply_to_message) };
      },
      delete: async (messageId) => {
        await ctx.deleteMessage(messageId);
      },
      forget: async (messageId) => {
        await this.dataSource.getRepository(ChatPhotoMessage).delete({ chatId: String(chatId), messageId });
        console.log('mediaDeleted', `https://t.me/c/${getLinkChatId(chatId)}/${messageId}`);
      },
      pause: () => sleep(1000),
    };
  }

  /**
   * An import runs for hours, so it is started without await to free the update
   * slot — which also means nothing is left on the stack to catch a rejection.
   * `startHistoryImport` reports its own failures, but the reply it sends can
   * throw in turn, and that one has nowhere to go.
   */
  private runImportInBackground(
    ctx: ReplyContext,
    chatId: number,
    messageId: number,
    importWindow: number | 'all' | undefined,
  ) {
    this.startHistoryImport(ctx, chatId, messageId, importWindow).catch((e) =>
      console.error('History import failed:', e),
    );
  }

  /**
   * @param messageId - What replies attach to; doubles as the newest message id, the progress denominator
   * @param importWindow - The `/starthistoryimport` argument, carried as-is through a retry
   */
  private async startHistoryImport(
    ctx: ReplyContext,
    chatId: number,
    messageId: number,
    importWindow: number | 'all' | undefined,
  ) {
    if (this.isMediaImporting) {
      await ctx.reply('😡 Я тут працюю, тужуся, а ти відволікаєш.', {
        reply_parameters: { message_id: messageId },
      });
      return;
    }

    // Owned here, not inside the walk: an import runs for hours, and whatever
    // it got through has to be reportable even when it ends in a throw
    const added: ImportCounters = { photos: 0, videos: 0 };

    this.isMediaImporting = true;
    try {
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
        const total = await this.importChatMessages(chatId, messageId, added, {
          filter: new Api.InputMessagesFilterVideo(),
        });

        chatState!.isVideoImportedByFrames = true;
        await chatStateRepository.save(chatState!);

        await ctx.reply(`😮‍💨 Відео переіндексовано!\n${this.formatImportStats(added, total)}`, {
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
      const windowLabel = sinceDays ? `за ${this.formatLastDays(sinceDays)}` : 'за всю історію';
      await ctx.reply(
        isMediaImported
          ? `🧹 Шукаю пропущені медіа ${windowLabel}...`
          : `🏃 Взяв у роботу! Імпортую медіа ${windowLabel}...`,
        { reply_parameters: { message_id: messageId } },
      );

      const total = await this.importChatMessages(chatId, messageId, added, { sinceDays });

      if (!isMediaImported) {
        const newChatState = new ChatState();
        newChatState.chatId = String(chatId);
        newChatState.isMediaImported = true;
        newChatState.isVideoImportedByFrames = true;
        await chatStateRepository.save(newChatState);
      }

      await ctx.reply(this.formatImportResult(added, total), {
        reply_parameters: { message_id: messageId },
      });
    } catch (e) {
      console.log(e);
      // The window rides along in the callback data so the retry repeats the
      // very pass that failed — without it a retry of `/starthistoryimport all`
      // would land in "🍧 Нема потреби"
      const retryWindow = importWindow === undefined ? '' : `-${importWindow}`;
      await ctx.reply(`📛 Халепа! Імпорт обірвався.\n${this.formatAdded(added)}\nℹ️ Продовжити з того ж місця?`, {
        reply_parameters: { message_id: messageId },
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔁 Продовжити', callback_data: `himp-r${retryWindow}` },
              { text: '🚫 Скасувати', callback_data: 'himp-c' },
            ],
          ],
        },
      });
    } finally {
      this.isMediaImporting = false;
    }
  }

  /**
   * A `file_reference` has a lifetime, and the one that arrives with a
   * `messages.Search` page is already dead for part of the older media by the
   * time the walk reaches it — `upload.GetFile` then answers FILE_REFERENCE_EXPIRED.
   * Telegram's remedy is to ask for the message again: the same file comes back
   * with a fresh reference. One retry is enough, a reference seconds old does
   * not expire twice.
   *
   * Unlike the 429 handling in `wrapCallApi`, this cannot sit in a wrapper
   * around the client: recovering needs the message the file came from, which
   * only the caller knows.
   */
  private async downloadMedia(media: Api.Photo | Api.Document, chatId: number, messageId: number) {
    try {
      return await this.downloadMediaFile(media);
    } catch (e) {
      if (!MediaTrackerCommand.isFileReferenceExpired(e)) throw e;
      const [message] = await this.tgClient!.getMessages(chatId, { ids: [messageId] });
      const fresh = media instanceof Api.Photo ? message?.photo : message?.video;
      // The message can be gone by now, or no longer carry media of this kind
      if (!(fresh instanceof Api.Photo || fresh instanceof Api.Document)) return null;
      console.log(`Refreshed the file reference of ${chatId} ${messageId}`);
      return this.downloadMediaFile(fresh);
    }
  }

  private async downloadMediaFile(media: Api.Photo | Api.Document) {
    const { id, fileReference, accessHash } = media;
    const thumb = media instanceof Api.Photo ? media.sizes.at(-1) : undefined;
    const location =
      media instanceof Api.Photo
        ? new Api.InputPhotoFileLocation({ id, fileReference, accessHash, thumbSize: thumb?.type ?? 'm' })
        : new Api.InputDocumentFileLocation({ id, fileReference, accessHash, thumbSize: '' });
    const buffer = await this.tgClient!.downloadFile(location);
    if (!(buffer instanceof Buffer)) return null;

    // A short download still parses: a truncated mp4 makes ffprobe fail with
    // "moov atom not found", or yields a duration and then loses every frame to
    // the missing media data. Comparing against the byte count Telegram already
    // stated names the failure instead of leaving it to the decoder, and the
    // next gap-fill pass retries the message.
    const expectedSize = media instanceof Api.Photo ? MediaTrackerCommand.photoSizeBytes(thumb) : Number(media.size);
    if (expectedSize !== undefined && buffer.length !== expectedSize) {
      throw new Error(`Truncated download: got ${buffer.length} of ${expectedSize} bytes`);
    }
    return buffer;
  }

  /**
   * Only a plain `PhotoSize` states the bytes of the file that gets downloaded.
   * A progressive one lists the prefix length of each scan instead, so it is
   * left unchecked rather than guessed at — a wrong expectation here would
   * reject every photo it applies to.
   */
  private static photoSizeBytes(thumb: Api.TypePhotoSize | undefined): number | undefined {
    return thumb instanceof Api.PhotoSize ? thumb.size : undefined;
  }

  private static isFileReferenceExpired(error: unknown): boolean {
    return error instanceof errors.RPCError && error.errorMessage === 'FILE_REFERENCE_EXPIRED';
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
    const videoBuffer = await this.downloadMedia(videoApi, chatId, messageId);

    if (!videoBuffer) {
      return [];
    }

    // Extract frames from video
    const frames = await this.videoService.extractFramesFromBuffer(videoBuffer);

    if (frames.length === 0) {
      return [];
    }

    const chatPhotoMessages = (await this.aiService.getFrameEmbeddings(frames)).map(({ frameIndex, embedding }) => {
      const chatPhotoMessage = new ChatPhotoMessage();
      chatPhotoMessage.chatId = String(chatId);
      chatPhotoMessage.messageId = String(messageId);
      chatPhotoMessage.mediaType = 'video';
      chatPhotoMessage.frameIndex = frameIndex;
      chatPhotoMessage.embedding = embedding;
      return chatPhotoMessage;
    });

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
    const imageBuffer = await this.downloadMedia(photoApi, chatId, messageId);

    if (!imageBuffer) {
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

  /** Ukrainian plural for a day count: 1 день, 2 дні, 5 днів, 21 день */
  private formatLastDays(days: number): string {
    if (days === 1) return 'останній день';
    const tail = days % 100 >= 11 && days % 100 <= 14 ? 0 : days % 10;
    const noun = tail === 1 ? 'день' : tail >= 2 && tail <= 4 ? 'дні' : 'днів';
    return `останні ${days} ${noun}`;
  }

  private formatAdded({ photos, videos }: ImportCounters): string {
    const added = photos + videos;
    // No breakdown when nothing was added — "0 (📷 0, 🎬 0)" is just noise
    return added > 0 ? `📥 Додано: ${added} (📷 ${photos}, 🎬 ${videos})` : '📥 Додано: 0';
  }

  private formatImportStats(added: ImportCounters, total: number): string {
    return `${this.formatAdded(added)}\n🗂 Усього в базі: ${total}`;
  }

  /**
   * Headline scaled to the work done. A video costs a download plus five
   * frames, so it weighs more than a photo when picking the tone.
   */
  private formatImportResult(added: ImportCounters, total: number): string {
    const { photos, videos } = added;
    const effort = photos + videos * 5;
    let headline: string;
    if (effort === 0) headline = '🤷 Нічого нового — усе вже було на місці.';
    else if (effort <= 20) headline = '😌 Легко! Кілька штук — і готово.';
    else if (effort <= 200) headline = '💪 Непогано попрацював.';
    else if (effort <= 2000) headline = '😮‍💨 Фух... Усе підтягнув!';
    else if (effort < 10_000) headline = '🥵 Оце була робота! Ледь не впав.';
    else headline = '🏋️ Це був справжній марафон.';
    return `${headline}\n${this.formatImportStats(added, total)}`;
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
   * @param added - Caller-owned tally, mutated as the walk goes, so a run that dies partway is still reportable
   * @param options.sinceDays - Only look at messages from the last N days; default is the whole history
   * @param options.filter - Which media to walk; default is photos + videos
   * @returns The chat's media count once the walk is done
   */
  private async importChatMessages(
    chatId: number,
    lastMessageId: number,
    added: ImportCounters,
    options: { sinceDays?: number; filter?: Api.TypeMessagesFilter } = {},
  ): Promise<number> {
    const { sinceDays, filter = new Api.InputMessagesFilterPhotoVideo() } = options;
    const chatPhotoMessageRepository = this.dataSource.getRepository(ChatPhotoMessage);

    // A pass over a large history runs for hours, so the tally has to survive
    // the process dying — `countAdded` logs it as it goes, bounding what a
    // hard kill can lose to IMPORT_TALLY_EVERY
    console.log(`Import start: chat ${chatId} has ${await this.countChatMedia(chatId)} media messages`);

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
              this.countAdded(added, 'videos');
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
              this.countAdded(added, 'photos');
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

    return this.countChatMedia(chatId);
  }

  /** Video frames share a messageId, so this counts messages rather than rows */
  private async countChatMedia(chatId: number): Promise<number> {
    const totalRow = await this.dataSource
      .getRepository(ChatPhotoMessage)
      .createQueryBuilder('msg')
      .select('COUNT(DISTINCT msg.messageId)', 'count')
      .where('msg.chatId = :chatId', { chatId: String(chatId) })
      .getRawOne<{ count: string }>();
    return parseInt(totalRow?.count ?? '0', 10);
  }

  /**
   * Counting and logging live together so the tally cannot drift: the periodic
   * line only lands because every increment passes through here, one at a time.
   */
  private countAdded(added: ImportCounters, kind: keyof ImportCounters) {
    added[kind]++;
    const total = added.photos + added.videos;
    if (total % IMPORT_TALLY_EVERY === 0) {
      console.log(`Import tally: added ${total} (📷 ${added.photos}, 🎬 ${added.videos})`);
    }
  }

  async dispose() {
    clearInterval(this.searchCleanupTimer);
  }
}
