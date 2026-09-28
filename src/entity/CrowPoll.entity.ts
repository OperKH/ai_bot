import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * - `vote` — the weekly digest's vote for the best news of the week, anonymous
 * - `bet` — a bet on a story's dated event: the cats vote openly, and each vote is kept
 */
export type CrowPollKind = 'vote' | 'bet';

/**
 * - `open` — the cats vote
 * - `closed` — voting is over; a bet waits for its day
 * - `asking` — the bet's outcome is unclear, and the owner was asked
 * - `resolved` — a bet's outcome is known (`outcome`), a vote's result was told
 * - `void` — a bet called off: the event was cancelled or moved, or nobody could tell how it ended
 */
export type CrowPollStatus = 'open' | 'closed' | 'asking' | 'resolved' | 'void';

/** A poll the crow sent to a chat: the week's vote, or a bet (docs/crow/behavior.md) */
@Entity('crow_poll')
@Index('crow_poll_pollId_key', ['pollId'], { unique: true })
@Index('crow_poll_chatId_kind_idx', ['chatId', 'kind'])
export class CrowPoll extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('bigint')
  chatId!: string;

  @Column('text')
  kind!: CrowPollKind;

  /** The post it came with: the weekly digest a vote is sent under, a bet's own post */
  @Column({ type: 'int', nullable: true })
  postId!: number | null;

  /** A bet's story */
  @Column({ type: 'int', nullable: true })
  storyId!: number | null;

  /** Telegram's id of the poll, which the cats' votes name */
  @Column('text')
  pollId!: string;

  @Column('bigint')
  tgMessageId!: string;

  @Column('text')
  question!: string;

  @Column('text', { array: true })
  options!: string[];

  /** A vote: the story of each option */
  @Column('int', { array: true, default: () => "'{}'" })
  storyIds!: number[];

  /** A bet: the option the crow bet on herself */
  @Column({ type: 'smallint', nullable: true })
  crowPick!: number | null;

  @Column({ type: 'text', default: 'open' })
  status!: CrowPollStatus;

  /** A vote: how many voted for each option, when it was stopped */
  @Column('int', { array: true, nullable: true })
  counts!: number[] | null;

  /** A bet: the option that won */
  @Column({ type: 'smallint', nullable: true })
  outcome!: number | null;

  /** A bet: when voting ends, the start of its day */
  @Column({ type: 'timestamptz', nullable: true })
  closesAt!: Date | null;

  /** A bet: when its outcome is looked for, the day after its day */
  @Column({ type: 'timestamptz', nullable: true })
  resolvesAt!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  /** When a bet's outcome became known or the bet was called off, when a vote's result was told */
  @Column({ type: 'timestamptz', nullable: true })
  settledAt!: Date | null;
}
