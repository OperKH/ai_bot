import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A periodic job of the crow, such as polling a source. The schedule lives here
 * rather than in timers, so a restart knows what it missed.
 */
@Entity('crow_job')
export class CrowJob extends BaseEntity {
  @PrimaryColumn('text')
  name!: string;

  @Column('timestamptz')
  nextRunAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** What the job keeps between runs, e.g. a feed's ETag */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  state!: Record<string, unknown>;
}
