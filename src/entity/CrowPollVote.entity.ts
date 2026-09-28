import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/** A cat's vote on a bet (`crow_poll`), as `poll_answer` brought it; a vote taken back is deleted */
@Entity('crow_poll_vote')
export class CrowPollVote extends BaseEntity {
  @PrimaryColumn('int')
  pollId!: number;

  @PrimaryColumn('bigint')
  userId!: string;

  /** How the chat knows the cat: the first name, or else the username */
  @Column('text')
  name!: string;

  @Column({ type: 'text', nullable: true })
  username!: string | null;

  @Column('smallint', { array: true })
  optionIds!: number[];

  @Column('timestamptz')
  votedAt!: Date;
}
