import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chat_message')
export class ChatMessage extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('chat_message_chatId_idx')
  @Column('bigint')
  chatId!: string;

  @Column('bigint')
  messageId!: string;

  @Index('chat_message_userId_idx')
  @Column('bigint')
  userId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userName!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userFirstName!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userLastName!: string | null;

  @Column({ type: 'text' })
  textContent!: string;

  @Column({ type: 'boolean', default: false })
  hasPhoto!: boolean;

  @Column({ type: 'boolean', default: false })
  hasVideo!: boolean;

  @Column({ type: 'text', nullable: true })
  mediaDescription!: string | null;

  @Index('chat_message_createdAt_idx')
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
