import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A detail of a story that its arc did not tell, from the same sources: the crow
 * keeps it for a talk about the story (docs/crow/behavior.md#talking-in-the-chat).
 * Which chats heard it, the posts that told it say (`crow_post.snippetIds`).
 */
@Entity('crow_snippet')
@Index('crow_snippet_storyId_idx', ['storyId'])
export class CrowSnippet extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('int')
  storyId!: number;

  @Column('text')
  text!: string;

  /** EmbeddingGemma's vector of the text, so a talk about it finds the detail; null — none was made */
  @Column({ type: 'halfvec', length: 768, nullable: true, select: false })
  embedding!: number[] | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
