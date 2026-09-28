import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { Importance } from '../crow/categories';
import type { GameListing } from '../crow/sources/feed';

export interface CrowQuiz {
  question: string;
  options: string[];
  correctIndex: number;
  /** Shown after an answer; up to 200 characters */
  explanation: string;
}

/** One fact of a story, taken from its sources; the arc may only use these */
export interface CrowFact {
  /** `F1`, `F2`…, cited by the arc messages */
  id: string;
  text: string;
}

export interface CrowStorySource {
  url: string;
  publisher: string;
  /** Published by the company the story is about */
  official: boolean;
}

/** What the crow said of the story's hero, so the next story can flip-flop on it */
export interface CrowStance {
  subject: string;
  verdict: string;
}

/**
 * When the story's games come or go, and when the chats hear the reminder (docs/crow/behavior.md#game-news):
 * the free games of a week end, the games of PS Plus come or leave the catalog
 */
export interface CrowDeadline {
  kind: 'available' | 'ends';
  /** ISO */
  at: string;
  remindAt: string;
  /** The crow's reminder, with `{when:at}` for the moment; written once for every chat */
  text?: string | null;
}

/** A bet the crow offers the chats on the story's dated event (docs/crow/behavior.md#bets) */
export interface CrowBet {
  question: string;
  options: string[];
  /** The option the crow herself bets on */
  crowPick: number;
  /** The day the event is due, `YYYY-MM-DD` */
  resolvesOn: string;
  /** The fact the day comes from */
  factId: string;
}

/**
 * - `pending` — gathering sources until one is official, or enough of the others agree
 * - `ready` — the arc is written and planned into the chats
 * - `failed` — the arc could not be written
 * - `dropped` — no source confirmed it in time
 */
export type CrowStoryStatus = 'pending' | 'ready' | 'failed' | 'dropped';

/**
 * A piece of news, gathered from its sources. Its arc is written once and shared
 * by every chat; each chat gets its own schedule in `crow_post`.
 */
@Entity('crow_story')
export class CrowStory extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Identifies the story across sources, e.g. `anthropic/claude-opus-5.5` */
  @Index('crow_story_storyKey_key', { unique: true })
  @Column('text')
  storyKey!: string;

  @Column('text')
  title!: string;

  /**
   * What the sources that tell of one release share, e.g. `openai/gpt-6` for GPT-6
   * Sol and Luna: entries with the same topic within 72 hours join one story
   */
  @Index('crow_story_topicKey_idx')
  @Column({ type: 'text', nullable: true })
  topicKey!: string | null;

  /** The company the story is about; its own channels count as official */
  @Column({ type: 'text', nullable: true })
  vendor!: string | null;

  /** What the story is about as its maker names it, e.g. «Claude Opus 5.5»; goes into the roster */
  @Column({ type: 'text', nullable: true })
  hero!: string | null;

  /** How the cats may call its heroes, lowercase — «opus», «опус», «клод» — to hear a talk about it */
  @Column('text', { array: true, default: () => "'{}'" })
  aliases!: string[];

  @Column('text', { array: true })
  categories!: string[];

  /** 1 — a trifle, 2 — notable, 3 — mega */
  @Column('smallint')
  importance!: Importance;

  @Column({ type: 'boolean', default: false })
  isRumor!: boolean;

  @Column({ type: 'text', nullable: true })
  eventType!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  facts!: CrowFact[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  sources!: CrowStorySource[];

  @Column({ type: 'text', nullable: true })
  imageUrl!: string | null;

  /** The picture as uploaded with the first post, so the other chats get it without a new upload */
  @Column({ type: 'text', nullable: true })
  imageFileId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  stance!: CrowStance | null;

  /** The bet the chats that hear the story are offered; null — the story has no dated event to bet on */
  @Column({ type: 'jsonb', nullable: true })
  bet!: CrowBet | null;

  /** When its games come or go, which the chats are reminded of; null — it has no such moment */
  @Column({ type: 'jsonb', nullable: true })
  deadline!: CrowDeadline | null;

  /**
   * The games of the list the story is — PS Plus's month, the games leaving it, a giveaway: its news shows every one
   * in a table, with a gallery of their pictures; null — it is no list
   */
  @Column({ type: 'jsonb', nullable: true })
  games!: GameListing[] | null;

  /** The quiz its long arcs carry (docs/crow/behavior.md#quizzes); null — none */
  @Column({ type: 'jsonb', nullable: true })
  quiz!: (CrowQuiz & { factId: string }) | null;

  /** When the vendor confirmed the rumor the story was written as, and the crow said UPD */
  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: 'text', default: 'pending' })
  status!: CrowStoryStatus;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt!: Date | null;
}
