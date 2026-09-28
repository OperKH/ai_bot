import type { CallbackQueryContext, CommandContext, InlineKeyboard } from 'grammy';
import type { InputRichMessage, Message, PollAnswer, RichBlock } from 'grammy/types';
import { Command } from './command.class';
import { BackgroundQueue } from '../backgroundQueue';
import { AIService } from '../../services/ai.service';
import type { Embedder } from '../../crow/embeddings';
import { isForbiddenTelegramError } from '../bot.class';
import { OwnerAlerts } from '../ownerAlerts';
import { timeZonePicker } from './timeZone.command';
import { zoneLabel } from './timeZones';
import type { BotContext } from '../context/context.interface';
import { getLinkChatId, supergroupMessageLink } from '../telegramLinks';
import { BOLDNESS } from '../../crow/cadence';
import { findCategory } from '../../crow/categories';
import { BetKeeper } from '../../crow/bets';
import {
  betOwnerKeyboard,
  betOwnerText,
  budgetAlertText,
  type CrowAction,
  type MenuMessage,
  type MenuSettings,
  menuKeyboard,
  menuText,
  nextBoldness,
  nextQuietHours,
  OpenMenus,
  ownerKeyboard,
  parseCrowCallback,
  PRIVATE_CHAT_TEXT,
  quietLabel,
  SHOO_REPLY,
  shooKeyboard,
  shooOutcome,
  snoozeLeft,
  TOASTS,
} from '../../crow/crowMenu';
import { WITHOUT_SHOO } from '../../crow/dispatch';
import { CrowConversation, heardMessage } from '../../crow/conversation';
import type { CrowJobDefinition } from '../../crow/jobs';
import { CrowLlm } from '../../crow/crowLlm';
import { EveningGoodbyes } from '../../crow/evening';
import { CrowEvents } from '../../crow/events';
import { STREAM_SOURCES } from '../../crow/sources/streamSources';
import { MorningDigests } from '../../crow/morning';
import { ChatProfiles, JabWriter } from '../../crow/profile';
import { CrowPipeline } from '../../crow/pipeline';
import { AI_SOURCES } from '../../crow/sources/aiSources';
import { GAME_SOURCES } from '../../crow/sources/gameSources';
import { Birthdays, type CatNames } from '../../crow/birthday';
import { Countdowns } from '../../crow/countdowns';
import { dropOldImages } from '../../crow/images';
import { ReleaseRadar } from '../../crow/releases';
import { CrowScheduler, type OutgoingPoll, type OutgoingPost, type SentPost } from '../../crow/scheduler';
import { WeeklyDigests } from '../../crow/weekly';
import { catName } from '../../crow/words';
import { CrowStore, type DueBet } from '../../crow/store';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** «🔇 Заткнись на 3 год» */
const SNOOZE_MS = 3 * HOUR;
/** The cats who shoo the crow away with «Кш!» send her away for this long */
const SHOO_SNOOZE_MS = HOUR;
/** How long a user's admin status is trusted before asking Telegram again */
const ADMIN_CACHE_MS = 5 * MINUTE;

/** EmbeddingGemma, shared with the bot's other models: the crow's vectors of talks, details and entries */
const embedTexts: Embedder = (texts, task) => AIService.getInstance().getTextEmbeddings(texts, task);

/** The pictures of a sent rich message in order, a collage's among them: the largest size of each */
function photoFileIds(blocks: RichBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'collage') return photoFileIds(block.blocks);
    const fileId = block.type === 'photo' ? block.photo.at(-1)?.file_id : undefined;
    return fileId ? [fileId] : [];
  });
}

/**
 * The news crow (docs/crow/): `/crow` sets what it brings into the chat and
 * how pushy it is, the scheduler posts the arcs of its stories, and she answers
 * the cats who talk to her or about her stories. The menu is ephemeral — only
 * the one who asked sees it, and it does not clutter the chat.
 */
export class CrowCommand extends Command {
  public command = 'crow';
  public description = '🐦‍⬛ Налаштувати новини від ворони';
  private store!: CrowStore;
  private scheduler?: CrowScheduler;
  private conversation!: CrowConversation;
  private bets!: BetKeeper;
  /** A talk's answer takes the model seconds, so it is written apart from the update queue */
  private readonly talks = new BackgroundQueue('Crow talk');
  private readonly adminCache = new Map<string, { isAdmin: boolean; until: number }>();
  private readonly menus = new OpenMenus();

  handle(): void {
    this.store = new CrowStore(this.dataSource);
    const llm = new CrowLlm();
    const scheduler = new CrowScheduler(
      this.store,
      {
        send: (post) => this.sendPost(post),
        sendPoll: (chatId, poll, replyToMessageId, loud) => this.sendPoll(chatId, poll, replyToMessageId, loud),
        dropShoo: async (chatId, messageId) => {
          await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
        },
        isChatGone: isForbiddenTelegramError,
      },
      this.jobs(llm),
    );
    this.scheduler = scheduler;
    this.conversation = new CrowConversation(
      this.store,
      { talk: (request) => llm.conversation(request), told: (request) => llm.told(request) },
      (post) => scheduler.sendTalk(post),
      undefined,
      {
        embed: embedTexts,
        talkThreshold: this.configService.get('CROW_TALK_THRESHOLD'),
        forwardThreshold: this.configService.get('CROW_FORWARD_THRESHOLD'),
      },
    );
    scheduler.start().catch((e) => console.error('[Crow] Failed to start the scheduler:', e));

    this.bot.command(this.command, (ctx) => this.showMenu(ctx));
    this.bot.callbackQuery(/^crow:/, (ctx) => this.onButton(ctx));
    this.bot.on('poll_answer', (ctx) => this.onPollAnswer(ctx.pollAnswer));
    // After the other commands, which pass every message on: the crow may answer it
    this.bot.on('message', async (ctx, next) => {
      await this.hear(ctx.msg, ctx.me.username);
      return next();
    });
  }

  /** A message of a chat: whether it is for the crow is decided at once, her answer is written in the background */
  private async hear(message: Message, botUsername: string) {
    const heard = heardMessage(message);
    if (!heard) return;
    try {
      const answer = await this.conversation.hear(heard, botUsername);
      if (answer) this.talks.push(answer);
    } catch (e) {
      console.error(`[Crow] Could not hear a message in chat ${getLinkChatId(message.chat.id)}:`, e);
    }
  }

  /**
   * Polling the sources, turning their news into arcs, the morning digests and evening goodbyes, the weekly
   * digests and the bets, the chats' profiles, and cleaning up
   */
  private jobs(llm: CrowLlm): CrowJobDefinition[] {
    this.bets = new BetKeeper(
      this.store,
      { resolve: (request) => llm.resolveBet(request), outcome: (request) => llm.betOutcome(request) },
      {
        stop: (chatId, messageId) => this.bot.api.stopPoll(Number(chatId), messageId),
        askOwner: (bet, reason) => this.askOwnerAboutBet(bet, reason),
      },
    );
    const alerts = new OwnerAlerts(this.bot.api, this.configService.get('TG_OWNER_ID'), this.dataSource);
    const pipeline = new CrowPipeline(
      this.store,
      llm,
      [...AI_SOURCES, ...GAME_SOURCES],
      {
        limitUsd: this.configService.get('OPENAI_CROW_DAILY_BUDGET_USD'),
        onSpent: (report) =>
          alerts.notify('crow-budget', budgetAlertText(report, new Date()), {
            reply_markup: ownerKeyboard(true),
            link_preview_options: { is_disabled: true },
          }),
      },
      new JabWriter(this.store, (request) => llm.jabs(request)),
      embedTexts,
    );
    return [
      ...pipeline.jobs(),
      new MorningDigests(this.store, (request) => llm.morning(request)).job(),
      new EveningGoodbyes(this.store, (request) => llm.goodbye(request)).job(),
      new WeeklyDigests(this.store, (request) => llm.weekly(request), {
        stop: (chatId, messageId) => this.stopPoll(chatId, messageId),
      }).job(),
      this.bets.job(),
      ...new CrowEvents(
        this.store,
        STREAM_SOURCES,
        { extract: (published, text) => llm.stream(published, text), texts: (request) => llm.streamTexts(request) },
        { edit: (chatId, messageId, postId, message, withShoo) => this.editPost(chatId, messageId, postId, message, withShoo) },
        this.configService.get('YOUTUBE_API_KEY'),
      ).jobs(),
      new ChatProfiles(this.store, (messages) => llm.profile(messages)).job(),
      new Countdowns(this.store, (request) => llm.countdown(request)).job(),
      new Birthdays(this.store, (request) => llm.birthday(request), (chatId, userIds) => this.catNames(chatId, userIds)).job(),
      new ReleaseRadar(this.store, {
        releases: (week, materials) => llm.releases(week, materials),
        radar: (request) => llm.radar(request),
      }).job(),
      {
        name: 'cleanup',
        nextRun: (startedAt) => new Date(startedAt.getTime() + 24 * HOUR),
        run: async () => {
          const now = new Date();
          const removed = await this.store.cleanup(now);
          const pictures = await dropOldImages(now);
          console.log(`[Crow] Cleanup: ${removed.posts} posts, ${removed.stories} stories, ${pictures} pictures`);
        },
      },
    ];
  }

  private async sendPoll(
    chatId: number,
    poll: OutgoingPoll,
    replyToMessageId: number | null,
    loud: boolean,
  ): Promise<{ messageId: number; pollId: string }> {
    const sent = await this.bot.api.sendPoll(chatId, poll.question, poll.options, {
      is_anonymous: poll.anonymous,
      ...(poll.quiz
        ? { type: 'quiz', correct_option_ids: [poll.quiz.correctIndex], explanation: poll.quiz.explanation, shuffle_options: true }
        : {}),
      ...(poll.closeDate ? { close_date: Math.floor(poll.closeDate.getTime() / 1000) } : {}),
      ...(poll.description ? { description: poll.description } : {}),
      disable_notification: !loud,
      ...(replyToMessageId === null
        ? {}
        : { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }),
    });
    return { messageId: sent.message_id, pollId: sent.poll.id };
  }

  /** Replaces a sent post of the crow's, such as the announcement of a stream that moved */
  private async editPost(chatId: string, messageId: number, postId: number, message: InputRichMessage, withShoo: boolean) {
    await this.bot.api.editMessageText(Number(chatId), messageId, message, {
      reply_markup: withShoo ? shooKeyboard(postId) : { inline_keyboard: [] },
    });
  }

  /** The names of the chat's cats as Telegram gives them now; a cat gone from the chat, or not found, is left out */
  private async catNames(chatId: string, userIds: string[]): Promise<CatNames> {
    const names: CatNames = new Map();
    for (const userId of userIds) {
      const member = await this.bot.api.getChatMember(Number(chatId), Number(userId)).catch(() => null);
      if (!member || member.status === 'left' || member.status === 'kicked') continue;
      const { first_name, last_name, username } = member.user;
      names.set(userId, { name: [first_name, last_name].filter(Boolean).join(' '), username: username ?? null });
    }
    return names;
  }

  /** Stops a poll of the crow's; the votes of each option, or null when Telegram would not */
  private async stopPoll(chatId: string, messageId: number): Promise<number[] | null> {
    try {
      const poll = await this.bot.api.stopPoll(Number(chatId), messageId);
      return poll.options.map((option) => option.voter_count);
    } catch (e) {
      console.warn(`[Crow] Could not stop poll ${messageId} in chat ${getLinkChatId(Number(chatId))}:`, e);
      return null;
    }
  }

  private async sendPost(post: OutgoingPost): Promise<SentPost> {
    const sent = await this.bot.api.sendRichMessage(post.chatId, post.message, {
      ...(WITHOUT_SHOO.includes(post.kind) ? {} : { reply_markup: shooKeyboard(post.postId) }),
      disable_notification: !post.loud,
      ...(post.replyToMessageId === null
        ? {}
        : { reply_parameters: { message_id: post.replyToMessageId, allow_sending_without_reply: true } }),
    });
    return { messageId: sent.message_id, photoFileIds: photoFileIds(sent.rich_message.blocks) };
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    const key = `${chatId}:${userId}`;
    const cached = this.adminCache.get(key);
    if (cached && cached.until > Date.now()) return cached.isAdmin;
    const member = await this.bot.api.getChatMember(chatId, userId);
    const isAdmin = member.status === 'creator' || member.status === 'administrator';
    this.adminCache.set(key, { isAdmin, until: Date.now() + ADMIN_CACHE_MS });
    return isAdmin;
  }

  private menu(settings: MenuSettings, isAdmin: boolean): { text: string; reply_markup: InlineKeyboard } {
    const now = new Date();
    return {
      text: menuText(settings, now, settings.settingsAdminOnly && !isAdmin),
      reply_markup: menuKeyboard(settings, now, isAdmin),
    };
  }

  /** The menu goes to the caller alone; if Telegram refuses the ephemeral message, to the chat */
  private async showMenu(ctx: CommandContext<BotContext>) {
    if (ctx.chat.type === 'private') {
      await ctx.reply(PRIVATE_CHAT_TEXT);
      return;
    }
    if (!ctx.from) return;
    const settings = await this.store.menuSettings(String(ctx.chat.id), String(ctx.from.id));
    const { text, reply_markup } = this.menu(settings, await this.isAdmin(ctx.chat.id, ctx.from.id));
    let menu: MenuMessage;
    try {
      const sent = await ctx.reply(text, { reply_markup, ephemeral_message_parameters: { receiver_user_id: ctx.from.id } });
      menu = sent.ephemeral_message_id ? { ephemeral: true, id: sent.ephemeral_message_id } : { ephemeral: false, id: sent.message_id };
    } catch (e) {
      console.warn('[Crow] The ephemeral menu failed, sending it to the chat:', e);
      const sent = await ctx.reply(text, { reply_markup, reply_parameters: { message_id: ctx.msg.message_id } });
      menu = { ephemeral: false, id: sent.message_id };
    }
    // The cat's previous menu would go on showing the settings as they were
    const previous = this.menus.opened(ctx.chat.id, ctx.from.id, menu);
    if (previous) await this.takeDown(ctx.chat.id, ctx.from.id, previous);
  }

  /** Deletes a replaced menu; if Telegram refuses, takes its buttons off at least */
  private async takeDown(chatId: number, userId: number, menu: MenuMessage) {
    const api = this.bot.api;
    try {
      if (menu.ephemeral) await api.deleteEphemeralMessage(chatId, userId, menu.id);
      else await api.deleteMessage(chatId, menu.id);
    } catch (e) {
      try {
        const reply_markup = { inline_keyboard: [] };
        if (menu.ephemeral) await api.editEphemeralMessageReplyMarkup(chatId, userId, menu.id, { reply_markup });
        else await api.editMessageReplyMarkup(chatId, menu.id, { reply_markup });
      } catch (e2) {
        console.warn(`[Crow] Could not take down an old menu in chat ${getLinkChatId(chatId)}:`, e, e2);
      }
    }
  }

  /** The menu a button was pressed on */
  private static pressedMenu(ctx: CallbackQueryContext<BotContext>): MenuMessage | null {
    const message = ctx.callbackQuery.message;
    if (!message) return null;
    if ('ephemeral_message_id' in message && message.ephemeral_message_id) return { ephemeral: true, id: message.ephemeral_message_id };
    return { ephemeral: false, id: message.message_id };
  }

  private async onButton(ctx: CallbackQueryContext<BotContext>) {
    const action = parseCrowCallback(ctx.callbackQuery.data);
    if (action?.type === 'reset-budget' || action?.type === 'run-pipeline') {
      await this.onOwnerButton(ctx, action.type);
      return;
    }
    if (action?.type === 'bet-outcome') {
      await this.onBetOutcome(ctx, action.pollId, action.outcome);
      return;
    }
    const chat = ctx.chat;
    if (!action || !chat || chat.type === 'private') {
      await ctx.answerCallbackQuery(TOASTS.stale);
      return;
    }
    const chatId = String(chat.id);
    if (action.type === 'shoo') {
      await this.onShoo(ctx, chatId, action.postId);
      return;
    }
    const pressed = CrowCommand.pressedMenu(ctx);
    if (pressed && this.menus.isReplaced(chat.id, pressed)) {
      await ctx.answerCallbackQuery(TOASTS.staleMenu);
      await this.takeDown(chat.id, ctx.from.id, pressed);
      return;
    }
    if (pressed) this.menus.pressed(chat.id, ctx.from.id, pressed);

    const userId = String(ctx.from.id);
    const isAdmin = await this.isAdmin(chat.id, ctx.from.id);
    const settings = await this.store.menuSettings(chatId, userId);
    if (action.type === 'lock' && !isAdmin) {
      await ctx.answerCallbackQuery(TOASTS.lockAdminOnly);
      return;
    }
    // «🙅 Не чіпай мене» is the cat's own business: the lock does not stop it
    if (settings.settingsAdminOnly && !isAdmin && action.type !== 'optout') {
      await ctx.answerCallbackQuery(TOASTS.adminOnly);
      return;
    }

    if (action.type === 'timezone') {
      await this.offerTimeZone(ctx, chat.id);
      return;
    }
    const { toast, change } = await this.apply(chatId, userId, settings, action);
    console.log(`[Crow] Chat ${getLinkChatId(chat.id)}: ${change}`);
    await ctx.answerCallbackQuery(toast);
    await this.refreshMenu(ctx, await this.store.menuSettings(chatId, userId), isAdmin);
  }

  /** Applies a menu button: its toast, and what changed, for the log */
  private async apply(
    chatId: string,
    userId: string,
    settings: MenuSettings,
    action: Exclude<CrowAction, { type: 'shoo' | 'timezone' | 'reset-budget' | 'run-pipeline' | 'bet-outcome' }>,
  ): Promise<{ toast: string | undefined; change: string }> {
    switch (action.type) {
      case 'sub': {
        const on = !settings.subscriptions.has(action.categoryId);
        await this.store.setSubscription(chatId, action.categoryId, on);
        const category = findCategory(action.categoryId);
        const change = `${on ? 'subscribed to' : 'unsubscribed from'} ${action.categoryId}`;
        if (!on && settings.subscriptions.size === 1) return { toast: TOASTS.allOff, change };
        return { toast: on ? category?.toasts.on : category?.toasts.off, change };
      }
      case 'bold': {
        const boldness = nextBoldness(settings.boldness);
        await this.store.updateChat(chatId, { boldness });
        return { toast: TOASTS.boldness[boldness], change: `boldness ${boldness}` };
      }
      case 'quiet': {
        const [quietFrom, quietTo] = nextQuietHours(settings.quietFrom, settings.quietTo);
        await this.store.updateChat(chatId, { quietFrom, quietTo });
        if (quietFrom === null) return { toast: TOASTS.quietOff, change: 'quiet hours off' };
        const label = quietLabel(quietFrom, quietTo);
        return settings.timeZone === null
          ? { toast: TOASTS.quietOnUtc(label), change: `quiet hours ${label} UTC` }
          : { toast: TOASTS.quietOn(`${label} (${zoneLabel(settings.timeZone)})`), change: `quiet hours ${label} ${settings.timeZone}` };
      }
      case 'snooze': {
        const snoozed = snoozeLeft(settings.snoozedUntil, new Date()) !== null;
        await this.store.updateChat(chatId, { snoozedUntil: snoozed ? null : new Date(Date.now() + SNOOZE_MS) });
        return snoozed
          ? { toast: TOASTS.unsnoozed, change: 'snooze ended' }
          : { toast: TOASTS.snoozed, change: 'snoozed for 3 hours' };
      }
      case 'lock':
        await this.store.updateChat(chatId, { settingsAdminOnly: !settings.settingsAdminOnly });
        return settings.settingsAdminOnly
          ? { toast: TOASTS.lockOff, change: 'settings open to everyone' }
          : { toast: TOASTS.lockOn, change: 'settings locked to admins' };
      case 'jabs':
        await this.store.setPersonalJabs(chatId, !settings.personalJabs, new Date());
        return settings.personalJabs
          ? { toast: TOASTS.jabsOff, change: 'personal jabs off, the profile forgotten' }
          : { toast: TOASTS.jabsOn, change: 'personal jabs on' };
      case 'optout':
        await this.store.setOptedOut(chatId, userId, !settings.optedOut, new Date());
        return settings.optedOut
          ? { toast: TOASTS.optedIn, change: `user ${userId} may be jabbed again` }
          : { toast: TOASTS.optedOut, change: `user ${userId} asked not to be touched` };
    }
  }

  /**
   * «🕰 Задати часовий пояс»: the /timezone picker goes to the chat, as the
   * command would show it; if it cannot, the cat is told to run the command.
   */
  private async offerTimeZone(ctx: CallbackQueryContext<BotContext>, chatId: number) {
    try {
      const { text, reply_markup } = await timeZonePicker(this.dataSource, chatId);
      await ctx.api.sendMessage(chatId, text, { reply_markup });
      await ctx.answerCallbackQuery(TOASTS.timezonePicker);
    } catch (e) {
      console.warn(`[Crow] Could not show the time zone picker in chat ${getLinkChatId(chatId)}:`, e);
      await ctx.answerCallbackQuery(TOASTS.timezoneCommand);
    }
  }

  /**
   * The owner's buttons under an alert, in the private chat: a new budget for today, or the pipeline now.
   * Nobody else sees them, but callback data is not signed — a modified client can send any from under
   * any message with buttons it sees, such as a group's /crow menu — so the presser is checked.
   */
  private async onOwnerButton(ctx: CallbackQueryContext<BotContext>, action: 'reset-budget' | 'run-pipeline') {
    if (ctx.from.id !== this.configService.get('TG_OWNER_ID')) {
      await ctx.answerCallbackQuery(TOASTS.ownerOnly);
      return;
    }
    const now = new Date();
    if (action === 'reset-budget') await this.store.resetBudget(now);
    else await this.store.resumeJob('pipeline', now);
    console.log(`[Crow] The owner ${action === 'reset-budget' ? 'reset the daily budget' : 'ran the pipeline'}`);
    await ctx.answerCallbackQuery(action === 'reset-budget' ? TOASTS.budgetReset : TOASTS.pipelineRun);
  }

  /** The owner says how a bet the crow could not settle ended; checked as the other owner buttons are */
  private async onBetOutcome(ctx: CallbackQueryContext<BotContext>, pollId: number, outcome: number | null) {
    if (ctx.from.id !== this.configService.get('TG_OWNER_ID')) {
      await ctx.answerCallbackQuery(TOASTS.ownerOnly);
      return;
    }
    const settled = await this.bets.settleByOwner(pollId, outcome);
    console.log(`[Crow] The owner settled bet ${pollId}: ${outcome ?? 'called off'}${settled ? '' : ', but it was settled already'}`);
    await ctx.answerCallbackQuery(settled ? TOASTS.betSettled : TOASTS.betStale);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }

  /** Asks the owner, in the private chat, how a bet ended; false when there is no owner, or the message failed */
  private async askOwnerAboutBet(bet: DueBet, reason: string): Promise<boolean> {
    const owner = this.configService.get('TG_OWNER_ID');
    if (!owner) return false;
    const link = supergroupMessageLink(bet.chatId, bet.tgMessageId);
    try {
      await this.bot.api.sendMessage(owner, betOwnerText(bet.question, link, reason), {
        reply_markup: betOwnerKeyboard(bet.id, bet.options),
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (e) {
      console.warn(`[Crow] Could not ask the owner about bet ${bet.id}:`, e);
      return false;
    }
  }

  /** A cat's vote on a bet of the crow's; the week's vote is anonymous and brings none */
  private async onPollAnswer(answer: PollAnswer) {
    const user = answer.user;
    if (!user || user.is_bot) return;
    const vote = {
      userId: String(user.id),
      name: catName(user.first_name, user.username, user.id),
      username: user.username ?? null,
      optionIds: answer.option_ids,
    };
    try {
      await this.store.saveVote(answer.poll_id, vote, new Date());
    } catch (e) {
      console.error(`[Crow] Could not keep a vote on poll ${answer.poll_id}:`, e);
    }
  }

  /** Redraws the menu the button was pressed on: the ephemeral one, or the fallback in the chat */
  private async refreshMenu(ctx: CallbackQueryContext<BotContext>, settings: MenuSettings, isAdmin: boolean) {
    const message = ctx.callbackQuery.message;
    const chat = ctx.chat;
    if (!message || !chat) return;
    const { text, reply_markup } = this.menu(settings, isAdmin);
    try {
      if ('ephemeral_message_id' in message && message.ephemeral_message_id) {
        await ctx.api.editEphemeralMessageText(chat.id, ctx.from.id, message.ephemeral_message_id, text, {
          reply_markup,
        });
      } else {
        await ctx.editMessageText(text, { reply_markup });
      }
    } catch (e) {
      // An ephemeral message may be gone already; the setting itself was saved
      console.warn('[Crow] Failed to redraw the menu:', e);
    }
  }

  /**
   * «Кш!» under the latest post: the cats who press it within the hour — the
   * button may have moved on to a newer post by then — send the crow away for an
   * hour once they are as many as her boldness wants, two or, when she is
   * pestering, three, and she says so under the post (`shooOutcome`).
   */
  private async onShoo(ctx: CallbackQueryContext<BotContext>, chatId: string, postId: number) {
    const now = new Date();
    const result = await this.store.shoo(chatId, postId, String(ctx.from.id), now);
    if (!result) {
      await ctx.answerCallbackQuery(TOASTS.stale);
      return;
    }
    const { boldness, snoozedUntil } = await this.store.chat(chatId);
    const needed = BOLDNESS[boldness].shooCats;
    const silent = snoozedUntil !== null && snoozedUntil > now;
    const { toast, goAway } = shooOutcome({ added: result.added, count: result.count, needed, silent });
    await ctx.answerCallbackQuery(toast);
    if (!goAway) return;
    await this.store.updateChat(chatId, { snoozedUntil: new Date(now.getTime() + SHOO_SNOOZE_MS) });
    console.log(`[Crow] Chat ${getLinkChatId(Number(chatId))}: shooed away for an hour under post ${postId}`);
    await ctx.reply(SHOO_REPLY[needed], {
      ...(result.tgMessageId === null
        ? {}
        : { reply_parameters: { message_id: result.tgMessageId, allow_sending_without_reply: true } }),
    });
  }

  /** Lets the post, the job and the answer in progress finish */
  async dispose(): Promise<void> {
    await this.talks.close();
    await this.scheduler?.stop();
  }
}
