import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTrendsFeature1769284638564 implements MigrationInterface {
    name = 'AddTrendsFeature1769284638564'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "chat_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chatId" bigint NOT NULL, "messageId" bigint NOT NULL, "userId" bigint NOT NULL, "userName" character varying(255), "userFirstName" character varying(255), "userLastName" character varying(255), "textContent" text NOT NULL, "hasPhoto" boolean NOT NULL DEFAULT false, "hasVideo" boolean NOT NULL DEFAULT false, "mediaDescription" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3cc0d85193aade457d3077dd06b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "chat_message_chatId_idx" ON "chat_message" ("chatId") `);
        await queryRunner.query(`CREATE INDEX "chat_message_userId_idx" ON "chat_message" ("userId") `);
        await queryRunner.query(`CREATE INDEX "chat_message_createdAt_idx" ON "chat_message" ("createdAt") `);
        await queryRunner.query(`CREATE TABLE "trends_summary" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chatId" bigint NOT NULL, "periodStart" TIMESTAMP NOT NULL, "periodEnd" TIMESTAMP NOT NULL, "periodHours" integer NOT NULL, "summary" text NOT NULL, "resultJson" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2a24f836eb8553f52616bb6d907" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "trends_summary_chatId_idx" ON "trends_summary" ("chatId") `);
        await queryRunner.query(`CREATE INDEX "trends_summary_periodStart_idx" ON "trends_summary" ("periodStart") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."trends_summary_periodStart_idx"`);
        await queryRunner.query(`DROP INDEX "public"."trends_summary_chatId_idx"`);
        await queryRunner.query(`DROP TABLE "trends_summary"`);
        await queryRunner.query(`DROP INDEX "public"."chat_message_createdAt_idx"`);
        await queryRunner.query(`DROP INDEX "public"."chat_message_userId_idx"`);
        await queryRunner.query(`DROP INDEX "public"."chat_message_chatId_idx"`);
        await queryRunner.query(`DROP TABLE "chat_message"`);
    }

}
