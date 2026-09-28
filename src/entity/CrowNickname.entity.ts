import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * How the crow calls a cat of a chat in her talks — «вовче» for one who said he is a wolf — as she answers them
 * (docs/crow/behavior.md#talking-in-the-chat). Kept while she keeps calling them so; a cat who pressed «🙅 Не чіпай
 * мене» has none
 */
@Entity('crow_nickname')
export class CrowNickname extends BaseEntity {
  @PrimaryColumn('bigint')
  chatId!: string;

  @PrimaryColumn('bigint')
  userId!: string;

  /** As she addresses the cat, «вовче» */
  @Column('text')
  nickname!: string;

  /** When she last called the cat so */
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  usedAt!: Date;
}
