import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A `timestamp` column takes a JS Date in the bot process's time zone, while
 * `now()` fills it in the database's (UTC). Where the two differ, as on a
 * developer machine, "messages of the last 3 hours" found nothing. With
 * `timestamptz` both sides are absolute instants.
 *
 * The `createdAt` values came from `now()`, so they are read as UTC. The trends
 * cache was written from the process's time zone, which is not known here; it
 * is only a cache, so it is emptied instead.
 */
export class UseTimestampWithTimeZone1790426951421 implements MigrationInterface {
    name = 'UseTimestampWithTimeZone1790426951421'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "chat_message" ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE USING "createdAt" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "media_search" ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE USING "createdAt" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`DELETE FROM "trends_summary"`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "periodStart" TYPE TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "periodEnd" TYPE TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "trends_summary"`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "createdAt" TYPE TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "periodEnd" TYPE TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "trends_summary" ALTER COLUMN "periodStart" TYPE TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "media_search" ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC'`);
        await queryRunner.query(`ALTER TABLE "chat_message" ALTER COLUMN "createdAt" TYPE TIMESTAMP USING "createdAt" AT TIME ZONE 'UTC'`);
    }

}
