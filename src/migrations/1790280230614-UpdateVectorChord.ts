import { MigrationInterface, QueryRunner } from "typeorm";

const MIN_VCHORD_VERSION = '1.1.0';

const isAtLeast = (version: string, minimum: string): boolean => {
    const actual = version.split('.').map(Number);
    const required = minimum.split('.').map(Number);
    for (let i = 0; i < required.length; i++) {
        const part = actual[i] ?? 0;
        if (part !== required[i]) return part > required[i];
    }
    return true;
};

/**
 * `WITH (...)` of a vchordrq index for a table of `rows` rows, after VectorChord's
 * guidance: no partitions below 100k rows, about rows / 500 above.
 *
 * - Without partitions every vector is checked, so nothing is missed. Partitions
 *   on a small table lose matches: on 169 rows `lists = [400]` found half of the
 *   exact near-duplicates, some photos not even themselves.
 * - With partitions, `probes` is a quarter of them. On the production data (185k
 *   rows, 400 lists, 100 probes) a near-duplicate took 2 ms and missed nothing,
 *   and a text search page took 160 ms and found 67-93% of the exact top 30
 *   (10 probes: 0.4 ms and 20-57%). Set on the index, it needs no `SET` in code,
 *   which also works for an index without partitions, where a `probes` setting fails.
 */
const indexOptions = (rows: number): string => {
    if (rows < 100_000) {
        return `options = $$
                [build.internal]
                lists = []
            $$`;
    }
    const lists = Math.round(rows / 500);
    return `options = $$
                residual_quantization = true
                [build.internal]
                lists = [${lists}]
                spherical_centroids = true
                build_threads = 4
                sampling_factor = 256
            $$, probes = '${Math.round(lists / 4)}'`;
};

/**
 * Brings the VectorChord SQL objects up to the library shipped by the postgres
 * image and rebuilds the vector indexes for it.
 *
 * - The extension catalog lagged behind the image (created under 0.4.x, later
 *   run against the 0.5.3 library): an image bump replaces the library but not
 *   the SQL objects that `CREATE EXTENSION` made.
 * - vchordrq indexes carry an on-disk format number, and 1.1 cannot read indexes
 *   built by 0.5, so they are dropped and built again.
 * - Dropping comes first so that VACUUM does not touch index files the new
 *   library cannot read. VACUUM before the build works around VectorChord #470:
 *   building over dead tuples fails with "missing chunk for toast value".
 * - ANALYZE comes after the build: a vchordrq build overwrites the table's row
 *   estimate (4500 for 185k rows, 0 for 15), and the planner goes by it.
 * - `probes` moves into the index. A `SET vchordrq.probes` only affects the pooled
 *   connection it ran on, so the query after it could land on another one.
 * - The layout follows the table's size (`indexOptions`). The old `lists = [2000]`
 *   with 10 probes scanned 0.5% of the photos, too few for the wide radius of
 *   `/searchmedia`.
 * - `chat_photo_message_embedding_l2_idx` was created by hand, and nothing queries
 *   with the L2 operators, so it goes.
 *
 * VACUUM cannot run in a transaction, so neither can this migration. Every step
 * is idempotent: a run that stops halfway is repeated on the next start.
 */
export class UpdateVectorChord1790280230614 implements MigrationInterface {
    name = 'UpdateVectorChord1790280230614'
    transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        const [vchord] = await queryRunner.query(`SELECT default_version FROM pg_available_extensions WHERE name = 'vchord'`);
        if (!vchord || !isAtLeast(vchord.default_version, MIN_VCHORD_VERSION)) {
            throw new Error(
                `The postgres image ships VectorChord ${vchord?.default_version ?? 'none'}, this migration needs ${MIN_VCHORD_VERSION}+. ` +
                    'Switch the image to tensorchord/vchord-postgres:pg16-v1.1.1 first.',
            );
        }

        // TypeORM logs nothing on success with `logging: false`, and this takes minutes on a full table
        const startedAt = Date.now();
        console.log('[Migration] Updating VectorChord and rebuilding the vector indexes, this can take a few minutes');

        await queryRunner.query(`DROP INDEX IF EXISTS "chat_photo_message_embedding_l2_idx"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "chat_photo_message_embedding_idx"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "ignored_media_embedding_idx"`);

        await queryRunner.query(`VACUUM "chat_photo_message"`);
        await queryRunner.query(`VACUUM "ignored_media"`);

        await queryRunner.query(`ALTER EXTENSION vector UPDATE`);
        await queryRunner.query(`ALTER EXTENSION vchord UPDATE`);

        for (const table of ['chat_photo_message', 'ignored_media']) {
            const [{ rows }] = await queryRunner.query(`SELECT count(*)::int AS rows FROM "${table}"`);
            const options = indexOptions(rows);
            await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "${table}_embedding_idx" ON "${table}" USING vchordrq ("embedding" vector_cosine_ops) WITH (${options})`);
            await queryRunner.query(`ANALYZE "${table}"`);
            console.log(`[Migration] ${table}_embedding_idx: ${rows} rows, ${options.match(/lists = \[\d*\]/)![0]}`);
        }

        // UPDATE without TO moves the extension to the image's default version
        console.log(`[Migration] VectorChord ${vchord.default_version} ready, vector indexes rebuilt in ${Math.round((Date.now() - startedAt) / 1000)} s`);
    }

    /**
     * The extension cannot be downgraded in place: going back below 1.1 means
     * restoring the database from a backup. This only restores the old index
     * layout, so the previous code (which SETs probes per query) keeps working.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "chat_photo_message_embedding_idx"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "ignored_media_embedding_idx"`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "chat_photo_message_embedding_idx" ON "chat_photo_message" USING vchordrq ("embedding" vector_cosine_ops) WITH (options = $$
                residual_quantization = true
                [build.internal]
                lists = [2000]
                spherical_centroids = true
                build_threads = 4
                sampling_factor = 256
            $$)`);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "ignored_media_embedding_idx" ON "ignored_media" USING vchordrq ("embedding" vector_cosine_ops) WITH (options = $$
                residual_quantization = true
                [build.internal]
                lists = [2000]
                spherical_centroids = true
                build_threads = 4
                sampling_factor = 256
            $$)`);
    }

}
