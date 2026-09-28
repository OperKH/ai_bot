import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/** When the bot owner was last told of a kind of trouble, so they hear of it once a day */
@Entity('owner_alert')
export class OwnerAlert extends BaseEntity {
  /** e.g. `openai-quota`, `crow-budget` */
  @PrimaryColumn('text')
  kind!: string;

  @Column({ type: 'timestamptz' })
  sentAt!: Date;
}
