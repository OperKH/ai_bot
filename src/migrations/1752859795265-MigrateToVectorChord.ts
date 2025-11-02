import { MigrationInterface, QueryRunner } from "typeorm";

export class MigrateToVectorChord1752859795265 implements MigrationInterface {
    name = 'MigrateToVectorChord1752859795265'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vchord;`);
        await queryRunner.query(`DROP INDEX IF EXISTS "chat_photo_message_embedding_idx"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ALTER COLUMN "embedding" SET DATA TYPE real[]`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ALTER COLUMN "embedding" SET DATA TYPE vector(512)`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "chat_photo_message_embedding_idx" ON "chat_photo_message" USING vchordrq ("embedding" vector_cosine_ops) WITH (options = $$
                residual_quantization = true
                [build.internal]
                lists = [2000]
                spherical_centroids = true
                build_threads = 4
                sampling_factor = 256
            $$)`);
        await queryRunner.query(`DROP EXTENSION IF EXISTS vectors`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vectors;`);
        await queryRunner.query(`DROP INDEX IF EXISTS "chat_photo_message_embedding_idx"`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ALTER COLUMN "embedding" SET DATA TYPE real[]`);
        await queryRunner.query(`ALTER TABLE "chat_photo_message" ALTER COLUMN "embedding" SET DATA TYPE vectors.vector(512)`);
        await queryRunner.query(`CREATE INDEX "chat_photo_message_embedding_idx" ON "chat_photo_message" USING vectors ("embedding" vector_l2_ops)`);
        await queryRunner.query(`DROP EXTENSION IF EXISTS vchord`);
    }

}
