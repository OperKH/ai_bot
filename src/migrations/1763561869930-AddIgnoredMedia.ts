import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIgnoredMedia1763561869930 implements MigrationInterface {
    name = 'AddIgnoredMedia1763561869930'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ignored_media" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chatId" bigint NOT NULL, "embedding" vector(512) NOT NULL, CONSTRAINT "PK_343ce7ace3b9b6cca63eefd10e2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ignored_media_chatId_idx" ON "ignored_media" ("chatId") `);
        await queryRunner.query(`
            CREATE INDEX "ignored_media_embedding_idx" ON "ignored_media" USING vchordrq ("embedding" vector_cosine_ops) WITH (options = $$
                residual_quantization = true
                [build.internal]
                lists = [2000]
                spherical_centroids = true
                build_threads = 4
                sampling_factor = 256
            $$)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "ignored_media_embedding_idx"`);
        await queryRunner.query(`DROP INDEX "ignored_media_chatId_idx"`);
        await queryRunner.query(`DROP TABLE "ignored_media"`);
    }

}
