import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMediaSearch1790335847376 implements MigrationInterface {
    name = 'AddMediaSearch1790335847376'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "media_search" ("id" SERIAL NOT NULL, "chatId" bigint NOT NULL, "text" text NOT NULL, "embedding" vector(512) NOT NULL, "cursorSimilarity" double precision, "cursorMessageId" bigint, "buttonMessageId" bigint, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_245e20779a43f527df0d41a8728" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "media_search"`);
    }

}
