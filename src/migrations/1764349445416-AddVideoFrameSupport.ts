import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVideoFrameSupport1764349445416 implements MigrationInterface {
    name = 'AddVideoFrameSupport1764349445416'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ADD "mediaType" character varying(10) NOT NULL DEFAULT 'photo'`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ADD "frameIndex" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "chat_state" ADD "isVideoImportedByFrames" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chat_state" DROP COLUMN "isVideoImportedByFrames"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" DROP COLUMN "frameIndex"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" DROP COLUMN "mediaType"`);
    }

}
