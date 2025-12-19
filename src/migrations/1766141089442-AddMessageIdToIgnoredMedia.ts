import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMessageIdToIgnoredMedia1766141089442 implements MigrationInterface {
    name = 'AddMessageIdToIgnoredMedia1766141089442'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ignored_media" ADD "messageId" bigint`);
        await queryRunner.query(`UPDATE "ignored_media" SET "messageId" = 0 WHERE "messageId" IS NULL`);
        await queryRunner.query(`ALTER TABLE "ignored_media" ALTER COLUMN "messageId" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ignored_media" DROP COLUMN "messageId"`);
    }

}
