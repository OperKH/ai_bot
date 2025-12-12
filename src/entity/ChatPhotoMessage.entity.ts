import { BaseEntity, Column, ColumnType, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chat_photo_message')
export class ChatPhotoMessage extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('chat_photo_message_chatId_idx')
  @Column('bigint')
  chatId!: string;

  @Column('bigint')
  messageId!: string;

  @Column({ type: 'varchar', length: 10, default: 'photo' })
  mediaType!: 'photo' | 'video';

  @Column({ type: 'int', default: 0 })
  frameIndex!: number;

  @Index('chat_photo_message_embedding_idx', { synchronize: false })
  @Column({ type: 'vector' as ColumnType, length: 512, select: false })
  embedding!: string;
}
