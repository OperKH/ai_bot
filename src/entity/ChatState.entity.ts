import { BaseEntity, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('chat_state')
export class ChatState extends BaseEntity {
  @Index('chat_state_chatId_idx')
  @PrimaryColumn('bigint')
  chatId!: string;

  @Column('boolean', { default: false })
  isMediaImported!: boolean;

  @Column('boolean', { default: false })
  isVideoImportedByFrames!: boolean;

  /** IANA time zone the chat lives in, set with /timezone; null until someone does */
  @Column('varchar', { nullable: true })
  timeZone!: string | null;

  /**
   * Since when the bot keeps who posted the chat's media and when: the bayan statistics start with the first month
   * it watched whole (docs/media.md#bayans)
   */
  @Column('timestamptz', { nullable: true })
  mediaTrackedSince!: Date | null;

  /** The last month whose bayan statistics the chat got, `YYYY-MM` (docs/media.md#bayans) */
  @Column('varchar', { nullable: true })
  bayanStatsMonth!: string | null;
}
