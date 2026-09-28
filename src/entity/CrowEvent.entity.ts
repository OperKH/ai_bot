import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * - `upcoming` — announced, not begun
 * - `cancelled` — the stream is gone, or its time was taken back
 * - `over` — it has begun
 */
export type CrowEventStatus = 'upcoming' | 'cancelled' | 'over';

/** Where the crow learned of a stream, and the start it gave */
export interface CrowEventSource {
  kind: 'youtube' | 'page';
  /** Who told: the channel or the site, «PlayStation», «Nintendo Direct» */
  name: string;
  url: string;
  startsAt: string;
}

/** What the crow says of a stream, written once for every chat, with `{when:start}` where its start goes */
export interface CrowEventTexts {
  announcement: string;
  reminder: string;
  /** For a chat where the stream falls into the quiet hours: in the evening before them */
  nightReminder: string;
}

/**
 * A stream the crow announces — a State of Play, a Nintendo Direct, a lab's
 * launch (docs/crow/behavior.md#streams): its start comes from YouTube's
 * schedule, or from the organizer's announcement with its time zone. Each chat
 * gets its own announcement and reminder in `crow_post`.
 */
@Entity('crow_event')
@Index('crow_event_key_key', ['key'], { unique: true })
@Index('crow_event_status_startsAt_idx', ['status', 'startsAt'])
export class CrowEvent extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** `youtube:<video id>`, or the page that announced it */
  @Column('text')
  key!: string;

  /** As the organizer names it */
  @Column('text')
  title!: string;

  @Column('text', { array: true })
  categories!: string[];

  /** Where to watch it */
  @Column('text')
  url!: string;

  @Column('timestamptz')
  startsAt!: Date;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  sources!: CrowEventSource[];

  /** The YouTube video of the stream, whose schedule is checked again before the start */
  @Column({ type: 'text', nullable: true })
  videoId!: string | null;

  @Column({ type: 'text', default: 'upcoming' })
  status!: CrowEventStatus;

  @Column({ type: 'jsonb', nullable: true })
  texts!: CrowEventTexts | null;

  /** When YouTube's schedule was last checked */
  @Column({ type: 'timestamptz', nullable: true })
  checkedAt!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
