import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The news crow (docs/crow/): chat settings and subscriptions, stories with
 * their arcs, the per-chat post queue and the periodic jobs — the schedule
 * lives in these rows rather than in timers, so a restart picks up where the
 * bot stopped — plus every entry the news sources listed and the roster of the
 * labs' current models that goes into the crow's prompts. The roster starts
 * from the state of 23.09.2026 and is updated by the crow's own stories.
 *
 * Her days in a chat: the morning digest — a post of its own text, and the
 * openings it tells, which point at it with `mergedInto` and share its fate —
 * and the chat's profile for her personal jabs: the profile itself, the cats who
 * asked not to be touched, the chat's switch of the jabs, when she told the chat
 * that she reads it, and the cat a jab names. Her talks: the details a story's
 * arc did not tell and the aliases a talk about it is heard by, and on her posts
 * the cat's message they answer and its author, the depth in a thread, the
 * details told and the replies counted. What a post's own text refers to
 * (`extras`: moments, links, cats, a table), when a rumor came true, the bet a
 * story offers, the polls — the week's vote and the bets, with the cats' votes —
 * and the streams she announces, which their posts point at. EmbeddingGemma's
 * vectors (`halfvec(768)`) of the details, the posts of an arc and the entries of
 * the sources, with no vector index: every query of them narrows to one chat's
 * stories or a few days' entries first. The game news: when an entry's and a
 * story's games come or go, the games of their lists, and a story's quiz. The
 * day of her first post in a chat, her birthday there.
 *
 * With it come what the crow needs of the bot — the chat's time zone, set with
 * /timezone (docs/timezone.md), and the owner's alerts, sent once a day — and the
 * bayans of the chats (docs/media.md#bayans): who posted a media and when and
 * since when the chat is watched, the bayans themselves (`media_repeat`), and the
 * last month whose statistics a chat got.
 */
export class AddCrow1790440472371 implements MigrationInterface {
    name = 'AddCrow1790440472371'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "crow_chat" ("chatId" bigint NOT NULL, "boldness" text NOT NULL DEFAULT 'bold', "quietFrom" smallint DEFAULT '1380', "quietTo" smallint DEFAULT '600', "snoozedUntil" TIMESTAMP WITH TIME ZONE, "nextPostAt" TIMESTAMP WITH TIME ZONE, "settingsAdminOnly" boolean NOT NULL DEFAULT false, "personalJabs" boolean NOT NULL DEFAULT true, "introducedAt" TIMESTAMP WITH TIME ZONE, "firstPostAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7e91c6c481b82c54f2b2709fa18" PRIMARY KEY ("chatId"))`);
        await queryRunner.query(`CREATE TABLE "crow_event" ("id" SERIAL NOT NULL, "key" text NOT NULL, "title" text NOT NULL, "categories" text array NOT NULL, "url" text NOT NULL, "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL, "sources" jsonb NOT NULL DEFAULT '[]', "videoId" text, "status" text NOT NULL DEFAULT 'upcoming', "texts" jsonb, "checkedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3f3883556daae044033047c9adf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "crow_event_status_startsAt_idx" ON "crow_event"  ("status", "startsAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "crow_event_key_key" ON "crow_event"  ("key") `);
        await queryRunner.query(`CREATE TABLE "crow_job" ("name" text NOT NULL, "nextRunAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastRunAt" TIMESTAMP WITH TIME ZONE, "lastError" text, "state" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_5dadb2f891b6ce707d131833980" PRIMARY KEY ("name"))`);
        await queryRunner.query(`CREATE TABLE "crow_member_optout" ("chatId" bigint NOT NULL, "userId" bigint NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1ab78af5d796e5350b14ed44859" PRIMARY KEY ("chatId", "userId"))`);
        await queryRunner.query(`CREATE TABLE "crow_chat_profile" ("chatId" bigint NOT NULL, "profile" jsonb NOT NULL, "messageCount" integer NOT NULL, "builtAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_e9b4b36171371a5f7932500e7c2" PRIMARY KEY ("chatId"))`);
        await queryRunner.query(`CREATE TABLE "crow_poll" ("id" SERIAL NOT NULL, "chatId" bigint NOT NULL, "kind" text NOT NULL, "postId" integer, "storyId" integer, "pollId" text NOT NULL, "tgMessageId" bigint NOT NULL, "question" text NOT NULL, "options" text array NOT NULL, "storyIds" integer array NOT NULL DEFAULT '{}', "crowPick" smallint, "status" text NOT NULL DEFAULT 'open', "counts" integer array, "outcome" smallint, "closesAt" TIMESTAMP WITH TIME ZONE, "resolvesAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "settledAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_9440a79e28b43cdfe6f1488c586" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "crow_poll_chatId_kind_idx" ON "crow_poll"  ("chatId", "kind") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "crow_poll_pollId_key" ON "crow_poll"  ("pollId") `);
        await queryRunner.query(`CREATE TABLE "crow_post" ("id" SERIAL NOT NULL, "chatId" bigint NOT NULL, "storyId" integer, "storyMessageId" integer, "seq" smallint, "kind" text NOT NULL DEFAULT 'arc', "text" text, "extras" jsonb, "eventId" integer, "mergedInto" integer, "mention" jsonb, "importance" smallint NOT NULL DEFAULT '1', "optional" boolean NOT NULL DEFAULT false, "status" text NOT NULL DEFAULT 'planned', "gapMs" integer NOT NULL DEFAULT '0', "notBefore" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE, "sentAt" TIMESTAMP WITH TIME ZONE, "tgMessageId" bigint, "shooedBy" bigint array NOT NULL DEFAULT '{}', "replyToMessageId" bigint, "replyToUserId" bigint, "depth" smallint NOT NULL DEFAULT '0', "snippetIds" integer array NOT NULL DEFAULT '{}', "replyCount" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c556b9464a5c45ab11015226952" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "crow_post_chatId_tgMessageId_idx" ON "crow_post"  ("chatId", "tgMessageId") `);
        await queryRunner.query(`CREATE INDEX "crow_post_chatId_sentAt_idx" ON "crow_post"  ("chatId", "sentAt") `);
        await queryRunner.query(`CREATE INDEX "crow_post_status_notBefore_idx" ON "crow_post"  ("status", "notBefore") `);
        await queryRunner.query(`CREATE INDEX "crow_post_chatId_storyId_seq_idx" ON "crow_post"  ("chatId", "storyId", "seq") `);
        await queryRunner.query(`CREATE INDEX "crow_post_eventId_idx" ON "crow_post"  ("eventId") WHERE "eventId" IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "crow_poll_vote" ("pollId" integer NOT NULL, "userId" bigint NOT NULL, "name" text NOT NULL, "username" text, "optionIds" smallint array NOT NULL, "votedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_d3364661f7990f43829edd4294f" PRIMARY KEY ("pollId", "userId"))`);
        await queryRunner.query(`CREATE TABLE "crow_roster" ("provider" text NOT NULL, "flagship" text NOT NULL, "releasedAt" date, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_157c7394c048e5025d34bd70492" PRIMARY KEY ("provider"))`);
        await queryRunner.query(`CREATE TABLE "crow_snippet" ("id" SERIAL NOT NULL, "storyId" integer NOT NULL, "text" text NOT NULL, "embedding" halfvec(768), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d124da453d3f1643a5d5adc7d5b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "crow_snippet_storyId_idx" ON "crow_snippet"  ("storyId") `);
        await queryRunner.query(`CREATE TABLE "crow_source_item" ("id" SERIAL NOT NULL, "sourceId" text NOT NULL, "key" text NOT NULL, "title" text NOT NULL, "url" text, "summary" text NOT NULL DEFAULT '', "contentHash" text, "imageUrl" text, "deadline" jsonb, "games" jsonb, "publishedAt" TIMESTAMP WITH TIME ZONE, "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "status" text NOT NULL DEFAULT 'new', "storyId" integer, "embedding" halfvec(768), CONSTRAINT "PK_d8704b7401866bc7714209857f6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "crow_source_item_status_idx" ON "crow_source_item"  ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "crow_source_item_sourceId_key_key" ON "crow_source_item"  ("sourceId", "key") `);
        await queryRunner.query(`CREATE INDEX "crow_source_item_storyId_idx" ON "crow_source_item"  ("storyId") `);
        await queryRunner.query(`CREATE TABLE "crow_story" ("id" SERIAL NOT NULL, "storyKey" text NOT NULL, "title" text NOT NULL, "topicKey" text, "vendor" text, "hero" text, "aliases" text array NOT NULL DEFAULT '{}', "categories" text array NOT NULL, "importance" smallint NOT NULL, "isRumor" boolean NOT NULL DEFAULT false, "eventType" text, "facts" jsonb NOT NULL DEFAULT '[]', "sources" jsonb NOT NULL DEFAULT '[]', "imageUrl" text, "imageFileId" text, "stance" jsonb, "bet" jsonb, "deadline" jsonb, "games" jsonb, "quiz" jsonb, "confirmedAt" TIMESTAMP WITH TIME ZONE, "status" text NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "readyAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cd7c5e6148ced7da4d7e2adf755" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "crow_story_storyKey_key" ON "crow_story"  ("storyKey") `);
        await queryRunner.query(`CREATE INDEX "crow_story_topicKey_idx" ON "crow_story"  ("topicKey") `);
        await queryRunner.query(`CREATE TABLE "crow_story_message" ("id" SERIAL NOT NULL, "storyId" integer NOT NULL, "seq" smallint NOT NULL, "kind" text NOT NULL, "crows" smallint NOT NULL, "text" text NOT NULL, "table" jsonb, "optional" boolean NOT NULL DEFAULT false, "factIds" text array NOT NULL DEFAULT '{}', "embedding" halfvec(768), CONSTRAINT "PK_878126db27d3c52e19d0012384e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "crow_story_message_storyId_seq_key" ON "crow_story_message"  ("storyId", "seq") `);
        await queryRunner.query(`CREATE TABLE "crow_subscription" ("chatId" bigint NOT NULL, "categoryId" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d12868d350dee4b41269667bf5d" PRIMARY KEY ("chatId", "categoryId"))`);
        await queryRunner.query(`CREATE TABLE "media_repeat" ("id" SERIAL NOT NULL, "chatId" bigint NOT NULL, "messageId" bigint NOT NULL, "authorId" bigint NOT NULL, "authorName" text NOT NULL, "mediaType" character varying(10) NOT NULL, "firstMessageId" bigint NOT NULL, "previousMessageId" bigint NOT NULL, "copies" integer NOT NULL, "similarity" real NOT NULL, "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_1fd6088dc267406d45df0ef1ce0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "media_repeat_chatId_sentAt_idx" ON "media_repeat"  ("chatId", "sentAt") `);
        await queryRunner.query(`CREATE TABLE "owner_alert" ("kind" text NOT NULL, "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_7b6c50e0c7ffeeb05b50504f541" PRIMARY KEY ("kind"))`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ADD "userId" bigint`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ADD "sentAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "chat_state" ADD "timeZone" character varying`);
        await queryRunner.query(`ALTER TABLE "chat_state" ADD "mediaTrackedSince" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "chat_state" ADD "bayanStatsMonth" character varying`);
        await queryRunner.query(`CREATE INDEX "chat_photo_message_chatId_sentAt_idx" ON "chat_photo_message"  ("chatId", "sentAt") `);
        await queryRunner.query(`INSERT INTO "crow_roster" ("provider", "flagship", "releasedAt") VALUES
            ('openai', 'GPT-6 Astra (старший тариф), GPT-6 Sol, GPT-6 Luna', '2026-09-22'),
            ('anthropic', 'Claude Opus 5.5, Claude Fable 5.1', '2026-09-22'),
            ('google', 'Gemini 3.8 Flash', '2026-09-02'),
            ('xai', 'Grok 4.7', NULL),
            ('deepseek', 'DeepSeek-V4.1-Flash', '2026-09-10'),
            ('alibaba', 'Qwen 3.8 (Omni-Flash; 27B для свого заліза)', '2026-09-18'),
            ('moonshot', 'Kimi-K3', '2026-07-16'),
            ('zhipu', 'GLM-5.3', NULL),
            ('minimax', 'MiniMax H3', '2026-07-31'),
            ('meta', 'Muse Spark (Meta Superintelligence Labs)', NULL),
            ('xiaomi', 'MiMo-V2.6', '2026-09-21')`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."chat_photo_message_chatId_sentAt_idx"`);
        await queryRunner.query(`ALTER TABLE "chat_state" DROP COLUMN "bayanStatsMonth"`);
        await queryRunner.query(`ALTER TABLE "chat_state" DROP COLUMN "mediaTrackedSince"`);
        await queryRunner.query(`ALTER TABLE "chat_state" DROP COLUMN "timeZone"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" DROP COLUMN "sentAt"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" DROP COLUMN "userId"`);
        await queryRunner.query(`DROP TABLE "owner_alert"`);
        await queryRunner.query(`DROP INDEX "public"."media_repeat_chatId_sentAt_idx"`);
        await queryRunner.query(`DROP TABLE "media_repeat"`);
        await queryRunner.query(`DROP TABLE "crow_subscription"`);
        await queryRunner.query(`DROP INDEX "public"."crow_story_message_storyId_seq_key"`);
        await queryRunner.query(`DROP TABLE "crow_story_message"`);
        await queryRunner.query(`DROP INDEX "public"."crow_story_topicKey_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_story_storyKey_key"`);
        await queryRunner.query(`DROP TABLE "crow_story"`);
        await queryRunner.query(`DROP INDEX "public"."crow_source_item_storyId_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_source_item_sourceId_key_key"`);
        await queryRunner.query(`DROP INDEX "public"."crow_source_item_status_idx"`);
        await queryRunner.query(`DROP TABLE "crow_source_item"`);
        await queryRunner.query(`DROP INDEX "public"."crow_snippet_storyId_idx"`);
        await queryRunner.query(`DROP TABLE "crow_snippet"`);
        await queryRunner.query(`DROP TABLE "crow_roster"`);
        await queryRunner.query(`DROP TABLE "crow_poll_vote"`);
        await queryRunner.query(`DROP INDEX "public"."crow_post_eventId_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_post_chatId_storyId_seq_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_post_status_notBefore_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_post_chatId_sentAt_idx"`);
        await queryRunner.query(`DROP INDEX "public"."crow_post_chatId_tgMessageId_idx"`);
        await queryRunner.query(`DROP TABLE "crow_post"`);
        await queryRunner.query(`DROP INDEX "public"."crow_poll_pollId_key"`);
        await queryRunner.query(`DROP INDEX "public"."crow_poll_chatId_kind_idx"`);
        await queryRunner.query(`DROP TABLE "crow_poll"`);
        await queryRunner.query(`DROP TABLE "crow_chat_profile"`);
        await queryRunner.query(`DROP TABLE "crow_member_optout"`);
        await queryRunner.query(`DROP TABLE "crow_job"`);
        await queryRunner.query(`DROP INDEX "public"."crow_event_key_key"`);
        await queryRunner.query(`DROP INDEX "public"."crow_event_status_startsAt_idx"`);
        await queryRunner.query(`DROP TABLE "crow_event"`);
        await queryRunner.query(`DROP TABLE "crow_chat"`);
    }

}
