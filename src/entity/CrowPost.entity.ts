import type { RichTextDateTime } from 'grammy/types';
import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { Importance } from '../crow/categories';
import type { CrowTable } from './CrowStoryMessage.entity';

/**
 * - `arc` — a message of a story's arc
 * - `digest` — the morning digest: the news of several stories that came in the quiet hours, in one post
 * - `jab` — a personal jab at a cat of the chat, in the chain of a story's arc
 * - `intro` — the crow telling the chat that she reads it, before her first jab
 * - `goodbye` — the crow's goodbye at the end of the chat's day, before its quiet hours
 * - `reply` — her answer to a cat who replied to her post or called her
 * - `chime` — her word in a talk nobody called her into: the chat speaks of a story she has more to tell
 * - `told` — her «я ж казала» to a cat who brought news she had told the chat before
 * - `update` — her UPD to a rumor of hers that the vendor confirmed, as a reply to its news
 * - `weekly` — the weekly digest, with the chat's vote for the best news of the week under it
 * - `bet` — a bet on a story's dated event: a poll, in the chain of the story's arc
 * - `outcome` — how a bet ended, as a reply to its poll
 * - `event` — the announcement of a stream (`crow_event`)
 * - `reminder` — the stream is about to begin, as a reply to its announcement
 * - `quiz` — a quiz on a story: a poll, in the chain of the story's arc
 * - `due` — a reminder of a story's games: they came, or go soon
 * - `countdown` — a post of the countdown to a game's release
 * - `radar` — the week's releases, on Monday
 * - `birthday` — her year in the chat, on the day of her first post there
 *
 * What each kind is to the queue and the sender is in `POST_KINDS` (crow/dispatch.ts).
 */
export type CrowPostKind =
  | 'arc'
  | 'digest'
  | 'jab'
  | 'intro'
  | 'goodbye'
  | 'reply'
  | 'chime'
  | 'told'
  | 'update'
  | 'weekly'
  | 'bet'
  | 'outcome'
  | 'event'
  | 'reminder'
  | 'quiz'
  | 'due'
  | 'countdown'
  | 'radar'
  | 'birthday';

/** The cat a jab is aimed at; `ping` — mentioned so that they get a notification */
export interface CrowMention {
  userId: string;
  name: string;
  username: string | null;
  ping: boolean;
}

/**
 * A moment a text refers to as `{when:<id>}`. It goes out as a `date_time`
 * element, which every reader sees in their own time zone: the crow never writes
 * a time as digits.
 */
export interface CrowMoment {
  unixTime: number;
  format: RichTextDateTime['date_time_format'];
  /** Shown by clients that cannot format the moment, and in the crow's memory */
  fallback: string;
}

export interface CrowLink {
  label: string;
  url: string;
}

/** What a post of its own text carries besides the text, which refers to it by placeholders */
export interface CrowPostExtras {
  /** A heading above the text */
  heading?: string;
  /** The moments of its `{when:<id>}` */
  moments?: Record<string, CrowMoment>;
  /** The links of its `{link:<id>}` */
  anchors?: Record<string, CrowLink>;
  /** The cats of its `{cat:<id>}` */
  mentions?: Record<string, CrowMention>;
  table?: CrowTable;
  /** The weekly digest's vote for the best news, sent under it: an option per story */
  poll?: { question: string; options: string[]; storyIds: number[] };
}

/**
 * - `planned` — waiting; `notBefore` is set once the previous post of its arc is done
 * - `sending` — handed to Telegram; a crash leaves it here, and the next start marks it `unconfirmed`
 * - `unconfirmed` — may or may not have arrived; never sent again, a duplicate is worse than a gap
 * - `merged` — the news of a story told in the morning digest `mergedInto`; it shares the digest's fate
 * - `consumed` — told in a talk before its turn came; its arc goes on without it
 */
export type CrowPostStatus =
  | 'planned'
  | 'sending'
  | 'sent'
  | 'unconfirmed'
  | 'skipped'
  | 'cancelled'
  | 'failed'
  | 'merged'
  | 'consumed';

/**
 * One post of the crow in one chat: the chat's queue and the crow's memory of
 * what it said there. The posts of an arc form a chain: each waits for the one
 * before it and follows it by `gapMs`, so an overlap with another arc or a
 * downtime shifts the rest of the arc instead of bunching it up.
 */
@Entity('crow_post')
@Index('crow_post_status_notBefore_idx', ['status', 'notBefore'])
@Index('crow_post_chatId_sentAt_idx', ['chatId', 'sentAt'])
// A cat's reply names the message it answers: this finds the crow's post behind it
@Index('crow_post_chatId_tgMessageId_idx', ['chatId', 'tgMessageId'])
// A story's chain in a chat: the post before a post, the chat's first post of the story
@Index('crow_post_chatId_storyId_seq_idx', ['chatId', 'storyId', 'seq'])
// The announcements and reminders of a stream, which few posts are
@Index('crow_post_eventId_idx', ['eventId'], { where: '"eventId" IS NOT NULL' })
export class CrowPost extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('bigint')
  chatId!: string;

  @Column({ type: 'int', nullable: true })
  storyId!: number | null;

  @Column({ type: 'int', nullable: true })
  storyMessageId!: number | null;

  /** The post's place in the chat's chain of its story: the arc's messages, and the jabs among them */
  @Column({ type: 'smallint', nullable: true })
  seq!: number | null;

  @Column({ type: 'text', default: 'arc' })
  kind!: CrowPostKind;

  /** The post's own text, for a post that is not a message of an arc, such as the morning digest */
  @Column({ type: 'text', nullable: true })
  text!: string | null;

  /** What its own text refers to — moments, links, cats — and its own table */
  @Column({ type: 'jsonb', nullable: true })
  extras!: CrowPostExtras | null;

  /** The stream an announcement or a reminder is about */
  @Column({ type: 'int', nullable: true })
  eventId!: number | null;

  /** The morning digest that told this news; set with the status `merged` */
  @Column({ type: 'int', nullable: true })
  mergedInto!: number | null;

  /** The cat a jab names where its text says `{cat}` */
  @Column({ type: 'jsonb', nullable: true })
  mention!: CrowMention | null;

  /** The story's importance, copied for the dispatcher */
  @Column({ type: 'smallint', default: 1 })
  importance!: Importance;

  /** The message may be dropped: when its time has passed, or the chat hit its daily limit */
  @Column({ type: 'boolean', default: false })
  optional!: boolean;

  @Column({ type: 'text', default: 'planned' })
  status!: CrowPostStatus;

  /** How long after the previous post of the arc this one comes */
  @Column({ type: 'int', default: 0 })
  gapMs!: number;

  @Column({ type: 'timestamptz', nullable: true })
  notBefore!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  tgMessageId!: string | null;

  /** Users who pressed «Кш!» under the post */
  @Column('bigint', { array: true, default: () => "'{}'" })
  shooedBy!: string[];

  /**
   * The message the post replies to when it is not its arc's first post: the cat's message a talk
   * answers, the poll of a bet's outcome
   */
  @Column({ type: 'bigint', nullable: true })
  replyToMessageId!: string | null;

  /** The cat a reply answers, for the limits of a talk */
  @Column({ type: 'bigint', nullable: true })
  replyToUserId!: string | null;

  /** Where in a talk: 0 for a post of her own; her answer to a reply to a post of depth n has n + 1 */
  @Column({ type: 'smallint', default: 0 })
  depth!: number;

  /** The details of her store a reply or a chime-in told, so that the chat does not hear them twice */
  @Column('int', { array: true, default: () => "'{}'" })
  snippetIds!: number[];

  /** How many times the cats replied to the post */
  @Column({ type: 'int', default: 0 })
  replyCount!: number;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
