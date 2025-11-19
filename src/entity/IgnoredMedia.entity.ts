import { BaseEntity, Column, ColumnType, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ignored_media')
export class IgnoredMedia extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('ignored_media_chatId_idx')
  @Column('bigint')
  chatId!: string;

  @Index('ignored_media_embedding_idx', { synchronize: false })
  @Column({ type: 'vector' as ColumnType, length: 512, select: false })
  embedding!: string;
}
