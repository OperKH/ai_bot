import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCrowSortFailures1790757915199 implements MigrationInterface {
    name = 'AddCrowSortFailures1790757915199'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "crow_source_item" ADD "sortFailures" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "crow_source_item" DROP COLUMN "sortFailures"`);
    }

}
