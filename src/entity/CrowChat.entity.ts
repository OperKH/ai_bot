import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

export type CrowBoldness = 'restrained' | 'bold' | 'pestering';

/** The crow's settings in one chat. It posts there only while the chat has a subscription */
@Entity('crow_chat')
export class CrowChat extends BaseEntity {
  @PrimaryColumn('bigint')
  chatId!: string;

  @Column({ type: 'text', default: 'bold' })
  boldness!: CrowBoldness;

  /** Quiet hours, in minutes after midnight in the chat's zone (/timezone, UTC until set); both null — none */
  @Column({ type: 'smallint', nullable: true, default: 1380 })
  quietFrom!: number | null;

  @Column({ type: 'smallint', nullable: true, default: 600 })
  quietTo!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  snoozedUntil!: Date | null;

  /** No post before this: the minimal gap after the last one, its random part drawn once */
  @Column({ type: 'timestamptz', nullable: true })
  nextPostAt!: Date | null;

  /** Only admins may change the subscriptions and settings */
  @Column({ type: 'boolean', default: false })
  settingsAdminOnly!: boolean;

  /** The crow may jab the cats by name, from the chat's profile; off — no profile at all */
  @Column({ type: 'boolean', default: true })
  personalJabs!: boolean;

  /** When the crow told the chat that she reads it; null — not yet */
  @Column({ type: 'timestamptz', nullable: true })
  introducedAt!: Date | null;

  /** When her first post went out in the chat: her birthday there (docs/crow/behavior.md#birthday); null — none yet */
  @Column({ type: 'timestamptz', nullable: true })
  firstPostAt!: Date | null;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
