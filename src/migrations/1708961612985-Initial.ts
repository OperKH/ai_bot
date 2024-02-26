import { MigrationInterface, QueryRunner } from "typeorm";

export class Initial1708961612985 implements MigrationInterface {
    name = 'Initial1708961612985'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vectors;`);
        await queryRunner.query(`CREATE TABLE "chat_state" ("chatId" bigint NOT NULL, "isMediaImported" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_cccd354b950a19442b57ca40959" PRIMARY KEY ("chatId"))`);
        await queryRunner.query(`CREATE INDEX "chat_state_chatId_idx" ON "chat_state" ("chatId") `);
        await queryRunner.query(`CREATE TABLE "chat_photo_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chatId" bigint NOT NULL, "messageId" bigint NOT NULL, "embedding" vector(512) NOT NULL, CONSTRAINT "PK_fbf4a15d9eb2262d886e559353b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "chat_photo_message_chatId_idx" ON "chat_photo_message" ("chatId")`);
        await queryRunner.query(`CREATE INDEX "chat_photo_message_embedding_idx" ON "chat_photo_message" USING vectors ("embedding" vector_l2_ops)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."chat_photo_message_embedding_idx"`);
        await queryRunner.query(`DROP INDEX "public"."chat_photo_message_chatId_idx"`);
        await queryRunner.query(`DROP TABLE "chat_photo_message"`);
        await queryRunner.query(`DROP INDEX "public"."chat_state_chatId_idx"`);
        await queryRunner.query(`DROP TABLE "chat_state"`);
        await queryRunner.query(`DROP EXTENSION IF EXISTS vectors`);
    }

}
