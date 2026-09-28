import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCrowNickname1790626024638 implements MigrationInterface {
    name = 'AddCrowNickname1790626024638'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "crow_nickname" ("chatId" bigint NOT NULL, "userId" bigint NOT NULL, "nickname" text NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_566487be1d4b1e42514549c431b" PRIMARY KEY ("chatId", "userId"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "crow_nickname"`);
    }

}
