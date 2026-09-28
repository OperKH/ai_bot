import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The current models of each AI lab. They go into every prompt of the crow: a
 * model's own knowledge of these releases is stale, and without the list it
 * would mock competitors that were retired long ago.
 */
@Entity('crow_roster')
export class CrowRoster extends BaseEntity {
  /** The vendor as the stories name it, e.g. `openai` */
  @PrimaryColumn('text')
  provider!: string;

  /** What the lab leads with now, newest first, e.g. «GPT-6 Astra, GPT-6 Sol, GPT-6 Luna» (see `mergeRoster`) */
  @Column('text')
  flagship!: string;

  @Column({ type: 'date', nullable: true })
  releasedAt!: string | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
