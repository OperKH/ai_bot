import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type CrowMessageKind = 'breaking' | 'fact' | 'versus' | 'practical';

/** A small table of a message, rendered as a rich message table */
export interface CrowTable {
  header: string[];
  rows: string[][];
}

/** One message of a story's arc, in the order the chat hears them */
@Entity('crow_story_message')
@Index('crow_story_message_storyId_seq_key', ['storyId', 'seq'], { unique: true })
export class CrowStoryMessage extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('int')
  storyId!: number;

  @Column('smallint')
  seq!: number;

  @Column('text')
  kind!: CrowMessageKind;

  /** How many 🐦‍⬛ open the message: 1 — background, 2 — important, 3 — breaking news */
  @Column('smallint')
  crows!: number;

  @Column('text')
  text!: string;

  @Column({ type: 'jsonb', nullable: true })
  table!: CrowTable | null;

  /** Can be left out without losing the point: chats with less boldness get fewer of these */
  @Column({ type: 'boolean', default: false })
  optional!: boolean;

  /** The facts of the story the message is built on */
  @Column('text', { array: true, default: () => "'{}'" })
  factIds!: string[];

  /** EmbeddingGemma's vector of the text, so a talk about it finds the post before its turn; null — none was made */
  @Column({ type: 'halfvec', length: 768, nullable: true, select: false })
  embedding!: number[] | null;
}
