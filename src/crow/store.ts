import { DataSource, EntityManager, In, IsNull, LessThan, LessThanOrEqual, MoreThan, MoreThanOrEqual, Not } from 'typeorm';
import {
  ChatMessage,
  ChatState,
  CrowChat,
  CrowChatProfile,
  CrowEvent,
  CrowJob,
  CrowMemberOptout,
  CrowNickname,
  CrowPoll,
  CrowPollVote,
  CrowPost,
  CrowRoster,
  CrowSnippet,
  CrowSourceItem,
  CrowStory,
  CrowStoryMessage,
  CrowSubscription,
  type CrowBet,
  type CrowDeadline,
  type CrowEventSource,
  type CrowEventStatus,
  type CrowEventTexts,
  type CrowPollKind,
  type CrowPostStatus,
  type CrowPollStatus,
  type CrowBoldness,
  type CrowFact,
  type CrowMention,
  type CrowMessageKind,
  type CrowPostExtras,
  type CrowPostKind,
  type CrowProfile,
  type CrowSourceItemStatus,
  type CrowStance,
  type CrowStorySource,
  type CrowStoryStatus,
  type CrowTable,
} from '../entity/index';
import { closestGameStories, type MaterialScore, talkMaterialScores } from '../dataSource/vectorSearch';
import { type CategoryId, GAME_CATEGORY_IDS, type Importance, ownCategories } from './categories';
import { budgetDay } from './budget';
import { startOfDay } from './chatClock';
import { FALLBACK_TIME_ZONE } from '../bot/commands/timeZones';
import type { TalkHistory } from './conversation';
import type { MenuSettings } from './crowMenu';
import { readableText } from './crowMessage';
import type { ProfileMessage } from './profile';
import { type DispatchCandidate, LEAVES_SHOO, LIMITED_KINDS, type SentCounts, shooMessage } from './dispatch';
import { activation, type PlannedPost } from './planning';
import { contentHash, type FeedItem, type GameListing } from './sources/feed';
import type { SourceDefinition } from './sources/source';
import type { StoryQuiz } from './quiz';
import type { ToldStory } from './toldYou';
import { agoLabel, clip } from './words';

const HOUR = 3_600_000;
/** The bets a cat must have placed in the year to be its best bettor */
const MIN_YEAR_BETS = 3;
/** How long the crow remembers what it posted, and the stories and polls of it: a year and a month, since her birthday tells the year */
const POST_RETENTION_MS = 400 * 24 * HOUR;
/** The texts of the sources' entries and the streams are kept this long: nothing looks back at them further */
const SOURCE_RETENTION_MS = 180 * 24 * HOUR;
/** A story's vectors — its posts' and its details' — are kept this long: a talk hears the stories of 48 hours */
const STORY_VECTOR_RETENTION_MS = 90 * 24 * HOUR;
/** An entry's vector is kept this long: a game news is gathered within 72 hours, a forward looks back 30 days */
const ENTRY_VECTOR_RETENTION_MS = 90 * 24 * HOUR;
/** A nickname the crow gave a cat is forgotten when she has not called them so this long */
const NICKNAME_KEPT_MS = 30 * 24 * HOUR;
/** The cats who pressed «Кш!» count together this long, whichever posts they pressed it under */
const SHOO_WINDOW_MS = HOUR;
/**
 * The stories with a post in the chat (`$1`) after `$2`: a story whose first post went out since then has one, so a
 * query of first posts looks among these instead of the chat's whole history
 */
const POSTED_SINCE = `SELECT recent."storyId" FROM crow_post recent WHERE recent."chatId" = $1 AND recent."sentAt" > $2`;

/** A new story with its facts, before its arc is written */
export interface NewStory {
  storyKey: string;
  title: string;
  categories: string[];
  importance: Importance;
  isRumor?: boolean;
  eventType?: string | null;
  facts: CrowFact[];
  sources: CrowStorySource[];
  imageUrl?: string | null;
  hero?: string | null;
  aliases?: string[];
}

export interface NewArcMessage {
  kind: CrowMessageKind;
  crows: number;
  text: string;
  table?: CrowTable | null;
  optional?: boolean;
  factIds: string[];
  /** Its text's EmbeddingGemma vector, for talks; none when the model failed */
  embedding?: number[] | null;
}

/** How the sorting model placed an entry */
export interface ItemPlacement {
  /** The topic of an AI news; a game news has none, its story is found by meaning (`clustering.ts`) */
  topicKey: string | null;
  vendor: string | null;
  hero: string;
  title: string;
  categories: CategoryId[];
  importance: Importance;
  isRumor: boolean;
  /** What a game news is about: a release date, a delay, a giveaway… */
  eventType?: string | null;
  /** The entry's EmbeddingGemma vector (`entryText`); null when the model failed */
  embedding: number[] | null;
}

/** A game story of the last days, with its entries' headlines and links, for a new entry to find its own */
export interface RecentGameStory {
  storyId: number;
  title: string;
  status: CrowStoryStatus;
  hero: string | null;
  headlines: string[];
  urls: string[];
}

/** A chat whose post's turn has come, with the zone it set with /timezone (null — none, so UTC) */
export type DueChat = CrowChat & { timeZone: string };

/** A chat subscribed to a story's category, with what planning needs */
export interface SubscribedChat {
  chatId: string;
  boldness: CrowBoldness;
  subscriptions: Set<string>;
  personalJabs: boolean;
}

/** What a post needs to go out */
export interface PostToSend {
  post: CrowPost;
  text: string;
  table: CrowTable | null;
  /** What the post tells of: the story of its arc, or the stories of a morning digest, as it lists them */
  stories: CrowStory[];
  /**
   * What the post replies to: the message it names itself, such as a bet's poll, or else the chat's first
   * post of its story — or of its stream — which the others reply to; null for the first itself and for a digest
   */
  replyToMessageId: number | null;
  /** The stream of an announcement or a reminder */
  event: CrowEvent | null;
}

/** A chat with quiet hours and something to hear, for its morning digest and its evening goodbye */
export interface QuietChat {
  chatId: string;
  /** Set with /timezone; UTC when none */
  timeZone: string;
  quietFrom: number | null;
  quietTo: number | null;
}

/** The opening post of a story waiting in a chat: news the chat has not heard */
export interface WaitingNews {
  postId: number;
  storyId: number;
  importance: Importance;
  notBefore: Date;
  title: string;
  categories: string[];
  facts: CrowFact[];
  /** The opening's text and the facts it tells */
  opening: string;
  factIds: string[];
}

/** The morning digest to post, before it gets its id */
export interface NewDigest {
  text: string;
  importance: Importance;
  notBefore: Date;
  expiresAt: Date;
}

/** Something the crow said in a chat, for its memory */
export interface RememberedPost {
  text: string;
  sentAt: Date;
}

/** A chat the crow may talk in: subscribed to something, with its settings and its zone (null — none, so UTC) */
export type TalkChat = CrowChat & { timeZone: string };

/** The crow's post a cat replied to */
export interface RepliedPost {
  id: number;
  kind: CrowPostKind;
  depth: number;
  text: string;
  /** The cat's message it answered, when it was a reply or a chime-in of hers */
  replyToMessageId: number | null;
  /** Its story, or the stories of a morning digest */
  storyIds: number[];
}

/** A story the crow posted in a chat lately, with the aliases a talk about it is heard by */
export interface TalkedStory {
  storyId: number;
  aliases: string[];
}

/** What the crow may tell of a story in a chat */
export interface StoryMaterial {
  storyId: number;
  title: string;
  facts: CrowFact[];
  /** Details of her store the chat has not heard */
  details: { id: number; text: string }[];
  /** Posts of the arc still waiting in the chat */
  planned: { id: number; text: string; table: CrowTable | null }[];
}

/** A message of the chat as a talk reads it */
export interface TalkMessage {
  userId: string;
  name: string;
  text: string;
}

/** A reply, a chime-in or a «я ж казала» to send, before it gets its id */
export interface NewTalkPost {
  chatId: string;
  kind: 'reply' | 'chime' | 'told';
  text: string;
  storyId: number | null;
  depth: number;
  snippetIds: number[];
  replyToMessageId: number;
  replyToUserId: string;
  extras: CrowPostExtras | null;
}

/** A message of the chat is read up to this long */
const TALK_MESSAGE_MAX = 300;

const talkMessage = (row: Pick<ChatMessage, 'userId' | 'userName' | 'userFirstName' | 'textContent' | 'mediaDescription'>) => ({
  userId: row.userId,
  name: row.userFirstName?.trim() || row.userName || 'кіт',
  text: clip(
    [row.textContent, row.mediaDescription ? `[фото: ${row.mediaDescription}]` : ''].filter(Boolean).join(' '),
    TALK_MESSAGE_MAX,
  ),
});

/** A story the chat heard this week, for the weekly digest */
export interface WeekStory {
  storyId: number;
  title: string;
  hero: string | null;
  vendor: string | null;
  categories: string[];
  importance: Importance;
  facts: CrowFact[];
  stance: CrowStance | null;
  /** Her first post of it in the chat: its opening, or the morning digest that told it */
  sentAt: Date;
  tgMessageId: number | null;
  /** How many times the cats replied to her posts of it */
  replies: number;
}

/** The cat who guessed the most bets of the month */
export interface SmartestCat {
  userId: string;
  name: string;
  wins: number;
  bets: number;
}

/** How the chat's settled bets were guessed, the latest first: the crow's picks, and each cat's of those they placed */
export interface BetStreaks {
  crow: boolean[];
  cats: Map<string, boolean[]>;
}

/** A chat of the crow's with the day of her first post there */
export interface BirthdayChat {
  chatId: string;
  timeZone: string;
  boldness: CrowBoldness;
  firstPostAt: Date;
}

/** A story she told the chat in the year, with how much the cats replied to her posts of it */
export interface YearStory {
  storyId: number;
  title: string;
  hero: string | null;
  vendor: string | null;
  isRumor: boolean;
  confirmed: boolean;
  /** When the chat heard it */
  sentAt: Date;
  replies: number;
  /** Her first post of it in the chat */
  tgMessageId: string | null;
}

/** A cat and how many times something of the year was theirs */
export interface YearCat {
  userId: string;
  count: number;
}

/** The crow's year in a chat, as the store has it (docs/crow/behavior.md#birthday) */
export interface CrowYearData {
  stories: YearStory[];
  /** Her sent posts by kind */
  kinds: Record<string, number>;
  /** The 🐦‍⬛ in front of her posts */
  crows: number;
  /** The cat she talked to most, the one who shooed her most, and her favourite target */
  talker: YearCat | null;
  shooer: YearCat | null;
  target: (YearCat & { name: string; username: string | null }) | null;
  bets: { total: number; crowWins: number };
  /** The best bettor of three bets or more */
  bettor: SmartestCat | null;
  /** Each weekly vote's winner: the story and its votes */
  votes: { storyId: number; votes: number }[];
}

/** A poll the crow sent, to remember */
export interface NewPoll {
  chatId: string;
  kind: CrowPollKind;
  postId: number | null;
  storyId: number | null;
  pollId: string;
  tgMessageId: number;
  question: string;
  options: string[];
  storyIds: number[];
  crowPick: number | null;
  closesAt: Date | null;
  resolvesAt: Date | null;
}

/** A bet whose poll is to close, whose outcome is to be looked for, or whose owner kept quiet */
export interface DueBet {
  id: number;
  chatId: string;
  storyId: number;
  tgMessageId: number;
  question: string;
  options: string[];
  crowPick: number;
  status: CrowPollStatus;
  /** When the poll went out */
  createdAt: Date;
  closesAt: Date;
  resolvesAt: Date;
  /** The day of the event, `YYYY-MM-DD` */
  resolvesOn: string;
  /** The fact of the story that named the day */
  eventFact: string;
}

/** A stream a source told of */
export interface FoundEvent {
  key: string;
  title: string;
  categories: string[];
  url: string;
  startsAt: Date;
  videoId: string | null;
  source: CrowEventSource;
}

/** A chat that hears streams of a category, with what its reminder's time depends on */
export interface EventChat {
  chatId: string;
  timeZone: string;
  quietFrom: number | null;
  quietTo: number | null;
}

/** A chat's announcement or reminder of a stream */
export interface EventPost {
  id: number;
  chatId: string;
  kind: 'event' | 'reminder';
  status: CrowPostStatus;
  text: string;
  tgMessageId: number | null;
}

/** A cat's vote on a bet */
export interface BetVote {
  userId: string;
  name: string;
  username: string | null;
  optionIds: number[];
}

/** Where a press on «Кш!» left the chat */
export interface ShooResult {
  /** How many cats have shooed the crow off its posts in the chat within the hour */
  count: number;
  /** False when this cat had pressed within the hour already */
  added: boolean;
  tgMessageId: number | null;
}

/**
 * The crow's tables. A post that is done — sent, dropped or failed — always hands
 * the turn to the next post of its arc in the same transaction, so a chain
 * cannot stall, and a crash between the two leaves nothing half-done.
 */
export class CrowStore {
  constructor(private readonly dataSource: DataSource) {}

  private get posts() {
    return this.dataSource.getRepository(CrowPost);
  }

  private get chats() {
    return this.dataSource.getRepository(CrowChat);
  }

  // Settings

  /** The chat's settings; a chat the crow has not met gets the defaults */
  async chat(chatId: string): Promise<CrowChat> {
    await this.chats.createQueryBuilder().insert().values({ chatId }).orIgnore().execute();
    return this.chats.findOneByOrFail({ chatId });
  }

  /** The settings the menu shows `userId`: the chat's, and whether the crow may touch them */
  async menuSettings(chatId: string, userId: string): Promise<MenuSettings> {
    const chat = await this.chat(chatId);
    const subscriptions = await this.dataSource.getRepository(CrowSubscription).findBy({ chatId });
    const zones = await this.timeZones([chatId]);
    return {
      subscriptions: new Set(subscriptions.map((s) => s.categoryId)),
      timeZone: zones.get(chatId) ?? null,
      boldness: chat.boldness,
      quietFrom: chat.quietFrom,
      quietTo: chat.quietTo,
      snoozedUntil: chat.snoozedUntil,
      settingsAdminOnly: chat.settingsAdminOnly,
      personalJabs: chat.personalJabs,
      optedOut: (await this.optedOut(chatId)).has(userId),
    };
  }

  async updateChat(
    chatId: string,
    patch: Partial<Pick<CrowChat, 'boldness' | 'quietFrom' | 'quietTo' | 'snoozedUntil' | 'settingsAdminOnly'>>,
  ): Promise<void> {
    await this.chats.update({ chatId }, { ...patch, updatedAt: new Date() });
  }

  /** Switches a category on or off; switching it off cancels the stories and streams only it held in the chat */
  async setSubscription(chatId: string, categoryId: CategoryId, on: boolean): Promise<void> {
    const subscriptions = this.dataSource.getRepository(CrowSubscription);
    if (on) {
      await subscriptions.createQueryBuilder().insert().values({ chatId, categoryId }).orIgnore().execute();
      return;
    }
    await subscriptions.delete({ chatId, categoryId });
    await this.dataSource.query(
      `UPDATE crow_post post SET status = 'cancelled'
       FROM crow_story story
       WHERE post."storyId" = story.id AND post."chatId" = $1 AND post.status = 'planned'
         AND NOT EXISTS (
           SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = $1 AND sub."categoryId" = ANY(story.categories)
         )`,
      [chatId],
    );
    await this.dataSource.query(
      `UPDATE crow_post post SET status = 'cancelled'
       FROM crow_event event
       WHERE post."eventId" = event.id AND post."chatId" = $1 AND post.status = 'planned'
         AND NOT EXISTS (
           SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = $1 AND sub."categoryId" = ANY(event.categories)
         )`,
      [chatId],
    );
  }

  /** The bot can no longer write to the chat: the crow leaves it */
  async dropChat(chatId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.delete(CrowSubscription, { chatId });
      await em.update(CrowPost, { chatId, status: 'planned' }, { status: 'cancelled' });
    });
  }

  // Stories and planning

  async createStory(
    story: NewStory,
    messages: NewArcMessage[],
    now: Date,
  ): Promise<{ story: CrowStory; messages: CrowStoryMessage[] }> {
    return this.dataSource.transaction(async (em) => {
      const saved = await em.save(
        em.create(CrowStory, {
          ...story,
          isRumor: story.isRumor ?? false,
          eventType: story.eventType ?? null,
          imageUrl: story.imageUrl ?? null,
          status: 'ready',
          readyAt: now,
        }),
      );
      return { story: saved, messages: await this.saveArcMessages(em, saved.id, messages) };
    });
  }

  /** Puts an arc into a chat's queue */
  async planPosts(chatId: string, storyId: number, planned: PlannedPost[]): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.createQueryBuilder().insert().into(CrowChat).values({ chatId }).orIgnore().execute();
      await em.insert(
        CrowPost,
        planned.map((post) => ({ chatId, storyId, ...post })),
      );
    });
  }

  // Dispatch

  /**
   * A crash while a post was being sent leaves it `sending`. Whether it reached
   * the chat cannot be known, and a duplicate is worse than a gap: it becomes
   * `unconfirmed`, and its arc goes on as if it had been sent.
   */
  async recoverSending(now: Date): Promise<number> {
    const stuck = await this.posts.findBy({ status: 'sending' });
    for (const post of stuck) {
      await this.dataSource.transaction(async (em) => {
        await em.update(CrowPost, post.id, { status: 'unconfirmed' });
        await this.handOn(em, post, now);
      });
    }
    return stuck.length;
  }

  /** The chats with a post whose turn has come, each with its time zone */
  async dueChats(now: Date): Promise<DueChat[]> {
    const chats = await this.chats
      .createQueryBuilder('chat')
      .where(
        `EXISTS (SELECT 1 FROM crow_post post
          WHERE post."chatId" = chat."chatId" AND post.status = 'planned' AND post."notBefore" <= :now)`,
        { now },
      )
      .getMany();
    return this.withTimeZones(chats);
  }

  /** The zones the chats set with /timezone; a chat that set none is missing */
  private async timeZones(chatIds: string[]): Promise<Map<string, string>> {
    const rows = await this.dataSource
      .getRepository(ChatState)
      .find({ select: { chatId: true, timeZone: true }, where: { chatId: In(chatIds), timeZone: Not(IsNull()) } });
    return new Map(rows.map((row) => [row.chatId, row.timeZone!]));
  }

  /** The chats, each with its zone; a chat that set none with /timezone is counted in UTC */
  private async withTimeZones<T extends { chatId: string }>(chats: T[]): Promise<(T & { timeZone: string })[]> {
    if (chats.length === 0) return [];
    const zones = await this.timeZones(chats.map((chat) => chat.chatId));
    return chats.map((chat) => Object.assign(chat, { timeZone: zones.get(chat.chatId) ?? FALLBACK_TIME_ZONE }));
  }

  async candidates(chatId: string, now: Date): Promise<DispatchCandidate[]> {
    const rows = await this.dataSource.query<
      {
        id: number;
        kind: CrowPostKind;
        storyId: number | null;
        optional: boolean;
        importance: number;
        notBefore: Date;
        expiresAt: Date | null;
        isFirst: boolean;
        storyLastSentAt: Date | null;
      }[]
    >(
      `SELECT post.id, post.kind, post."storyId", post.optional, post.importance, post."notBefore", post."expiresAt",
         -- A morning digest, which belongs to no single story, brings news like an opening; a post of a story
         -- outside its chain, such as the UPD to a rumor, brings none
         post."storyId" IS NULL OR (post.seq IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM crow_post earlier
           WHERE earlier."chatId" = post."chatId" AND earlier."storyId" = post."storyId" AND earlier.seq < post.seq
         )) AS "isFirst",
         (SELECT max(other."sentAt") FROM crow_post other
           WHERE other."chatId" = post."chatId" AND other."storyId" = post."storyId") AS "storyLastSentAt"
       FROM crow_post post
       WHERE post."chatId" = $1 AND post.status = 'planned' AND post."notBefore" <= $2`,
      [chatId, now],
    );
    return rows.map((row) => ({
      postId: row.id,
      kind: row.kind,
      storyId: row.storyId,
      isFirst: row.isFirst,
      optional: row.optional,
      importance: row.importance as Importance,
      notBefore: row.notBefore,
      expiresAt: row.expiresAt,
      storyLastSentAt: row.storyLastSentAt,
    }));
  }

  async sentCounts(chatId: string, now: Date, timeZone: string): Promise<SentCounts> {
    const hourAgo = new Date(now.getTime() - HOUR);
    const midnight = startOfDay(now, timeZone);
    const [row] = await this.dataSource.query<{ lastHour: string; today: string }[]>(
      `SELECT count(*) FILTER (WHERE "sentAt" >= $2) AS "lastHour", count(*) FILTER (WHERE "sentAt" >= $3) AS today
       FROM crow_post
       WHERE "chatId" = $1 AND kind = ANY($4::text[]) AND status = 'sent'
         AND "sentAt" >= LEAST($2::timestamptz, $3::timestamptz)`,
      [chatId, hourAgo, midnight, LIMITED_KINDS],
    );
    return { lastHour: Number(row.lastHour), today: Number(row.today) };
  }

  /**
   * Drops posts; a dropped first post takes its whole arc along — the chat never
   * got the news — and a dropped morning digest the arcs of all its news.
   */
  async skip(candidates: DispatchCandidate[], now: Date): Promise<void> {
    for (const candidate of candidates) {
      await this.dataSource.transaction(async (em) => {
        const post = await em.findOneByOrFail(CrowPost, { id: candidate.postId });
        if (post.status !== 'planned') return;
        await em.update(CrowPost, post.id, { status: 'skipped' });
        if (post.kind === 'digest') {
          for (const merged of await em.findBy(CrowPost, { mergedInto: post.id })) {
            await em.update(CrowPost, merged.id, { status: 'skipped' });
            await this.cancelArc(em, merged);
          }
        } else if (candidate.isFirst) {
          await this.cancelArc(em, post);
        } else {
          await this.activateNext(em, post, now);
        }
      });
    }
  }

  /** Takes a post for sending; false when it is no longer planned (cancelled in between) */
  async claim(postId: number): Promise<boolean> {
    const result = await this.posts.update({ id: postId, status: 'planned' }, { status: 'sending' });
    return result.affected === 1;
  }

  async postToSend(postId: number): Promise<PostToSend> {
    const post = await this.posts.findOneByOrFail({ id: postId });
    const stories = this.dataSource.getRepository(CrowStory);
    if (post.kind === 'digest') {
      // In the digest's order: the most important news first
      const merged = await this.posts.find({
        where: { mergedInto: post.id },
        order: { importance: 'DESC', notBefore: 'ASC', id: 'ASC' },
      });
      const found = await stories.findBy({ id: In(merged.map((m) => m.storyId).filter((id) => id !== null)) });
      const ordered = merged.map((m) => found.find((story) => story.id === m.storyId)).filter((s) => s !== undefined);
      return { post, text: post.text ?? '', table: null, stories: ordered, replyToMessageId: null, event: null };
    }
    // A jab or the crow's introduction has its own text; the message of an arc is the arc's
    const message =
      post.storyMessageId === null
        ? null
        : await this.dataSource.getRepository(CrowStoryMessage).findOneByOrFail({ id: post.storyMessageId });
    if (!message && post.text === null) throw new Error(`Post ${postId} has no text`);
    const story = post.storyId === null ? null : await stories.findOneBy({ id: post.storyId });
    // The news of the arc, or the morning digest that told it
    const first =
      post.storyId === null
        ? null
        : await this.posts.findOne({
            where: { chatId: post.chatId, storyId: post.storyId, status: In(['sent', 'merged']) },
            order: { seq: 'ASC' },
          });
    const event = post.eventId === null ? null : await this.dataSource.getRepository(CrowEvent).findOneBy({ id: post.eventId });
    // A stream's reminder replies to its announcement in the chat
    const announcement =
      post.kind === 'reminder' && post.eventId !== null
        ? await this.posts.findOneBy({ chatId: post.chatId, eventId: post.eventId, kind: 'event', status: 'sent' })
        : null;
    const replyTo = post.replyToMessageId ?? first?.tgMessageId ?? announcement?.tgMessageId ?? null;
    return {
      post,
      text: message?.text ?? post.text ?? '',
      table: message?.table ?? null,
      stories: story ? [story] : [],
      replyToMessageId: replyTo === null ? null : Number(replyTo),
      event,
    };
  }

  async markSent(postId: number, tgMessageId: number, sentAt: Date, nextPostAt: Date): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const post = await em.findOneByOrFail(CrowPost, { id: postId });
      await em.update(CrowPost, postId, { status: 'sent', sentAt, tgMessageId: String(tgMessageId) });
      await em.update(CrowChat, { chatId: post.chatId }, { nextPostAt, updatedAt: sentAt });
      await em.update(CrowChat, { chatId: post.chatId, firstPostAt: IsNull() }, { firstPostAt: sentAt });
      // The news a morning digest told was heard with it: the later posts of their arcs reply to the digest
      if (post.kind === 'digest') await em.update(CrowPost, { mergedInto: postId }, { sentAt, tgMessageId: String(tgMessageId) });
      await this.handOn(em, post, sentAt);
    });
  }

  async markFailed(postId: number, now: Date): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const post = await em.findOneByOrFail(CrowPost, { id: postId });
      await em.update(CrowPost, postId, { status: 'failed' });
      await this.handOn(em, post, now);
    });
  }

  /** A post is done: the next post of its arc gets its turn — of every arc whose news it told, for a digest */
  private async handOn(em: EntityManager, post: CrowPost, doneAt: Date): Promise<void> {
    if (post.kind !== 'digest') return this.activateNext(em, post, doneAt);
    for (const merged of await em.findBy(CrowPost, { mergedInto: post.id })) await this.activateNext(em, merged, doneAt);
  }

  private async activateNext(em: EntityManager, post: CrowPost, doneAt: Date): Promise<void> {
    if (post.storyId === null || post.seq === null) return;
    const next = await em.findOne(CrowPost, {
      where: { chatId: post.chatId, storyId: post.storyId, status: 'planned', notBefore: IsNull(), seq: MoreThan(post.seq) },
      order: { seq: 'ASC' },
    });
    if (next) await em.update(CrowPost, next.id, activation(next, doneAt));
  }

  private async cancelArc(em: EntityManager, post: CrowPost): Promise<void> {
    if (post.storyId === null) return;
    await em.update(CrowPost, { chatId: post.chatId, storyId: post.storyId, status: 'planned' }, { status: 'cancelled' });
  }

  // The morning digest, the evening goodbye and the crow's memory

  /** Chats with quiet hours that are subscribed to something, each with its time zone */
  async quietChats(): Promise<QuietChat[]> {
    const chats = await this.dataSource.query<Omit<QuietChat, 'timeZone'>[]>(
      `SELECT chat."chatId", chat."quietFrom", chat."quietTo" FROM crow_chat chat
       WHERE chat."quietFrom" IS NOT NULL AND chat."quietTo" IS NOT NULL
         AND EXISTS (SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = chat."chatId")`,
    );
    return this.withTimeZones(chats);
  }

  /** The openings of stories that are due by `until` in the chat and not out of date at `now` */
  async waitingNews(chatId: string, until: Date, now: Date): Promise<WaitingNews[]> {
    const rows = await this.dataSource.query<(Omit<WaitingNews, 'importance'> & { importance: number })[]>(
      `SELECT post.id AS "postId", post."storyId", post.importance, post."notBefore",
         story.title, story.categories, story.facts, message.text AS opening, message."factIds"
       FROM crow_post post
       JOIN crow_story story ON story.id = post."storyId"
       JOIN crow_story_message message ON message.id = post."storyMessageId"
       WHERE post."chatId" = $1 AND post.kind = 'arc' AND post.status = 'planned' AND post."notBefore" <= $2
         AND (post."expiresAt" IS NULL OR post."expiresAt" > $3)
         AND NOT EXISTS (
           SELECT 1 FROM crow_post earlier
           WHERE earlier."chatId" = post."chatId" AND earlier."storyId" = post."storyId" AND earlier.seq < post.seq
         )`,
      [chatId, until, now],
    );
    return rows.map((row) => ({ ...row, importance: row.importance as Importance }));
  }

  /**
   * Plans a morning digest in place of the openings it tells: they become `merged`
   * and share its fate. Null when one of them is no longer waiting — sent or
   * dropped since the digest was written — and nothing changes.
   */
  async createDigest(chatId: string, digest: NewDigest, newsPostIds: number[]): Promise<number | null> {
    return this.dataSource.transaction(async (em) => {
      // Locked, so the dispatcher cannot take one of them for sending in between
      const news = await em
        .createQueryBuilder(CrowPost, 'post')
        .setLock('pessimistic_write')
        .where('post.id IN (:...ids) AND post."chatId" = :chatId', { ids: newsPostIds, chatId })
        .getMany();
      if (news.length !== newsPostIds.length || news.some((post) => post.status !== 'planned')) return null;
      const inserted = await em.insert(CrowPost, { chatId, kind: 'digest', optional: false, ...digest });
      const id = inserted.identifiers[0].id as number;
      await em.update(CrowPost, { id: In(newsPostIds) }, { status: 'merged', mergedInto: id });
      return id;
    });
  }

  /** Whether the chat got a post of `kind` planned since `since`: a digest, a goodbye, a weekly digest, a birthday */
  async plannedSince(chatId: string, kind: CrowPostKind, since: Date): Promise<boolean> {
    return this.posts.existsBy({ chatId, kind, createdAt: MoreThan(since) });
  }

  /** The crow's goodbye, due shortly before the chat's quiet hours and dropped if it cannot go before they begin */
  async planGoodbye(chatId: string, goodbye: { text: string; notBefore: Date; expiresAt: Date }): Promise<void> {
    // The lowest importance: the news of a story due at the same time goes first
    await this.posts.insert({ chatId, kind: 'goodbye', importance: 1, optional: false, ...goodbye });
  }

  /** What the crow told the chat since `since` — her arcs, digests and jabs, not her introduction or goodbyes */
  async postsSince(chatId: string, since: Date, limit: number): Promise<RememberedPost[]> {
    return this.remembered(chatId, limit, since, ['arc', 'digest', 'jab']);
  }

  /** The crow's verdicts on the heroes of the stories she told the chat since `since` */
  async dayVerdicts(chatId: string, since: Date): Promise<string[]> {
    const rows = await this.dataSource.query<{ stance: CrowStance }[]>(
      `SELECT DISTINCT ON (story.id) story.stance FROM crow_story story
       JOIN crow_post post ON post."storyId" = story.id
       WHERE post."chatId" = $1 AND post.status IN ('sent', 'merged') AND post."sentAt" > $2 AND story.stance IS NOT NULL`,
      [chatId, since],
    );
    return rows.map((row) => `${row.stance.subject}: ${row.stance.verdict}`);
  }

  /** The stories whose arcs go on in the chat: what the crow has more to say about */
  async continuingStories(chatId: string): Promise<string[]> {
    const rows = await this.dataSource.query<{ name: string }[]>(
      `SELECT DISTINCT COALESCE(story.hero, story.title) AS name FROM crow_story story
       JOIN crow_post post ON post."storyId" = story.id
       WHERE post."chatId" = $1 AND post.status = 'planned'`,
      [chatId],
    );
    return rows.map((row) => row.name);
  }

  /** The crow's last evening goodbyes in the chat */
  async recentGoodbyes(chatId: string, limit: number): Promise<string[]> {
    const rows = await this.posts.find({
      select: { text: true },
      // The unsent posts of the chat come first in its index by `sentAt` descending: skipped at the index
      where: { chatId, kind: 'goodbye', status: 'sent', sentAt: Not(IsNull()) },
      order: { sentAt: 'DESC' },
      take: limit,
    });
    return rows.map((row) => row.text ?? '').filter(Boolean);
  }

  /** What the crow said in the chat lately, newest first, a jab with the name of its cat */
  async recentPosts(chatId: string, limit: number): Promise<RememberedPost[]> {
    return this.remembered(chatId, limit, new Date(0), null);
  }

  private async remembered(
    chatId: string,
    limit: number,
    since: Date,
    kinds: CrowPostKind[] | null,
  ): Promise<RememberedPost[]> {
    const rows = await this.dataSource.query<
      (RememberedPost & { mention: CrowMention | null; extras: CrowPostExtras | null })[]
    >(
      `SELECT COALESCE(post.text, message.text) AS text, post."sentAt", post.mention, post.extras
       FROM crow_post post LEFT JOIN crow_story_message message ON message.id = post."storyMessageId"
       WHERE post."chatId" = $1 AND post.status = 'sent' AND post."sentAt" > $3
         AND ($4::text[] IS NULL OR post.kind = ANY($4::text[]))
       ORDER BY post."sentAt" DESC LIMIT $2`,
      [chatId, limit, since, kinds],
    );
    return rows.map((row) => ({ text: readableText(row.text, { ...row.extras, mention: row.mention }), sentAt: row.sentAt }));
  }

  // The chat's profile and the jabs

  async profile(chatId: string): Promise<CrowProfile | null> {
    return (await this.dataSource.getRepository(CrowChatProfile).findOneBy({ chatId }))?.profile ?? null;
  }

  /** The cats of the chat who pressed «🙅 Не чіпай мене» */
  async optedOut(chatId: string): Promise<Set<string>> {
    const rows = await this.dataSource.getRepository(CrowMemberOptout).findBy({ chatId });
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * The chats whose profile is due: subscribed to something, jabs on, and no
   * profile built since `before`; `introduced` — the crow has told them she reads them
   */
  async profileDueChats(before: Date): Promise<{ chatId: string; introduced: boolean }[]> {
    return this.dataSource.query(
      `SELECT chat."chatId", chat."introducedAt" IS NOT NULL AS introduced FROM crow_chat chat
       LEFT JOIN crow_chat_profile profile ON profile."chatId" = chat."chatId"
       WHERE chat."personalJabs" AND (profile."builtAt" IS NULL OR profile."builtAt" < $1)
         AND EXISTS (SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = chat."chatId")`,
      [before],
    );
  }

  /** The chat's messages since `since`, oldest first, as the profile reads them */
  async profileMessages(chatId: string, since: Date): Promise<ProfileMessage[]> {
    const rows = await this.dataSource.getRepository(ChatMessage).find({
      select: {
        userId: true,
        userName: true,
        userFirstName: true,
        textContent: true,
        mediaDescription: true,
        createdAt: true,
      },
      where: { chatId, createdAt: MoreThan(since) },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      firstName: row.userFirstName,
      username: row.userName,
      text: [row.textContent, row.mediaDescription ? `[фото: ${row.mediaDescription}]` : ''].filter(Boolean).join(' '),
      at: row.createdAt,
    }));
  }

  async saveProfile(chatId: string, profile: CrowProfile, messageCount: number, builtAt: Date): Promise<void> {
    await this.dataSource.getRepository(CrowChatProfile).upsert({ chatId, profile, messageCount, builtAt }, ['chatId']);
  }

  /** The crow's introduction goes out at the chat's next turn, and is not planned again */
  async planIntro(chatId: string, text: string, now: Date): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const introduced = await em.update(CrowChat, { chatId, introducedAt: IsNull() }, { introducedAt: now });
      if (introduced.affected !== 1) return;
      await em.insert(CrowPost, { chatId, kind: 'intro', text, importance: 3, notBefore: now });
    });
  }

  /** How the crow calls a cat of the chat; the cleanup forgets one she has not used for a month */
  async nickname(chatId: string, userId: string): Promise<string | null> {
    return (await this.dataSource.getRepository(CrowNickname).findOneBy({ chatId, userId }))?.nickname ?? null;
  }

  /** How the crow calls the cats of the chat, by their ids */
  async nicknames(chatId: string): Promise<Map<string, string>> {
    const rows = await this.dataSource.getRepository(CrowNickname).findBy({ chatId });
    return new Map(rows.map((row) => [row.userId, row.nickname]));
  }

  /**
   * She called the cat so now: a new nickname takes the old one's place. A cat who pressed «🙅 Не чіпай мене»
   * gets none, even one she called so while the button was pressed
   */
  async setNickname(chatId: string, userId: string, nickname: string, now: Date): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO crow_nickname ("chatId", "userId", nickname, "usedAt")
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM crow_member_optout optout WHERE optout."chatId" = $1 AND optout."userId" = $2)
       ON CONFLICT ("chatId", "userId") DO UPDATE SET nickname = EXCLUDED.nickname, "usedAt" = EXCLUDED."usedAt"`,
      [chatId, userId, nickname, now],
    );
  }

  /**
   * «🙅 Не чіпай мене»: the cat leaves the profile at once, loses the nickname, and the jabs planned at
   * them are called off. Pressed again, the crow may touch them from the next profile on.
   */
  async setOptedOut(chatId: string, userId: string, optedOut: boolean, now: Date): Promise<void> {
    const optouts = this.dataSource.getRepository(CrowMemberOptout);
    if (!optedOut) {
      await optouts.delete({ chatId, userId });
      return;
    }
    await this.dataSource.transaction(async (em) => {
      await em.createQueryBuilder().insert().into(CrowMemberOptout).values({ chatId, userId }).orIgnore().execute();
      await em.delete(CrowNickname, { chatId, userId });
      await em.query(
        `UPDATE crow_chat_profile SET profile = jsonb_set(profile, '{members}', COALESCE(
           (SELECT jsonb_agg(member) FROM jsonb_array_elements(profile->'members') member WHERE member->>'userId' <> $2),
           '[]'::jsonb))
         WHERE "chatId" = $1`,
        [chatId, userId],
      );
      await this.cancelJabs(em, chatId, userId, now);
    });
  }

  /** «🎯 Підколки» for the whole chat; off, the profile goes too, and the planned jabs */
  async setPersonalJabs(chatId: string, personalJabs: boolean, now: Date): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.update(CrowChat, { chatId }, { personalJabs, updatedAt: now });
      if (personalJabs) return;
      await em.delete(CrowChatProfile, { chatId });
      await this.cancelJabs(em, chatId, null, now);
    });
  }

  /** Calls off the planned jabs of a chat, at one cat or at all; a chain waiting on one of them goes on */
  private async cancelJabs(em: EntityManager, chatId: string, userId: string | null, now: Date): Promise<void> {
    const jabs = await em.findBy(CrowPost, { chatId, kind: 'jab', status: 'planned' });
    for (const jab of jabs.filter((j) => userId === null || j.mention?.userId === userId)) {
      await em.update(CrowPost, jab.id, { status: 'cancelled' });
      if (jab.notBefore !== null) await this.activateNext(em, jab, now);
    }
  }

  // Talks

  /** The chat, if the crow talks there: it is subscribed to something */
  async talkChat(chatId: string): Promise<TalkChat | null> {
    const chat = await this.chats.findOneBy({ chatId });
    if (!chat || !(await this.dataSource.getRepository(CrowSubscription).existsBy({ chatId }))) return null;
    const [zoned] = await this.withTimeZones([chat]);
    return zoned;
  }

  /** The crow's post behind a message of the chat, if the message is hers */
  async repliedPost(chatId: string, tgMessageId: number): Promise<RepliedPost | null> {
    // The news a morning digest told carry its message id too: the digest itself is the post
    const post = await this.posts.findOneBy({ chatId, tgMessageId: String(tgMessageId), status: Not('merged') });
    if (!post) return null;
    const message =
      post.storyMessageId === null
        ? null
        : await this.dataSource.getRepository(CrowStoryMessage).findOneBy({ id: post.storyMessageId });
    const storyIds =
      post.kind === 'digest'
        ? (await this.posts.find({ where: { mergedInto: post.id }, order: { importance: 'DESC', id: 'ASC' } }))
            .map((merged) => merged.storyId)
            .filter((id) => id !== null)
        : post.storyId === null
          ? []
          : [post.storyId];
    return {
      id: post.id,
      kind: post.kind,
      depth: post.depth,
      text: readableText(post.text ?? message?.text ?? '', { ...post.extras, mention: post.mention }),
      replyToMessageId: post.replyToMessageId === null ? null : Number(post.replyToMessageId),
      storyIds,
    };
  }

  /** A cat replied to the post */
  async countReply(postId: number): Promise<void> {
    await this.posts.increment({ id: postId }, 'replyCount', 1);
  }

  /** The stories the crow posted in the chat since `since`, the latest first, with their aliases */
  async talkedStories(chatId: string, since: Date): Promise<TalkedStory[]> {
    return this.dataSource.query<TalkedStory[]>(
      `SELECT story.id AS "storyId", story.aliases FROM crow_post post
       JOIN crow_story story ON story.id = post."storyId"
       WHERE post."chatId" = $1 AND post.status IN ('sent', 'merged') AND post."sentAt" > $2
       GROUP BY story.id, story.aliases
       ORDER BY max(post."sentAt") DESC`,
      [chatId, since],
    );
  }

  /**
   * The stories the crow told the chat since `since`, the latest first, each with her first post of it — its
   * opening, or the morning digest that told it — and whether she said «я ж казала» of it there already
   */
  async toldStories(chatId: string, since: Date): Promise<ToldStory[]> {
    const rows = await this.dataSource.query<(Omit<ToldStory, 'tgMessageId'> & { tgMessageId: string | null })[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON (story.id) story.id AS "storyId", story.title, story.facts, story.aliases, story.sources,
           post."sentAt", post."tgMessageId", COALESCE(post.text, message.text) AS text,
           EXISTS (
             SELECT 1 FROM crow_post told WHERE told."chatId" = post."chatId" AND told."storyId" = story.id AND told.kind = 'told'
           ) AS "toldYou"
         FROM crow_post post
         JOIN crow_story story ON story.id = post."storyId"
         LEFT JOIN crow_story_message message ON message.id = post."storyMessageId"
         WHERE post."chatId" = $1 AND post.kind = 'arc' AND post.status IN ('sent', 'merged') AND post."sentAt" IS NOT NULL
           AND post."storyId" IN (${POSTED_SINCE})
         ORDER BY story.id, post.seq
       ) first WHERE first."sentAt" > $2
       ORDER BY first."sentAt" DESC`,
      [chatId, since],
    );
    return rows.map((row) => ({ ...row, tgMessageId: row.tgMessageId === null ? null : Number(row.tgMessageId) }));
  }

  /** What the crow may still tell of the stories in the chat, in the order asked */
  async storyMaterial(chatId: string, storyIds: number[]): Promise<StoryMaterial[]> {
    if (storyIds.length === 0) return [];
    const stories = await this.dataSource.getRepository(CrowStory).findBy({ id: In(storyIds) });
    const details = await this.dataSource.query<{ id: number; storyId: number; text: string }[]>(
      `SELECT snippet.id, snippet."storyId", snippet.text FROM crow_snippet snippet
       WHERE snippet."storyId" = ANY($2::int[])
         AND snippet.id NOT IN (SELECT unnest(told."snippetIds") FROM crow_post told WHERE told."chatId" = $1 AND cardinality(told."snippetIds") > 0)
       ORDER BY snippet.id`,
      [chatId, storyIds],
    );
    const planned = await this.dataSource.query<{ id: number; storyId: number; text: string; table: CrowTable | null }[]>(
      `SELECT post.id, post."storyId", message.text, message.table FROM crow_post post
       JOIN crow_story_message message ON message.id = post."storyMessageId"
       WHERE post."chatId" = $1 AND post."storyId" = ANY($2::int[]) AND post.kind = 'arc' AND post.status = 'planned'
       ORDER BY post.seq`,
      [chatId, storyIds],
    );
    return storyIds.flatMap((storyId) => {
      const story = stories.find((s) => s.id === storyId);
      if (!story) return [];
      return [
        {
          storyId,
          title: story.title,
          facts: story.facts,
          details: details.filter((d) => d.storyId === storyId).map(({ id, text }) => ({ id, text })),
          planned: planned.filter((p) => p.storyId === storyId).map(({ id, text, table }) => ({ id, text, table })),
        },
      ];
    });
  }

  /** The crow's replies in the chat within the last hour, and the words she said uncalled: chime-ins and «я ж казала» */
  async talkHistory(chatId: string, now: Date): Promise<TalkHistory> {
    const rows = await this.posts.find({
      select: { kind: true, replyToUserId: true, sentAt: true, depth: true },
      where: { chatId, kind: In(['reply', 'chime', 'told']), status: 'sent', sentAt: MoreThan(new Date(now.getTime() - HOUR)) },
    });
    return {
      replies: rows
        .filter((row) => row.kind === 'reply')
        .map((row) => ({ userId: row.replyToUserId, sentAt: row.sentAt!, depth: row.depth })),
      chimes: rows.filter((row) => row.kind !== 'reply').map((row) => row.sentAt!),
    };
  }

  /** The chat's messages before `messageId`, oldest first */
  async chatMessagesBefore(chatId: string, messageId: number, limit: number): Promise<TalkMessage[]> {
    const rows = await this.dataSource.getRepository(ChatMessage).find({
      select: { userId: true, userName: true, userFirstName: true, textContent: true, mediaDescription: true },
      where: { chatId, messageId: LessThan(String(messageId)) },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.reverse().map(talkMessage);
  }

  async chatMessage(chatId: string, messageId: number): Promise<TalkMessage | null> {
    const row = await this.dataSource.getRepository(ChatMessage).findOneBy({ chatId, messageId: String(messageId) });
    return row ? talkMessage(row) : null;
  }

  /**
   * A reply, a chime-in or a «я ж казала», taken for sending at once, and the posts
   * of an arc it tells ahead of their turn: they are not sent, and their arcs go on
   * without them. A post the dispatcher took in between is sent as well — a repeat, not a gap.
   */
  async createTalkPost(talk: NewTalkPost, consumedPostIds: number[], now: Date): Promise<CrowPost> {
    return this.dataSource.transaction(async (em) => {
      const consumed = consumedPostIds.length === 0 ? [] : await em.findBy(CrowPost, { id: In(consumedPostIds), chatId: talk.chatId, status: 'planned' });
      for (const post of consumed) {
        await em.update(CrowPost, post.id, { status: 'consumed' });
        if (post.notBefore !== null) await this.activateNext(em, post, now);
      }
      const inserted = await em.insert(CrowPost, {
        ...talk,
        replyToMessageId: String(talk.replyToMessageId),
        importance: 1,
        optional: false,
        status: 'sending',
        notBefore: now,
      });
      return em.findOneByOrFail(CrowPost, { id: inserted.identifiers[0].id as number });
    });
  }

  /**
   * The crow's store for talks about a story, in place of any it had: a story written again gets a new one. The
   * details come with their embeddings, in their order, or none
   */
  async saveSnippets(storyId: number, details: string[], aliases: string[], embeddings: (number[] | null)[] = []): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.delete(CrowSnippet, { storyId });
      if (details.length > 0) {
        await em.insert(
          CrowSnippet,
          details.map((text, i) => ({ storyId, text, embedding: embeddings[i] ?? null })),
        );
      }
      await em.update(CrowStory, storyId, { aliases });
    });
  }

  /** How close a message is to what the crow may still say in the chat of the stories, the closest first */
  async materialScores(chatId: string, storyIds: number[], embedding: number[]): Promise<MaterialScore[]> {
    return talkMaterialScores(this.dataSource, chatId, storyIds, embedding);
  }


  // The weekly digest and the polls

  /** The chats the crow posts in: subscribed to something, each with its zone */
  async crowChats(): Promise<{ chatId: string; timeZone: string }[]> {
    const chats = await this.dataSource.query<{ chatId: string }[]>(`SELECT DISTINCT "chatId" FROM crow_subscription`);
    return this.withTimeZones(chats);
  }

  /**
   * The stories the chat heard between `since` and `until` — their first post went out in that time — with
   * how many times the cats replied to her posts of each
   */
  async weekStories(chatId: string, since: Date, until: Date): Promise<WeekStory[]> {
    const rows = await this.dataSource.query<
      (Omit<WeekStory, 'tgMessageId' | 'replies' | 'importance'> & {
        tgMessageId: string | null;
        replies: string;
        importance: number;
      })[]
    >(
      `SELECT first.*, (SELECT COALESCE(sum(post."replyCount"), 0) FROM crow_post post
           WHERE post."chatId" = $1 AND post."storyId" = first."storyId") AS replies
       FROM (
         SELECT DISTINCT ON (story.id) story.id AS "storyId", story.title, story.hero, story.vendor, story.categories,
           story.importance, story.facts, story.stance, post."sentAt", post."tgMessageId"
         FROM crow_post post
         JOIN crow_story story ON story.id = post."storyId"
         WHERE post."chatId" = $1 AND post.kind = 'arc' AND post.status IN ('sent', 'merged') AND post."sentAt" IS NOT NULL
           AND post."storyId" IN (${POSTED_SINCE})
         ORDER BY story.id, post.seq
       ) first
       WHERE first."sentAt" > $2 AND first."sentAt" <= $3
       ORDER BY first."sentAt"`,
      [chatId, since, until],
    );
    return rows.map((row) => ({
      ...row,
      importance: row.importance as Importance,
      tgMessageId: row.tgMessageId === null ? null : Number(row.tgMessageId),
      replies: Number(row.replies),
    }));
  }

  /** The chats the crow posts in, with her first post's day, for her birthday there */
  async birthdayChats(): Promise<BirthdayChat[]> {
    const rows = await this.dataSource.query<Omit<BirthdayChat, 'timeZone'>[]>(
      `SELECT chat."chatId", chat.boldness, chat."firstPostAt" FROM crow_chat chat
       WHERE chat."firstPostAt" IS NOT NULL AND EXISTS (SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = chat."chatId")`,
    );
    return this.withTimeZones(rows);
  }

  async planBirthday(
    chatId: string,
    birthday: { text: string; extras: CrowPostExtras; notBefore: Date; expiresAt: Date },
  ): Promise<void> {
    await this.posts.insert({ chatId, kind: 'birthday', importance: 3, optional: false, ...birthday });
  }

  /** The crow's year in the chat, `from` to `to`: what she told, how the cats answered, her bets */
  async crowYear(chatId: string, from: Date, to: Date): Promise<CrowYearData> {
    const q = <T>(sql: string) => this.dataSource.query<T>(sql, [chatId, from, to]);
    // Her posts of the year in the chat; the cats who asked her not to touch them get no award
    const sent = `post."chatId" = $1 AND post.status = 'sent' AND post."sentAt" >= $2 AND post."sentAt" < $3`;
    const touchable = (userId: string) =>
      `NOT EXISTS (SELECT 1 FROM crow_member_optout optout WHERE optout."chatId" = $1 AND optout."userId" = (${userId})::bigint)`;
    // An opening the morning digest told is `merged`: the chat heard it all the same
    const stories = await q<(Omit<YearStory, 'replies'> & { replies: string })[]>(
      `SELECT story.id AS "storyId", story.title, story.hero, story.vendor, story."isRumor", story."confirmedAt" IS NOT NULL AS confirmed,
         min(post."sentAt") FILTER (WHERE post.kind = 'arc') AS "sentAt", coalesce(sum(post."replyCount"), 0) AS replies,
         (array_agg(post."tgMessageId" ORDER BY post.seq) FILTER (WHERE post.kind = 'arc'))[1] AS "tgMessageId"
       FROM crow_post post JOIN crow_story story ON story.id = post."storyId"
       WHERE post."chatId" = $1 AND post.status IN ('sent', 'merged') AND post."sentAt" >= $2 AND post."sentAt" < $3
       GROUP BY story.id
       HAVING bool_or(post.kind = 'arc')`,
    );
    const kinds = await q<{ kind: string; count: number }[]>(
      `SELECT post.kind, count(*)::int AS count FROM crow_post post WHERE ${sent} GROUP BY post.kind`,
    );
    const [crows] = await q<{ arcs: number; own: number }[]>(
      `SELECT coalesce(sum(message.crows) FILTER (WHERE post.kind = 'arc'), 0)::int AS arcs,
         coalesce(sum(char_length(substring(post.text FROM '^(?:🐦‍⬛)+'))), 0)::int / char_length('🐦‍⬛') AS own
       FROM crow_post post LEFT JOIN crow_story_message message ON message.id = post."storyMessageId"
       WHERE ${sent}`,
    );
    const [talker] = await q<YearCat[]>(
      `SELECT post."replyToUserId" AS "userId", count(*)::int AS count FROM crow_post post
       WHERE ${sent} AND post.kind IN ('reply', 'chime', 'told') AND post."replyToUserId" IS NOT NULL AND ${touchable('post."replyToUserId"')}
       GROUP BY 1 ORDER BY count DESC, 1 LIMIT 1`,
    );
    const [shooer] = await q<YearCat[]>(
      `SELECT cat AS "userId", count(*)::int AS count FROM crow_post post, unnest(post."shooedBy") AS cat
       WHERE ${sent} AND ${touchable('cat')}
       GROUP BY cat ORDER BY count DESC, cat LIMIT 1`,
    );
    const [target] = await q<NonNullable<CrowYearData['target']>[]>(
      `SELECT post.mention->>'userId' AS "userId", (array_agg(post.mention->>'name' ORDER BY post."sentAt" DESC))[1] AS name,
         (array_agg(post.mention->>'username' ORDER BY post."sentAt" DESC))[1] AS username, count(*)::int AS count
       FROM crow_post post
       WHERE ${sent} AND post.kind = 'jab' AND post.mention IS NOT NULL AND ${touchable(`post.mention->>'userId'`)}
       GROUP BY 1 ORDER BY count DESC, 1 LIMIT 1`,
    );
    const settled = `poll."chatId" = $1 AND poll.kind = 'bet' AND poll.status = 'resolved' AND poll."settledAt" >= $2 AND poll."settledAt" < $3`;
    const [bets] = await q<CrowYearData['bets'][]>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE poll."crowPick" = poll.outcome)::int AS "crowWins"
       FROM crow_poll poll WHERE ${settled}`,
    );
    const [bettor] = await q<SmartestCat[]>(
      `SELECT * FROM (
         SELECT vote."userId", (array_agg(vote.name ORDER BY vote."votedAt" DESC))[1] AS name,
           (count(*) FILTER (WHERE poll.outcome = ANY(vote."optionIds")))::int AS wins, count(*)::int AS bets
         FROM crow_poll_vote vote JOIN crow_poll poll ON poll.id = vote."pollId"
         WHERE ${settled} AND ${touchable('vote."userId"')}
         GROUP BY vote."userId"
       ) cat
       WHERE cat.bets >= ${MIN_YEAR_BETS} AND cat.wins > 0
       ORDER BY cat.wins DESC, cat.wins::float / cat.bets DESC, cat."userId" LIMIT 1`,
    );
    const polls = await q<{ storyIds: number[]; counts: number[] }[]>(
      `SELECT poll."storyIds", poll.counts FROM crow_poll poll
       WHERE poll."chatId" = $1 AND poll.kind = 'vote' AND poll.counts IS NOT NULL AND poll."createdAt" >= $2 AND poll."createdAt" < $3`,
    );
    return {
      stories: stories.map((story) => ({ ...story, replies: Number(story.replies) })),
      kinds: Object.fromEntries(kinds.map((row) => [row.kind, row.count])),
      crows: crows.arcs + crows.own,
      talker: talker ?? null,
      shooer: shooer ?? null,
      target: target ?? null,
      bets,
      bettor: bettor ?? null,
      votes: polls.flatMap((poll) => {
        const votes = Math.max(0, ...poll.counts);
        const best = poll.counts.indexOf(votes);
        return votes > 0 && poll.storyIds[best] !== undefined ? [{ storyId: poll.storyIds[best], votes }] : [];
      }),
    };
  }

  /** The weekly digest, due at once and dropped if it cannot go out by `expiresAt` */
  async planWeekly(
    chatId: string,
    weekly: { text: string; extras: CrowPostExtras; importance: Importance; notBefore: Date; expiresAt: Date },
  ): Promise<void> {
    await this.posts.insert({ chatId, kind: 'weekly', optional: false, ...weekly });
  }

  async savePoll(poll: NewPoll): Promise<void> {
    await this.dataSource.getRepository(CrowPoll).insert({ ...poll, tgMessageId: String(poll.tgMessageId) });
  }

  /** The chat's latest weekly vote still open, to stop and tell its result */
  async openVote(chatId: string): Promise<{ id: number; tgMessageId: number; options: string[] } | null> {
    const poll = await this.dataSource
      .getRepository(CrowPoll)
      .findOne({ where: { chatId, kind: 'vote', status: 'open' }, order: { createdAt: 'DESC' } });
    return poll ? { id: poll.id, tgMessageId: Number(poll.tgMessageId), options: poll.options } : null;
  }

  /** A weekly vote is over, with its votes if Telegram gave them; older ones left open go with it */
  async closeVote(id: number, counts: number[] | null, now: Date): Promise<void> {
    const polls = this.dataSource.getRepository(CrowPoll);
    const poll = await polls.findOneByOrFail({ id });
    await polls.update({ chatId: poll.chatId, kind: 'vote', status: 'open', id: LessThan(id) }, { status: 'resolved', settledAt: now });
    await polls.update(id, { status: 'resolved', counts, settledAt: now });
  }

  /**
   * The cat of the chat who guessed the most bets settled since `since`, one at least; a tie goes to the one
   * who guessed more of theirs. The cats who opted out are left out.
   */
  async smartestCat(chatId: string, since: Date): Promise<SmartestCat | null> {
    const [row] = await this.dataSource.query<{ userId: string; name: string; wins: string; bets: string }[]>(
      `SELECT * FROM (
         SELECT vote."userId", (array_agg(vote.name ORDER BY vote."votedAt" DESC))[1] AS name,
           count(*) FILTER (WHERE poll.outcome = ANY(vote."optionIds")) AS wins, count(*) AS bets
         FROM crow_poll_vote vote
         JOIN crow_poll poll ON poll.id = vote."pollId"
         WHERE poll."chatId" = $1 AND poll.kind = 'bet' AND poll.status = 'resolved' AND poll."settledAt" > $2
           AND NOT EXISTS (SELECT 1 FROM crow_member_optout optout WHERE optout."chatId" = $1 AND optout."userId" = vote."userId")
         GROUP BY vote."userId"
       ) cat
       WHERE cat.wins > 0
       ORDER BY cat.wins DESC, cat.wins::float / cat.bets DESC, cat."userId"
       LIMIT 1`,
      [chatId, since],
    );
    return row ? { userId: row.userId, name: row.name, wins: Number(row.wins), bets: Number(row.bets) } : null;
  }

  // Bets

  async saveBet(storyId: number, bet: CrowBet): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { bet });
  }

  /**
   * Whether the chat has a bet going — a poll not settled yet, or one planned — and how many it got in the
   * last week, planned ones among them
   */
  async betLimits(chatId: string, now: Date): Promise<{ open: boolean; lastWeek: number }> {
    const [row] = await this.dataSource.query<{ open: boolean; lastWeek: string }[]>(
      `SELECT EXISTS (SELECT 1 FROM crow_poll WHERE "chatId" = $1 AND kind = 'bet' AND status IN ('open', 'closed', 'asking'))
           OR EXISTS (SELECT 1 FROM crow_post WHERE "chatId" = $1 AND kind = 'bet' AND status = 'planned') AS open,
         (SELECT count(*) FROM crow_poll WHERE "chatId" = $1 AND kind = 'bet' AND "createdAt" > $2)
           + (SELECT count(*) FROM crow_post WHERE "chatId" = $1 AND kind = 'bet' AND status = 'planned') AS "lastWeek"`,
      [chatId, new Date(now.getTime() - 7 * 24 * HOUR)],
    );
    return { open: row.open, lastWeek: Number(row.lastWeek) };
  }

  async storyBet(storyId: number): Promise<CrowBet | null> {
    return (await this.dataSource.getRepository(CrowStory).findOne({ select: { bet: true }, where: { id: storyId } }))?.bet ?? null;
  }

  /** Whether a bet of the chat's is going on: its poll is not settled yet */
  async betGoing(chatId: string): Promise<boolean> {
    return this.dataSource
      .getRepository(CrowPoll)
      .existsBy({ chatId, kind: 'bet', status: In(['open', 'closed', 'asking']) });
  }

  /** A cat's vote on an open bet, as `poll_answer` brought it; no options — the cat took it back. False when the poll is no open bet */
  async saveVote(pollId: string, vote: BetVote, now: Date): Promise<boolean> {
    const poll = await this.dataSource.getRepository(CrowPoll).findOneBy({ pollId, kind: 'bet', status: 'open' });
    if (!poll) return false;
    const votes = this.dataSource.getRepository(CrowPollVote);
    if (vote.optionIds.length === 0) await votes.delete({ pollId: poll.id, userId: vote.userId });
    else await votes.upsert({ pollId: poll.id, ...vote, votedAt: now }, ['pollId', 'userId']);
    return true;
  }

  /**
   * The bets with something to do: open ones whose day has begun, unsettled ones whose outcome is due, and
   * those the owner was asked about before `ownerDeadline`
   */
  async dueBets(now: Date, ownerDeadline: Date): Promise<DueBet[]> {
    return this.bets(
      `(poll.status = 'open' AND poll."closesAt" <= $1) OR (poll.status IN ('open', 'closed') AND poll."resolvesAt" <= $1)
       OR (poll.status = 'asking' AND poll."resolvesAt" <= $2)`,
      [now, ownerDeadline],
    );
  }

  async betById(id: number): Promise<DueBet | null> {
    return (await this.bets('poll.id = $1', [id]))[0] ?? null;
  }

  private async bets(where: string, params: unknown[]): Promise<DueBet[]> {
    const rows = await this.dataSource.query<
      (Omit<DueBet, 'tgMessageId' | 'eventFact' | 'resolvesOn'> & { tgMessageId: string; bet: CrowBet; facts: CrowFact[] })[]
    >(
      `SELECT poll.id, poll."chatId", poll."storyId", poll."tgMessageId", poll.question, poll.options, poll."crowPick", poll.status,
         poll."createdAt", poll."closesAt", poll."resolvesAt", story.bet, story.facts
       FROM crow_poll poll JOIN crow_story story ON story.id = poll."storyId"
       WHERE poll.kind = 'bet' AND story.bet IS NOT NULL AND (${where})
       ORDER BY poll.id`,
      params,
    );
    return rows.map(({ bet, facts, ...row }) => ({
      ...row,
      tgMessageId: Number(row.tgMessageId),
      resolvesOn: bet.resolvesOn,
      eventFact: facts.find((fact) => fact.id === bet.factId)?.text ?? '',
    }));
  }

  /**
   * The news a bet's outcome is looked for in: its own story as it is now — a rumor may have come true —
   * and the stories of its categories written since `since`, the latest first
   */
  async betEvidence(storyId: number, since: Date): Promise<{ title: string; facts: CrowFact[] }[]> {
    return this.dataSource.query(
      `SELECT story.title, story.facts FROM crow_story story, crow_story bet
       WHERE bet.id = $1 AND story.status = 'ready'
         AND (story.id = bet.id OR (story.categories && bet.categories AND story."readyAt" > $2))
       ORDER BY story.id = bet.id DESC, story."readyAt" DESC LIMIT 12`,
      [storyId, since],
    );
  }

  async betVotes(pollId: number): Promise<BetVote[]> {
    const rows = await this.dataSource.getRepository(CrowPollVote).find({ where: { pollId }, order: { votedAt: 'ASC' } });
    return rows.map(({ userId, name, username, optionIds }) => ({ userId, name, username, optionIds }));
  }

  /**
   * The chat's settled bets, the latest first, as they were guessed: whether the crow's pick came true, and each
   * cat's of the bets they placed
   */
  async betStreaks(chatId: string, userIds: string[]): Promise<BetStreaks> {
    const settled = `poll."chatId" = $1 AND poll.kind = 'bet' AND poll.status = 'resolved'`;
    const crow = await this.dataSource.query<{ won: boolean }[]>(
      `SELECT poll."crowPick" = poll.outcome AS won FROM crow_poll poll WHERE ${settled} ORDER BY poll."settledAt" DESC, poll.id DESC`,
      [chatId],
    );
    const rows =
      userIds.length === 0
        ? []
        : await this.dataSource.query<{ userId: string; won: boolean }[]>(
            `SELECT vote."userId", poll.outcome = ANY(vote."optionIds") AS won
             FROM crow_poll_vote vote JOIN crow_poll poll ON poll.id = vote."pollId"
             WHERE ${settled} AND vote."userId" = ANY($2::bigint[])
             ORDER BY poll."settledAt" DESC, poll.id DESC`,
            [chatId, userIds],
          );
    const cats = new Map<string, boolean[]>();
    for (const row of rows) cats.set(row.userId, [...(cats.get(row.userId) ?? []), row.won]);
    return { crow: crow.map((row) => row.won), cats };
  }

  /** A bet's poll closed, or its outcome known — an option, or null when it was called off */
  async settleBet(id: number, status: CrowPollStatus, outcome: number | null, settledAt: Date | null): Promise<void> {
    await this.dataSource.getRepository(CrowPoll).update(id, { status, outcome, ...(settledAt ? { settledAt } : {}) });
  }

  /** The owner was asked how the bet ended */
  async askedBet(id: number): Promise<void> {
    await this.dataSource.getRepository(CrowPoll).update(id, { status: 'asking' });
  }

  /** How a bet ended, as a reply to its poll at the chat's next turn */
  async planOutcome(
    chatId: string,
    outcome: { storyId: number; text: string; extras: CrowPostExtras; replyToMessageId: string; notBefore: Date; expiresAt: Date },
  ): Promise<void> {
    await this.posts.insert({ chatId, kind: 'outcome', importance: 2, optional: false, ...outcome });
  }

  // Streams

  /**
   * Keeps a stream a source told of: the same key is the same stream, and so is an upcoming one of its
   * categories starting within `sameMs` — two sources of one show. YouTube's start wins over an
   * announcement's; `previousStart` is the start before, when this changed it.
   */
  async findEvent(found: FoundEvent, sameMs: number): Promise<{ stored: CrowEvent; created: boolean; previousStart: Date | null }> {
    return this.dataSource.transaction(async (em) => {
      const existing =
        (await em.findOneBy(CrowEvent, { key: found.key })) ??
        (await em
          .createQueryBuilder(CrowEvent, 'event')
          .where(`event.status = 'upcoming' AND event.categories && :categories`, { categories: found.categories })
          .andWhere(`abs(extract(epoch FROM event."startsAt" - :startsAt::timestamptz)) <= :seconds`, {
            startsAt: found.startsAt,
            seconds: sameMs / 1000,
          })
          .orderBy('event."startsAt"')
          .getOne());
      if (!existing) {
        const stored = await em.save(
          em.create(CrowEvent, {
            key: found.key,
            title: found.title,
            categories: found.categories,
            url: found.url,
            startsAt: found.startsAt,
            sources: [found.source],
            videoId: found.videoId,
            status: 'upcoming',
          }),
        );
        return { stored, created: true, previousStart: null };
      }
      const fromYouTube = found.videoId !== null;
      const patch: Partial<CrowEvent> = {
        sources: existing.sources.some((source) => source.url === found.source.url)
          ? existing.sources
          : [...existing.sources, found.source],
        ...(fromYouTube ? { videoId: found.videoId, url: found.url, startsAt: found.startsAt } : {}),
      };
      await em.update(CrowEvent, existing.id, patch);
      const stored = { ...existing, ...patch } as CrowEvent;
      const moved = fromYouTube && existing.startsAt.getTime() !== found.startsAt.getTime();
      if (!fromYouTube && Math.abs(existing.startsAt.getTime() - found.startsAt.getTime()) > 5 * 60_000) {
        console.warn(
          `[Crow] Stream ${existing.id}: ${found.source.url} says ${found.startsAt.toISOString()}, ` +
            `the stream is at ${existing.startsAt.toISOString()}`,
        );
      }
      return { stored, created: false, previousStart: moved ? existing.startsAt : null };
    });
  }

  async upcomingEvents(): Promise<CrowEvent[]> {
    return this.dataSource.getRepository(CrowEvent).find({ where: { status: 'upcoming' }, order: { startsAt: 'ASC' } });
  }

  async setEventTexts(id: number, texts: CrowEventTexts): Promise<void> {
    await this.dataSource.getRepository(CrowEvent).update(id, { texts });
  }

  /** YouTube's schedule was checked, and gave this start */
  async checkedEvent(id: number, checkedAt: Date, startsAt: Date): Promise<void> {
    await this.dataSource.getRepository(CrowEvent).update(id, { checkedAt, startsAt });
  }

  async setEventStatus(id: number, status: CrowEventStatus): Promise<void> {
    await this.dataSource.getRepository(CrowEvent).update(id, { status });
  }

  /** The chats subscribed to any of the categories, with their zones and quiet hours */
  async eventChats(categories: string[]): Promise<EventChat[]> {
    const chats = await this.dataSource.query<Omit<EventChat, 'timeZone'>[]>(
      `SELECT chat."chatId", chat."quietFrom", chat."quietTo" FROM crow_chat chat
       WHERE EXISTS (SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = chat."chatId" AND sub."categoryId" = ANY($1::text[]))`,
      [categories],
    );
    return this.withTimeZones(chats);
  }

  /** The announcements and reminders of a stream in every chat */
  async eventPosts(eventId: number): Promise<EventPost[]> {
    const rows = await this.posts.find({
      select: { id: true, chatId: true, kind: true, status: true, text: true, tgMessageId: true },
      where: { eventId },
      order: { id: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      kind: row.kind as EventPost['kind'],
      status: row.status,
      text: row.text ?? '',
      tgMessageId: row.tgMessageId === null ? null : Number(row.tgMessageId),
    }));
  }

  async planEventPosts(
    chatId: string,
    eventId: number,
    posts: { kind: 'event' | 'reminder'; text: string; notBefore: Date; expiresAt: Date }[],
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.createQueryBuilder().insert().into(CrowChat).values({ chatId }).orIgnore().execute();
      await em.insert(
        CrowPost,
        posts.map((post) => ({ chatId, eventId, importance: 2, optional: false, ...post })),
      );
    });
  }

  /** A planned post of a stream that moved: its new time, text or end */
  async moveEventPost(
    id: number,
    patch: Partial<Pick<CrowPost, 'text' | 'notBefore' | 'expiresAt' | 'status'>>,
  ): Promise<void> {
    await this.posts.update({ id, status: 'planned' }, patch);
  }

  async cancelEventPosts(eventId: number): Promise<void> {
    await this.posts.update({ eventId, status: 'planned' }, { status: 'cancelled' });
  }

  async event(id: number): Promise<CrowEvent | null> {
    return this.dataSource.getRepository(CrowEvent).findOneBy({ id });
  }

  // «Кш!»

  /**
   * A cat presses «Кш!» under a post. The button moves on to every new post, so
   * the cats are counted over the chat's posts of the last hour rather than
   * under one post: a cat under one post and another under the next are two.
   */
  async shoo(chatId: string, postId: number, userId: string, now: Date): Promise<ShooResult | null> {
    const post = await this.posts.findOneBy({ id: postId, chatId });
    if (!post) return null;
    const tgMessageId = post.tgMessageId === null ? null : Number(post.tgMessageId);
    const rows = await this.dataSource.query<{ cat: string }[]>(
      `SELECT DISTINCT cat FROM crow_post, unnest("shooedBy") AS cat
       WHERE "chatId" = $1 AND (id = $2 OR "sentAt" > $3)`,
      [chatId, postId, new Date(now.getTime() - SHOO_WINDOW_MS)],
    );
    const cats = new Set(rows.map((row) => row.cat));
    if (cats.has(userId)) return { count: cats.size, added: false, tgMessageId };
    await this.posts.update(post.id, { shooedBy: [...post.shooedBy, userId] });
    return { count: cats.size + 1, added: true, tgMessageId };
  }

  /**
   * The message that carried «Кш!» before `postId` came: the chat's latest post but that one, of the kinds
   * that do not leave the button where it is — none since an evening goodbye, which took it off
   */
  async previousShooMessage(chatId: string, postId: number): Promise<number | null> {
    const rows = await this.dataSource.query<{ tgMessageId: string; kind: CrowPostKind }[]>(
      `SELECT "tgMessageId", kind FROM crow_post
       WHERE "chatId" = $1 AND id <> $2 AND "sentAt" IS NOT NULL AND status = 'sent' AND "tgMessageId" IS NOT NULL
         AND kind <> ALL($3::text[])
       ORDER BY "sentAt" DESC LIMIT 1`,
      [chatId, postId, LEAVES_SHOO],
    );
    return shooMessage(rows.map((row) => ({ kind: row.kind, tgMessageId: Number(row.tgMessageId) })));
  }

  /** The message that carries «Кш!» now, if any: none after an evening goodbye */
  async latestShooMessage(chatId: string): Promise<number | null> {
    return this.previousShooMessage(chatId, 0);
  }

  async setImageFileId(storyId: number, imageFileId: string): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { imageFileId });
  }

  // Sources

  /**
   * Remembers the entries of a poll and returns how many are news. On a source's
   * first poll (`baseline`) everything it lists is old and only remembered, and
   * so is an entry dated older than `staleMs`. A source that rewrites an entry
   * during the day brings it back as news when its text changes.
   */
  async addSourceItems(
    source: SourceDefinition,
    items: FeedItem[],
    baseline: boolean,
    now: Date,
    staleMs: number,
  ): Promise<number> {
    const unique = [...new Map(items.map((item) => [item.key, item])).values()];
    if (unique.length === 0) return 0;
    const repository = this.dataSource.getRepository(CrowSourceItem);
    const known = new Map(
      (
        await repository
          .createQueryBuilder('item')
          .select(['item.id', 'item.key', 'item.contentHash'])
          .where('item."sourceId" = :sourceId AND item.key IN (:...keys)', { sourceId: source.id, keys: unique.map((i) => i.key) })
          .getMany()
      ).map((item) => [item.key, item]),
    );
    const isNews = (item: FeedItem) =>
      !baseline && !(item.publishedAt && now.getTime() - item.publishedAt.getTime() > staleMs);

    const fresh = unique.filter((item) => !known.has(item.key));
    if (fresh.length > 0) {
      await repository
        .createQueryBuilder()
        .insert()
        .values(
          fresh.map((item) => ({
            sourceId: source.id,
            key: item.key,
            title: item.title,
            url: item.url,
            summary: item.summary,
            contentHash: contentHash(item.summary),
            imageUrl: item.imageUrl,
            deadline: item.deadline ?? null,
            games: item.games ?? null,
            publishedAt: item.publishedAt,
            firstSeenAt: now,
            status: (isNews(item) ? 'new' : 'seen') as CrowSourceItemStatus,
          })),
        )
        .orIgnore()
        .execute();
    }
    let news = fresh.filter(isNews).length;

    if (source.updatesInPlace) {
      for (const item of unique) {
        const stored = known.get(item.key);
        const hash = contentHash(item.summary);
        if (!stored || stored.contentHash === hash) continue;
        await repository.update(stored.id, {
          title: item.title,
          summary: item.summary,
          contentHash: hash,
          ...(isNews(item) ? { status: 'new' as const, firstSeenAt: now, sortFailures: 0 } : {}),
        });
        if (isNews(item)) news++;
      }
    }
    return news;
  }

  /** Entries waiting for sorting, oldest first, those a sorting failed with behind the fresh ones */
  async newItems(limit: number): Promise<CrowSourceItem[]> {
    return this.dataSource
      .getRepository(CrowSourceItem)
      .find({ where: { status: 'new' }, order: { sortFailures: 'ASC', firstSeenAt: 'ASC', id: 'ASC' }, take: limit });
  }

  /**
   * Counts a failed sorting of the entries still waiting: they go behind the fresh ones. Those it failed `max` times
   * are dropped (`failed`), and returned
   */
  async failSorting(ids: number[], max: number): Promise<CrowSourceItem[]> {
    const repository = this.dataSource.getRepository(CrowSourceItem);
    await repository.increment({ id: In(ids), status: 'new' }, 'sortFailures', 1);
    const dropped = await repository.find({ where: { id: In(ids), status: 'new', sortFailures: MoreThanOrEqual(max) } });
    await this.markItems(
      dropped.map((item) => item.id),
      'failed',
    );
    return dropped;
  }

  async markItems(ids: number[], status: CrowSourceItemStatus): Promise<void> {
    if (ids.length > 0) await this.dataSource.getRepository(CrowSourceItem).update({ id: In(ids) }, { status });
  }

  /**
   * Adds an entry to the story of its topic from the last `windowMs`, or starts a
   * pending story with it. The story takes the higher importance of the two, and
   * stays a rumor only while every source calls it one.
   */
  async attachToStory(
    item: CrowSourceItem,
    placement: ItemPlacement,
    source: CrowStorySource,
    now: Date,
    windowMs: number,
  ): Promise<{ story: CrowStory; created: boolean }> {
    return this.dataSource.transaction(async (em) => {
      const existing = await em.findOne(CrowStory, {
        where: { topicKey: placement.topicKey ?? '', createdAt: MoreThan(new Date(now.getTime() - windowMs)) },
        order: { createdAt: 'DESC' },
      });
      return this.join(em, item, existing, placement, source, now);
    });
  }

  /**
   * Adds an entry of a game news to the story the clustering found for it (`clustering.ts`), or starts a pending
   * story with it when there is none
   */
  async attachToGameStory(
    item: CrowSourceItem,
    storyId: number | null,
    placement: ItemPlacement,
    source: CrowStorySource,
    now: Date,
  ): Promise<{ story: CrowStory; created: boolean }> {
    return this.dataSource.transaction(async (em) => {
      const existing = storyId === null ? null : await em.findOneBy(CrowStory, { id: storyId });
      return this.join(em, item, existing, placement, source, now);
    });
  }

  /**
   * An entry joins its story, or starts one. The story takes the higher importance of the two and every category,
   * and stays a rumor only while every source calls it one
   */
  private async join(
    em: EntityManager,
    item: CrowSourceItem,
    existing: CrowStory | null,
    placement: ItemPlacement,
    source: CrowStorySource,
    now: Date,
  ): Promise<{ story: CrowStory; created: boolean }> {
    let story: CrowStory;
    if (existing) {
      story = existing;
      await em.update(CrowStory, story.id, {
        // A story dropped for want of confirmation comes back with a new source
        ...(story.status === 'dropped' ? { status: 'pending' as const } : {}),
        importance: Math.max(story.importance, placement.importance) as Importance,
        // A rumor already told stays one until the pipeline has told the chats it came true (`confirmRumor`)
        isRumor: story.status === 'ready' ? story.isRumor : story.isRumor && placement.isRumor,
        sources: story.sources.some((s) => s.url === source.url) ? story.sources : [...story.sources, source],
        categories: ownCategories([...story.categories, ...placement.categories]),
      });
    } else {
      const key = placement.topicKey ?? `games/${placement.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}`;
      story = await em.save(
        em.create(CrowStory, {
          storyKey: `${key}@${now.toISOString()}`,
          topicKey: placement.topicKey,
          vendor: placement.vendor,
          hero: placement.hero,
          title: placement.title,
          categories: placement.categories,
          importance: placement.importance,
          isRumor: placement.isRumor,
          eventType: placement.eventType ?? null,
          facts: [],
          sources: [source],
          status: 'pending',
          createdAt: now,
        }),
      );
    }
    await em.update(CrowSourceItem, item.id, { status: 'attached', storyId: story.id, embedding: placement.embedding });
    return { story, created: !existing };
  }

  /** The game stories started since `since`, but the failed ones, with their entries' headlines and links */
  async recentGameStories(since: Date): Promise<RecentGameStory[]> {
    return this.dataSource.query<RecentGameStory[]>(
      `SELECT story.id AS "storyId", story.title, story.status, story.hero, array_agg(item.title ORDER BY item.id) AS headlines,
         array_remove(array_agg(item.url ORDER BY item.id), NULL) AS urls
       FROM crow_story story JOIN crow_source_item item ON item."storyId" = story.id
       WHERE story."createdAt" > $1 AND story.categories && $2::text[] AND story.status <> 'failed'
       GROUP BY story.id`,
      [since, GAME_CATEGORY_IDS],
    );
  }

  /** How close an entry is in meaning to each game story started since `since`, by their entries, the closest first */
  async gameStoryScores(embedding: number[], since: Date): Promise<{ storyId: number; similarity: number }[]> {
    return closestGameStories(this.dataSource, embedding, since, GAME_CATEGORY_IDS);
  }

  /** The stories of the categories written since `since`, the latest first: what the news of them was */
  async recentStories(categories: string[], since: Date, limit: number): Promise<{ id: number; title: string; facts: CrowFact[] }[]> {
    return this.dataSource.query(
      `SELECT id, title, facts FROM crow_story
       WHERE status = 'ready' AND categories && $1::text[] AND "readyAt" > $2
       ORDER BY "readyAt" DESC LIMIT $3`,
      [categories, since, limit],
    );
  }

  /** The entries of the sources since `since`: the roundups of a week's releases among them */
  async roundups(sourceIds: string[], since: Date): Promise<{ sourceId: string; title: string; summary: string }[]> {
    return this.dataSource.query(
      `SELECT "sourceId", title, summary FROM crow_source_item
       WHERE "sourceId" = ANY($1::text[]) AND "firstSeenAt" > $2 ORDER BY "firstSeenAt"`,
      [sourceIds, since],
    );
  }

  /** The week's release radar in a chat */
  async planRadar(chatId: string, radar: { text: string; extras: CrowPostExtras; notBefore: Date; expiresAt: Date }): Promise<void> {
    await this.posts.insert({ chatId, kind: 'radar', importance: 2, optional: false, ...radar });
  }

  /** A post of GTA VI's countdown in a chat */
  async planCountdown(
    chatId: string,
    countdown: { text: string; extras: CrowPostExtras | null; notBefore: Date; expiresAt: Date },
  ): Promise<void> {
    await this.posts.insert({ chatId, kind: 'countdown', importance: 2, optional: false, ...countdown });
  }

  /** The quiz a story's long arcs carry */
  async saveQuiz(storyId: number, quiz: StoryQuiz): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { quiz });
  }

  /** The moment a story's games come or go, with the crow's reminder of it */
  async saveDeadline(storyId: number, deadline: CrowDeadline): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { deadline });
  }

  /** A chat's reminder of a story's moment: a post of its own, outside the arc's chain, as a reply to its news */
  async planDue(
    chatId: string,
    storyId: number,
    due: { text: string; extras: CrowPostExtras | null; importance: Importance; notBefore: Date; expiresAt: Date },
  ): Promise<void> {
    await this.posts.insert({
      chatId,
      storyId,
      kind: 'due',
      text: due.text,
      extras: due.extras,
      importance: due.importance,
      optional: false,
      notBefore: due.notBefore,
      expiresAt: due.expiresAt,
    });
  }

  /** Whether the chat heard the story: a post of it went out there — a reminder of news it never heard would be odd */
  async storyHeard(chatId: string, storyId: number): Promise<boolean> {
    return this.posts.existsBy({ chatId, storyId, status: In(['sent', 'merged']) });
  }

  /** A story's importance, as its publishers made it before it is written */
  async setStoryImportance(storyId: number, importance: Importance): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { importance });
  }

  async pendingStories(): Promise<CrowStory[]> {
    return this.dataSource.getRepository(CrowStory).find({ where: { status: 'pending' }, order: { createdAt: 'ASC' } });
  }

  async storyItems(storyId: number): Promise<CrowSourceItem[]> {
    return this.dataSource.getRepository(CrowSourceItem).find({ where: { storyId }, order: { firstSeenAt: 'ASC' } });
  }

  async setStoryStatus(storyId: number, status: CrowStoryStatus): Promise<void> {
    await this.dataSource.getRepository(CrowStory).update(storyId, { status });
  }

  /** Stores a written arc and makes the story ready */
  async completeStory(
    storyId: number,
    arc: {
      facts: CrowFact[];
      messages: NewArcMessage[];
      stance: CrowStance;
      imageUrl: string | null;
      isRumor: boolean;
      /** The games of the list the story is, if it is one */
      games?: GameListing[] | null;
    },
    now: Date,
  ): Promise<CrowStoryMessage[]> {
    return this.dataSource.transaction(async (em) => {
      await em.update(CrowStory, storyId, {
        facts: arc.facts,
        stance: arc.stance,
        imageUrl: arc.imageUrl,
        games: arc.games ?? null,
        isRumor: arc.isRumor,
        status: 'ready',
        readyAt: now,
      });
      return this.saveArcMessages(em, storyId, arc.messages);
    });
  }

  /** A story's arc, its messages numbered in order */
  private saveArcMessages(em: EntityManager, storyId: number, messages: NewArcMessage[]): Promise<CrowStoryMessage[]> {
    return em.save(
      messages.map((message, i) =>
        em.create(CrowStoryMessage, {
          storyId,
          seq: i + 1,
          kind: message.kind,
          crows: message.crows,
          text: message.text,
          table: message.table ?? null,
          optional: message.optional ?? false,
          factIds: message.factIds,
          embedding: message.embedding ?? null,
        }),
      ),
    );
  }

  /** The stories written as rumors since `since` that the chats have not heard confirmed */
  async unconfirmedRumors(since: Date): Promise<CrowStory[]> {
    return this.dataSource.getRepository(CrowStory).find({
      where: { status: 'ready', isRumor: true, confirmedAt: IsNull(), readyAt: MoreThan(since) },
      order: { readyAt: 'ASC' },
    });
  }

  /** The opening of a story's arc, as it was written */
  async storyOpening(storyId: number): Promise<string> {
    const message = await this.dataSource.getRepository(CrowStoryMessage).findOneBy({ storyId, seq: 1 });
    return message?.text ?? '';
  }

  /**
   * The vendor confirmed a rumor: the story takes the vendor's facts and is a rumor no more, and the crow's
   * UPD, if there is one, goes to every chat that heard the rumor and still hears the story, as a reply to
   * its news. Returns the number of chats.
   */
  async confirmRumor(
    storyId: number,
    facts: CrowFact[],
    update: { text: string; importance: Importance; expiresAt: Date } | null,
    now: Date,
  ): Promise<number> {
    return this.dataSource.transaction(async (em) => {
      await em.update(CrowStory, storyId, { facts, isRumor: false, confirmedAt: now });
      if (!update) return 0;
      const chats = await em.query<{ chatId: string }[]>(
        `SELECT DISTINCT post."chatId" FROM crow_post post
         JOIN crow_story story ON story.id = post."storyId"
         WHERE post."storyId" = $1 AND post.status IN ('sent', 'merged') AND post."sentAt" IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM crow_subscription sub WHERE sub."chatId" = post."chatId" AND sub."categoryId" = ANY(story.categories)
           )`,
        [storyId],
      );
      if (chats.length > 0) {
        await em.insert(
          CrowPost,
          chats.map(({ chatId }) => ({
            chatId,
            storyId,
            kind: 'update' as const,
            text: update.text,
            importance: update.importance,
            optional: false,
            notBefore: now,
            expiresAt: update.expiresAt,
          })),
        );
      }
      return chats.length;
    });
  }

  /** Chats subscribed to any of the categories, with all their subscriptions */
  async subscribedChats(categories: string[]): Promise<SubscribedChat[]> {
    const rows = await this.dataSource.query<
      { chatId: string; boldness: CrowBoldness; personalJabs: boolean; subscriptions: string[] }[]
    >(
      `SELECT chat."chatId", chat.boldness, chat."personalJabs", array_agg(sub."categoryId") AS subscriptions
       FROM crow_chat chat JOIN crow_subscription sub ON sub."chatId" = chat."chatId"
       GROUP BY chat."chatId", chat.boldness, chat."personalJabs"
       HAVING array_agg(sub."categoryId") && $1::text[]`,
      [categories],
    );
    return rows.map((row) => ({
      chatId: row.chatId,
      boldness: row.boldness,
      personalJabs: row.personalJabs,
      subscriptions: new Set(row.subscriptions),
    }));
  }

  /** Every category some chat is subscribed to */
  async subscribedCategories(): Promise<Set<string>> {
    const rows = await this.dataSource.query<{ categoryId: string }[]>(
      `SELECT DISTINCT "categoryId" FROM crow_subscription`,
    );
    return new Set(rows.map((row) => row.categoryId));
  }

  async roster(): Promise<CrowRoster[]> {
    return this.dataSource.getRepository(CrowRoster).find({ order: { provider: 'ASC' } });
  }

  async updateRoster(provider: string, flagship: string, releasedAt: string): Promise<void> {
    await this.dataSource
      .getRepository(CrowRoster)
      .upsert({ provider, flagship, releasedAt, updatedAt: new Date() }, ['provider']);
  }

  /** The openings of the latest arcs, so a new arc does not repeat them */
  async recentOpenings(limit: number): Promise<string[]> {
    const rows = await this.dataSource.query<{ text: string }[]>(
      `SELECT message.text FROM crow_story_message message
       JOIN crow_story story ON story.id = message."storyId"
       WHERE story.status = 'ready' AND message.seq = 1
       ORDER BY story."readyAt" DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => row.text);
  }

  /** What the crow said of the heroes of its latest stories in these categories, and how long ago */
  async recentStances(categories: string[], limit: number, now: Date): Promise<string[]> {
    const rows = await this.dataSource.query<{ stance: CrowStance; readyAt: Date }[]>(
      `SELECT stance, "readyAt" FROM crow_story
       WHERE status = 'ready' AND stance IS NOT NULL AND categories && $1::text[]
       ORDER BY "readyAt" DESC LIMIT $2`,
      [categories, limit],
    );
    return rows.map(
      (row) => `${row.stance.subject}: ${row.stance.verdict} (${agoLabel(now.getTime() - row.readyAt.getTime())})`,
    );
  }

  // Jobs

  /** Makes a job due at once, e.g. the pipeline after a poll brought news */
  async setJobDue(name: string, now: Date): Promise<void> {
    await this.dataSource.getRepository(CrowJob).update({ name }, { nextRunAt: now });
  }

  /** Runs a job at the next tick even if it paused itself (the pipeline waiting out an empty balance) */
  async resumeJob(name: string, now: Date): Promise<void> {
    await this.dataSource.query(`UPDATE crow_job SET "nextRunAt" = $2, state = state - 'pausedUntil' WHERE name = $1`, [
      name,
      now,
    ]);
  }

  /** Forgets what the pipeline spent today, so another day's budget is there to spend */
  async resetBudget(now: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE crow_job SET state = jsonb_set(state, '{budget}', $1::jsonb) WHERE name = 'pipeline'`,
      [JSON.stringify({ day: budgetDay(now), spentUsd: 0 })],
    );
  }

  /** Posts of arcs already written that still wait for their turn, in every chat */
  async plannedPostCount(): Promise<number> {
    return this.posts.countBy({ status: 'planned' });
  }

  /** A row for every job, in one query however many sources there are; a job that never ran is due at once */
  async seedJobs(names: string[], now: Date): Promise<void> {
    if (names.length === 0) return;
    await this.dataSource
      .getRepository(CrowJob)
      .createQueryBuilder()
      .insert()
      .values(names.map((name) => ({ name, nextRunAt: now })))
      .orIgnore()
      .execute();
  }

  /** The rows of the jobs whose turn has come by `now` */
  async dueJobs(names: string[], now: Date): Promise<Map<string, CrowJob>> {
    if (names.length === 0) return new Map();
    const due = await this.dataSource.getRepository(CrowJob).findBy({ name: In(names), nextRunAt: LessThanOrEqual(now) });
    return new Map(due.map((job) => [job.name, job]));
  }

  async saveJob(name: string, patch: Partial<Pick<CrowJob, 'nextRunAt' | 'lastRunAt' | 'lastError' | 'state'>>) {
    const jobs = this.dataSource.getRepository(CrowJob);
    // TypeORM's deep-partial type cannot tell a jsonb object from a nested entity
    await jobs.update({ name }, patch as Parameters<typeof jobs.update>[1]);
  }

  /** Forgets posts older than the retention, the stories no post refers to any more, and old polls and streams */
  async cleanup(now: Date): Promise<{ posts: number; stories: number }> {
    const cutoff = new Date(now.getTime() - POST_RETENTION_MS);
    const posts = await this.posts.delete({ createdAt: LessThan(cutoff), status: Not(In(['planned', 'sending'])) });
    const stories = await this.dataSource
      .createQueryBuilder()
      .delete()
      .from(CrowStory)
      .where(`"createdAt" < :cutoff AND NOT EXISTS (SELECT 1 FROM crow_post post WHERE post."storyId" = crow_story.id)`, {
        cutoff,
      })
      .execute();
    await this.dataSource.query(
      `DELETE FROM crow_story_message message
       WHERE NOT EXISTS (SELECT 1 FROM crow_story story WHERE story.id = message."storyId")`,
    );
    await this.dataSource.query(
      `DELETE FROM crow_snippet snippet
       WHERE NOT EXISTS (SELECT 1 FROM crow_story story WHERE story.id = snippet."storyId")`,
    );
    // The polls go with the retention too, the settled ones — a bet lasts three months at most — and their votes
    await this.dataSource.query(
      `DELETE FROM crow_poll WHERE "createdAt" < $1 AND status IN ('resolved', 'void')`,
      [cutoff],
    );
    await this.dataSource.query(
      `DELETE FROM crow_poll_vote vote WHERE NOT EXISTS (SELECT 1 FROM crow_poll poll WHERE poll.id = vote."pollId")`,
    );
    await this.dataSource.getRepository(CrowNickname).delete({ usedAt: LessThan(new Date(now.getTime() - NICKNAME_KEPT_MS)) });
    const sources = new Date(now.getTime() - SOURCE_RETENTION_MS);
    await this.dataSource.query(`DELETE FROM crow_event WHERE "startsAt" < $1`, [sources]);
    const vectors = new Date(now.getTime() - STORY_VECTOR_RETENTION_MS);
    for (const table of ['crow_story_message', 'crow_snippet']) {
      await this.dataSource.query(
        `UPDATE ${table} item SET embedding = NULL
         WHERE item.embedding IS NOT NULL AND EXISTS (SELECT 1 FROM crow_story story WHERE story.id = item."storyId" AND story."createdAt" < $1)`,
        [vectors],
      );
    }
    // The entries stay, or a source that lists all it ever had — a sitemap — would bring them back as news; what they
    // weigh goes: the vectors after 90 days, the texts after 180
    await this.dataSource.query(`UPDATE crow_source_item SET embedding = NULL WHERE embedding IS NOT NULL AND "firstSeenAt" < $1`, [
      new Date(now.getTime() - ENTRY_VECTOR_RETENTION_MS),
    ]);
    await this.dataSource.query(`UPDATE crow_source_item SET summary = '' WHERE summary <> '' AND "firstSeenAt" < $1`, [sources]);
    return { posts: posts.affected ?? 0, stories: stories.affected ?? 0 };
  }
}
