import { BaseEntity, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('chat_state')
export class ChatState extends BaseEntity {
  @Index('chat_state_chatId_idx')
  @PrimaryColumn('bigint')
  chatId!: string;

  @Column({ default: false })
  isMediaImported!: boolean;
}
