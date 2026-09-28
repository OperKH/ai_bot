import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A bayan: a photo or a video that repeats an earlier one of the chat (docs/media.md#bayans), kept when the
 * «seen it before» reply finds the copies. The chat's statistics of the month are counted from these rows.
 */
@Entity('media_repeat')
@Index('media_repeat_chatId_sentAt_idx', ['chatId', 'sentAt'])
export class MediaRepeat extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('bigint')
  chatId!: string;

  @Column('bigint')
  messageId!: string;

  /** Who posted it: the user, or the channel or group it was sent on behalf of */
  @Column('bigint')
  authorId!: string;

  /** The author's name as it was then */
  @Column('text')
  authorName!: string;

  @Column({ type: 'varchar', length: 10 })
  mediaType!: 'photo' | 'video';

  /** The earliest copy found: where the bayan goes back to */
  @Column('bigint')
  firstMessageId!: string;

  /** The latest copy before it */
  @Column('bigint')
  previousMessageId!: string;

  /** How many copies of it the chat had before */
  @Column('int')
  copies!: number;

  @Column('real')
  similarity!: number;

  @Column('timestamptz')
  sentAt!: Date;
}
