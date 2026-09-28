import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/** A category the crow brings news of into a chat */
@Entity('crow_subscription')
export class CrowSubscription extends BaseEntity {
  @PrimaryColumn('bigint')
  chatId!: string;

  @PrimaryColumn('text')
  categoryId!: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
