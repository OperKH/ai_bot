import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A cat who pressed «🙅 Не чіпай мене» in a chat: the crow does not read their
 * messages for the profile and never names them — no jabs, no mentions
 */
@Entity('crow_member_optout')
export class CrowMemberOptout extends BaseEntity {
  @PrimaryColumn('bigint')
  chatId!: string;

  @PrimaryColumn('bigint')
  userId!: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
