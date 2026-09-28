import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

/** A cat of the chat as the crow knows them: games and tech only */
export interface CrowProfileMember {
  userId: string;
  /** How the chat knows them: the first name, or the username */
  name: string;
  username: string | null;
  /** Platforms, games, tools, sides taken in arguments — nothing else */
  topics: string[];
}

/** What a chat lives by, for the crow's jabs: built from its own messages */
export interface CrowProfile {
  /** The chat's interests, the strongest first */
  interests: string[];
  /** Its running jokes */
  memes: string[];
  members: CrowProfileMember[];
}

/**
 * The profile of a chat (docs/crow/behavior.md#the-chat-profile-and-the-jabs),
 * rebuilt once a week from the last 30 days of `chat_message`, which keeps 90;
 * the profile keeps its latest version. Cats who asked not to be touched are
 * neither read nor kept.
 */
@Entity('crow_chat_profile')
export class CrowChatProfile extends BaseEntity {
  @PrimaryColumn('bigint')
  chatId!: string;

  @Column('jsonb')
  profile!: CrowProfile;

  /** How many messages it was built from */
  @Column('int')
  messageCount!: number;

  @Column('timestamptz')
  builtAt!: Date;
}
