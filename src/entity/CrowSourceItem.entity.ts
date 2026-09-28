import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { GameListing, ItemDeadline } from '../crow/sources/feed';

/**
 * - `seen` — there before the crow looked, or too old: never news
 * - `new` — waits for sorting
 * - `irrelevant` — sorted out
 * - `attached` — part of a story
 */
export type CrowSourceItemStatus = 'seen' | 'new' | 'irrelevant' | 'attached';

/** An entry of a news source, remembered so a poll only brings what is new */
@Entity('crow_source_item')
@Index('crow_source_item_sourceId_key_key', ['sourceId', 'key'], { unique: true })
@Index('crow_source_item_status_idx', ['status'])
// A story's entries: the table is never pruned
@Index('crow_source_item_storyId_idx', ['storyId'])
export class CrowSourceItem extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('text')
  sourceId!: string;

  /** The entry's guid, or its URL */
  @Column('text')
  key!: string;

  @Column('text')
  title!: string;

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  /** Plain text of the entry as the source gives it */
  @Column({ type: 'text', default: '' })
  summary!: string;

  /** Of the summary: a source that rewrites one entry during the day brings it back when it changes */
  @Column({ type: 'text', nullable: true })
  contentHash!: string | null;

  @Column({ type: 'text', nullable: true })
  imageUrl!: string | null;

  /** When the entry's games come or go, as a store's own list states it; null — it says nothing of the kind */
  @Column({ type: 'jsonb', nullable: true })
  deadline!: ItemDeadline | null;

  /** The games of the list the entry is, each with its picture; null — it is no list */
  @Column({ type: 'jsonb', nullable: true })
  games!: GameListing[] | null;

  /** As the source states it; the order of news is by `firstSeenAt`, dates of sources lie */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  firstSeenAt!: Date;

  @Column({ type: 'text', default: 'new' })
  status!: CrowSourceItemStatus;

  @Column({ type: 'int', nullable: true })
  storyId!: number | null;

  /**
   * EmbeddingGemma's vector of the headline and the sorted title of a game news' entry: it finds the story another
   * publisher already brought
   */
  @Column({ type: 'halfvec', length: 768, nullable: true, select: false })
  embedding!: number[] | null;
}
