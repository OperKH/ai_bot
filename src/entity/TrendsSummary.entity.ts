import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SummarizationResult } from '../services/openai.service.js';

@Entity('trends_summary')
export class TrendsSummary extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('trends_summary_chatId_idx')
  @Column('bigint')
  chatId!: string;

  @Index('trends_summary_periodStart_idx')
  @Column({ type: 'timestamp' })
  periodStart!: Date;

  @Column({ type: 'timestamp' })
  periodEnd!: Date;

  @Column({ type: 'int' })
  periodHours!: number;

  @Column({ type: 'text' })
  summary!: string;

  @Column({ type: 'jsonb', nullable: true })
  resultJson!: SummarizationResult | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
