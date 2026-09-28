import type { InputRichMessage } from 'grammy/types';
import type { CrowLink, CrowPost, CrowPostKind } from '../entity/CrowPost.entity';
import type { CrowStory } from '../entity/CrowStory.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';
import type { GameListing } from './sources/feed';
import { BackgroundQueue } from '../bot/backgroundQueue';
import { getLinkChatId } from '../bot/telegramLinks';
import { betPoll, betTimes, MIN_BETTING_MS } from './bets';
import { nextPostGap, type Random } from './cadence';
import { crowRichMessage, newsLinks, type PostContent } from './crowMessage';
import { withReleaseLine } from './countdowns';
import { streamContent } from './events';
import { dropStoryImage, storyPhoto } from './images';
import { decide, isLoud, isNews, nextPostTime, POST_KINDS } from './dispatch';
import { jobAction, type CrowJobDefinition } from './jobs';
import type { CrowStore, DueChat } from './store';

const LOG_PREFIX = '[Crow]';
/** How often the queue is looked at; the next look waits for the previous one to finish */
const TICK_MS = 30_000;
/** A collage of more pictures than this gets too small to see */
const MAX_PHOTOS = 4;
/** How the log names a post of each kind */
/**
 * The games of a list as a table: a game a row, its name a link to its page in the store, with its platforms when
 * the list names them, and a giveaway's price — the one before struck out, the one now in bold; a game that is
 * free anyway has none
 */
export function gamesTable(games: readonly GameListing[]): { table: CrowTable; anchors: Record<string, CrowLink> } {
  const platforms = games.some((game) => game.platforms);
  const prices = games.some((game) => game.price);
  const anchors: Record<string, CrowLink> = {};
  const rows = games.map((game, i) => {
    const name = game.url ? `{link:g${i + 1}}` : game.title;
    if (game.url) anchors[`g${i + 1}`] = { label: game.title, url: game.url };
    return [
      name,
      ...(platforms ? [game.platforms] : []),
      ...(prices ? [game.price ? `~~${game.price.was}~~ **${game.price.now}**` : ''] : []),
    ];
  });
  return { table: { header: ['Гра', ...(platforms ? ['Платформи'] : []), ...(prices ? ['Ціна'] : [])], rows }, anchors };
}

/** What a post of its own text shows besides the text: what its placeholders stand for, its heading and table */
export function ownContent(post: Pick<CrowPost, 'text' | 'extras' | 'mention'>): PostContent {
  const extras = post.extras ?? {};
  return {
    text: post.text ?? '',
    heading: extras.heading,
    table: extras.table ?? null,
    moments: extras.moments,
    anchors: extras.anchors,
    mentions: extras.mentions,
    mention: post.mention,
  };
}

export interface OutgoingPost {
  chatId: number;
  postId: number;
  kind: CrowPostKind;
  message: InputRichMessage;
  /** The arc's first post, which the others reply to */
  replyToMessageId: number | null;
  /** Whether the post rings; filler goes silently */
  loud: boolean;
}

/** What Telegram gave back for a sent post */
export interface SentPost {
  messageId: number;
  /** The post's pictures as Telegram keeps them, in order, to send by id from then on */
  photoFileIds: string[];
}

/** A poll of the crow's: the week's vote, or a bet */
export interface OutgoingPoll {
  question: string;
  options: string[];
  /** The week's vote is anonymous; a bet's votes are open, so the crow knows who bet on what */
  anonymous: boolean;
  /** When Telegram closes it by itself, within its 30 days; null — the crow closes it */
  closeDate: Date | null;
  description?: string;
  /** A quiz: the right answer and the crow's word shown after one; the options go shuffled */
  quiz?: { correctIndex: number; explanation: string };
}

/** Where the posts go: the command backs it with the Bot API */
export interface CrowSender {
  send(post: OutgoingPost): Promise<SentPost>;
  /** Sends a poll, as a reply when `replyToMessageId` is set; Telegram's ids of the message and the poll */
  sendPoll(
    chatId: number,
    poll: OutgoingPoll,
    replyToMessageId: number | null,
    loud: boolean,
  ): Promise<{ messageId: number; pollId: string }>;
  /** Takes «Кш!» off a message: the button stays under the chat's latest post only */
  dropShoo(chatId: number, messageId: number): Promise<void>;
  /** Whether a failed send means the bot can no longer write to the chat */
  isChatGone(error: unknown): boolean;
}

/**
 * Sends the crow's posts when their turn comes and runs its periodic jobs.
 *
 * Nothing lives only in memory: the posts and the jobs' turns are rows, so a
 * restart picks up what came due during the downtime.
 * The tick sends at most one post per chat and stays short; jobs — polling the
 * sources, writing arcs — run apart from it in a queue, one at a time.
 */
export class CrowScheduler {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private tickInProgress: Promise<void> = Promise.resolve();
  private readonly jobQueue = new BackgroundQueue('Crow job');
  /** Jobs waiting in the queue or running, so a slow one is not queued twice */
  private readonly queuedJobs = new Set<string>();

  constructor(
    private readonly store: CrowStore,
    private readonly sender: CrowSender,
    private readonly jobs: readonly CrowJobDefinition[],
    private readonly random: Random = Math.random,
  ) {}

  async start(): Promise<void> {
    const now = new Date();
    const recovered = await this.store.recoverSending(now);
    if (recovered > 0) {
      console.warn(`${LOG_PREFIX} ${recovered} posts were being sent when the bot stopped; they are not sent again`);
    }
    // The jobs are fixed, so their rows are made once; a tick reads only the rows of the jobs that are due
    await this.store.seedJobs(this.jobs.map((job) => job.name), now);
    console.log(`${LOG_PREFIX} Scheduler started: ${this.jobs.length} jobs`);
    this.scheduleTick(0);
  }

  private scheduleTick(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tickInProgress = this.tick().finally(() => this.scheduleTick(TICK_MS));
    }, delayMs).unref();
  }

  /** One look at the queue and the jobs; a failure is logged, and the next tick tries again */
  async tick(): Promise<void> {
    const now = new Date();
    try {
      for (const chat of await this.store.dueChats(now)) {
        if (this.stopped) return;
        await this.dispatchChat(chat, now).catch((e) =>
          console.error(`${LOG_PREFIX} Dispatch in chat ${getLinkChatId(Number(chat.chatId))} failed:`, e),
        );
      }
      await this.queueDueJobs(now);
    } catch (e) {
      console.error(`${LOG_PREFIX} Tick failed:`, e);
    }
  }

  private async dispatchChat(chat: DueChat, now: Date) {
    const { timeZone } = chat;
    const candidates = await this.store.candidates(chat.chatId, now);
    const sent = await this.store.sentCounts(chat.chatId, now, timeZone);
    const decision = decide(chat, candidates, sent, now);
    if (decision.skip.length > 0) {
      await this.store.skip(decision.skip, now);
      const calledOff = decision.skip.filter((c) => c.isFirst).length;
      console.log(
        `${LOG_PREFIX} ${decision.skip.length} posts out of date in chat ${getLinkChatId(Number(chat.chatId))} dropped` +
          (calledOff > 0 ? `, ${calledOff} arcs called off there` : ''),
      );
    }
    const candidate = decision.send;
    if (!candidate) return;
    if (candidate.kind === 'bet' && !(await this.betStillWorth(chat, candidate.storyId, now))) {
      await this.store.skip([candidate], now);
      const chatLink = getLinkChatId(Number(chat.chatId));
      console.log(`${LOG_PREFIX} Bet ${candidate.postId} dropped in chat ${chatLink}: another is going, or it is too late`);
      return;
    }
    // A reminder of a story's moment is for a chat that heard the story
    if (candidate.kind === 'due' && (candidate.storyId === null || !(await this.store.storyHeard(chat.chatId, candidate.storyId)))) {
      await this.store.skip([candidate], now);
      return;
    }
    if (!(await this.store.claim(candidate.postId))) return;

    const { post, text, table, stories, replyToMessageId, event } = await this.store.postToSend(candidate.postId);
    if (post.kind === 'bet') {
      await this.sendBet(chat, post, stories[0], replyToMessageId, isLoud(candidate, chat.boldness, post.kind));
      return;
    }
    if (post.kind === 'quiz') {
      await this.sendQuiz(post, stories[0], replyToMessageId);
      return;
    }
    // The news comes with its pictures — an opening with its story's, a morning digest with a collage of
    // its stories' — and ends with where to read it in full, as a UPD to a confirmed rumor does; the rest of
    // an arc is text
    const pictured = candidate.isFirst
      ? stories
          .flatMap((story) => {
            const photo = storyPhoto(story);
            return photo ? [{ story, photo }] : [];
          })
          .slice(0, MAX_PHOTOS)
      : [];
    // The news, the UPD and the reminder of games that come or go link where to read it or take them
    const links = isNews(candidate, post.kind) ? newsLinks(stories) : [];
    // The news of a list — PS Plus's month, a giveaway — shows every game of it, with a gallery of their pictures
    const games = candidate.isFirst && stories.length === 1 ? (stories[0].games ?? []) : [];
    const listed = games.length > 0 ? gamesTable(games) : null;
    const own = ownContent(post);
    const content: PostContent = {
      ...own,
      text,
      table: table ?? post.extras?.table ?? listed?.table ?? null,
      anchors: { ...own.anchors, ...listed?.anchors },
      photos: pictured.map((item) => item.photo),
      gallery: games.flatMap((game) => (game.image ? [{ url: game.image, caption: game.title }] : [])),
      links,
      ...(event ? streamContent(event, timeZone) : {}),
    };
    // The arcs of a game counted down to end with how long is left until its release
    const message = crowRichMessage(
      post.kind === 'arc' ? withReleaseLine(content, stories[0]?.categories ?? [], now, timeZone) : content,
    );
    const loud = isLoud(candidate, chat.boldness, post.kind);
    await this.deliver(
      post,
      () => this.sender.send({ chatId: Number(post.chatId), postId: post.id, kind: post.kind, message, replyToMessageId, loud }),
      async (delivered) => {
        for (const [i, fileId] of delivered.photoFileIds.entries()) {
          const story = pictured[i]?.story;
          if (story && !story.imageFileId) {
            await this.store.setImageFileId(story.id, fileId);
            await dropStoryImage(story.id);
          }
        }
        if (post.kind === 'weekly') await this.sendVote(post, delivered.messageId);
      },
    );
  }

  /** A bet goes only while no other bet of the chat's is going, and while there is still time to bet */
  private async betStillWorth(chat: DueChat, storyId: number | null, now: Date): Promise<boolean> {
    const bet = storyId === null ? null : await this.store.storyBet(storyId);
    if (!bet || (await this.store.betGoing(chat.chatId))) return false;
    const { closesAt } = betTimes(bet.resolvesOn, chat.timeZone);
    return closesAt.getTime() - now.getTime() >= MIN_BETTING_MS;
  }

  /** A bet goes as a poll in its arc's thread, and is remembered with the times of its day in the chat's zone */
  private async sendBet(chat: DueChat, post: CrowPost, story: CrowStory | undefined, replyToMessageId: number | null, loud: boolean) {
    const bet = story?.bet;
    if (!story || !bet) {
      await this.store.markFailed(post.id, new Date());
      return;
    }
    const now = new Date();
    const times = betTimes(bet.resolvesOn, chat.timeZone);
    let pollId = '';
    await this.deliver(
      post,
      async () => {
        const sent = await this.sender.sendPoll(Number(post.chatId), betPoll(bet, times.closesAt, now), replyToMessageId, loud);
        pollId = sent.pollId;
        return { messageId: sent.messageId, photoFileIds: [] };
      },
      (delivered) =>
        this.store.savePoll({
          chatId: post.chatId,
          kind: 'bet',
          postId: post.id,
          storyId: story.id,
          pollId,
          tgMessageId: delivered.messageId,
          question: bet.question,
          options: bet.options,
          storyIds: [],
          crowPick: bet.crowPick,
          closesAt: times.closesAt,
          resolvesAt: times.resolvesAt,
        }),
    );
  }

  /** A quiz goes as an anonymous quiz poll in its arc's thread, its options shuffled */
  private async sendQuiz(post: CrowPost, story: CrowStory | undefined, replyToMessageId: number | null) {
    const quiz = story?.quiz;
    if (!quiz) {
      await this.store.markFailed(post.id, new Date());
      return;
    }
    await this.deliver(post, async () => {
      const sent = await this.sender.sendPoll(
        Number(post.chatId),
        {
          question: quiz.question,
          options: quiz.options,
          anonymous: true,
          closeDate: null,
          quiz: { correctIndex: quiz.correctIndex, explanation: quiz.explanation },
        },
        replyToMessageId,
        false,
      );
      return { messageId: sent.messageId, photoFileIds: [] };
    });
  }

  /** The week's vote for the best news, under the weekly digest; a vote that fails leaves the digest as it is */
  private async sendVote(post: CrowPost, digestMessageId: number) {
    const vote = post.extras?.poll;
    if (!vote) return;
    const sent = await this.sender.sendPoll(
      Number(post.chatId),
      { question: vote.question, options: vote.options, anonymous: true, closeDate: null },
      digestMessageId,
      false,
    );
    await this.store.savePoll({
      chatId: post.chatId,
      kind: 'vote',
      postId: post.id,
      storyId: null,
      pollId: sent.pollId,
      tgMessageId: sent.messageId,
      question: vote.question,
      options: vote.options,
      storyIds: vote.storyIds,
      crowPick: null,
      closesAt: null,
      resolvesAt: null,
    });
  }

  /**
   * A talk — a reply, a chime-in, a «я ж казала» — created `sending`: it goes out
   * at once rather than at its turn, since a cat waits for it, as a silent reply
   * to the cat's message. True once Telegram took it.
   */
  async sendTalk(post: CrowPost): Promise<boolean> {
    return this.deliver(post, () =>
      this.sender.send({
        chatId: Number(post.chatId),
        postId: post.id,
        kind: post.kind,
        message: crowRichMessage(ownContent(post)),
        replyToMessageId: post.replyToMessageId === null ? null : Number(post.replyToMessageId),
        loud: false,
      }),
    );
  }

  /**
   * Sends a post taken for sending and marks it sent: the chat's next post keeps
   * the gap after it, and a post with «Кш!» takes the button over. A failure marks
   * it failed, and a chat the bot cannot write to any more is left. What comes
   * after the sending — the pictures kept, the vote under a digest — failing
   * leaves the post sent.
   */
  private async deliver(
    post: Pick<CrowPost, 'id' | 'chatId' | 'kind' | 'expiresAt'>,
    send: () => Promise<SentPost>,
    afterSent?: (sent: SentPost) => Promise<void>,
  ): Promise<boolean> {
    const chatId = Number(post.chatId);
    try {
      const sent = await send();
      const sentAt = new Date();
      await this.store.markSent(post.id, sent.messageId, sentAt, nextPostTime(post, sentAt, nextPostGap(this.random)));
      await afterSent?.(sent).catch((e) =>
        console.warn(`${LOG_PREFIX} ${POST_KINDS[post.kind].name} ${post.id} is sent, but what follows it failed:`, e),
      );
      // A post without «Кш!» of its own leaves the button under the post before it, but the goodbye takes it off
      if (POST_KINDS[post.kind].shoo !== 'leaves') await this.moveShoo(chatId, post.id);
      console.log(`${LOG_PREFIX} ${POST_KINDS[post.kind].name} ${post.id} sent to chat ${getLinkChatId(chatId)}`);
      return true;
    } catch (e) {
      console.error(`${LOG_PREFIX} Post ${post.id} failed in chat ${getLinkChatId(chatId)}:`, e);
      await this.store.markFailed(post.id, new Date());
      if (this.sender.isChatGone(e)) {
        console.warn(`${LOG_PREFIX} The bot cannot write to chat ${getLinkChatId(chatId)} any more; leaving it`);
        await this.store.dropChat(post.chatId);
      }
      return false;
    }
  }

  /** «Кш!» lives under the chat's latest post that has it: the post that had it loses it; a failure only leaves it there */
  private async moveShoo(chatId: number, postId: number) {
    const previous = await this.store.previousShooMessage(String(chatId), postId);
    if (previous === null) return;
    try {
      await this.sender.dropShoo(chatId, previous);
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not take «Кш!» off message ${previous} in chat ${getLinkChatId(chatId)}:`, e);
    }
  }

  private async queueDueJobs(now: Date) {
    const idle = this.jobs.filter((job) => !this.queuedJobs.has(job.name));
    const rows = await this.store.dueJobs(idle.map((job) => job.name), now);
    for (const job of idle) {
      const row = rows.get(job.name);
      if (!row) continue;
      const action = jobAction(job, row.nextRunAt, now);
      if (action === 'wait') continue;
      if (action === 'skip') {
        console.log(`${LOG_PREFIX} Job ${job.name} missed its turn at ${row.nextRunAt.toISOString()}; skipping it`);
        await this.store.saveJob(job.name, { nextRunAt: job.nextRun(now) });
        continue;
      }
      this.queuedJobs.add(job.name);
      this.jobQueue.push(() => this.runJob(job, row.state), {
        onSkip: async () => {
          this.queuedJobs.delete(job.name);
        },
      });
    }
  }

  /** Runs a job and books its next turn, whether it failed or not */
  private async runJob(job: CrowJobDefinition, state: Record<string, unknown>) {
    const startedAt = new Date();
    try {
      const newState = await job.run(state);
      await this.store.saveJob(job.name, {
        lastRunAt: startedAt,
        nextRunAt: job.nextRun(startedAt),
        lastError: null,
        ...(newState ? { state: newState } : {}),
      });
    } catch (e) {
      console.error(`${LOG_PREFIX} Job ${job.name} failed:`, e);
      await this.store.saveJob(job.name, { lastRunAt: startedAt, nextRunAt: job.nextRun(startedAt), lastError: String(e) });
    } finally {
      this.queuedJobs.delete(job.name);
    }
  }

  /** Stops ticking and waits for the tick and the job in progress; queued jobs are left for the next start */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.tickInProgress;
    await this.jobQueue.close();
  }
}
