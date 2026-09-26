import { BaseEntity, Column, ColumnType, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * State of one `/searchmedia` query, so its "Ще" button only has to carry the id:
 * callback data is capped at 64 bytes, too little for the query text and a cursor.
 * The cursor is the last result examined, the key of the keyset pagination
 * (similarity DESC, messageId DESC).
 */
@Entity('media_search')
export class MediaSearch extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('bigint')
  chatId!: string;

  @Column('text')
  text!: string;

  /**
   * CLIP embedding of the text, computed once. Every page is ranked by the same
   * vector the cursor belongs to, and a "Ще" press needs no translation: without
   * one the text would be embedded untranslated, and the cursor would no longer fit.
   */
  @Column({ type: 'vector' as ColumnType, length: 512 })
  embedding!: number[];

  @Column({ type: 'double precision', nullable: true })
  cursorSimilarity!: number | null;

  @Column({ type: 'bigint', nullable: true })
  cursorMessageId!: string | null;

  /** The bot's reply that carries the live "Ще" button, taken off when the search goes; null once the results ran out */
  @Column({ type: 'bigint', nullable: true })
  buttonMessageId!: string | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
