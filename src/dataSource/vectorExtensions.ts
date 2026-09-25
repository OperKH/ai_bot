import { DataSource } from 'typeorm';

type ExtensionRow = { name: string; default_version: string; installed_version: string | null };

/**
 * Partitions (`lists`) a vchordrq index should have for a table of `rows` rows:
 * none below 100k, about rows / 500 above. UpdateVectorChord builds by the same rule.
 */
const fittingLists = (rows: number) => (rows < 100_000 ? 0 : Math.round(rows / 500));

/**
 * The postgres image ships the VectorChord and pgvector libraries, but the SQL
 * objects in the database and the on-disk format of vchordrq indexes only change
 * through a migration (`ALTER EXTENSION ... UPDATE`, rebuilding the indexes).
 * After an image bump without one, vector search fails deep inside a handler
 * with "bad version number". This says so once, at startup, without stopping the
 * bot: its other features do not depend on vector search. It never rejects, so
 * the bot starts without waiting for it.
 *
 * It also warns when an index's partitions no longer fit its table: an index is
 * sized for the rows it was built on, and the table keeps growing.
 */
export async function checkVectorExtensions(dataSource: DataSource): Promise<void> {
  try {
    const extensions: ExtensionRow[] = await dataSource.query(
      `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name IN ('vchord', 'vector')`,
    );
    for (const { name, default_version, installed_version } of extensions) {
      if (installed_version !== default_version) {
        console.warn(
          `Postgres extension ${name} is ${installed_version ?? 'not installed'}, the image ships ${default_version}: ` +
            `add a migration with ALTER EXTENSION ${name} UPDATE (and rebuild the vchordrq indexes if the release needs it)`,
        );
      }
    }

    const indexes: { name: string; rows: number; options: string | null }[] = await dataSource.query(
      `SELECT c.relname AS name, greatest(t.reltuples, 0)::bigint::int AS rows,
              array_to_string(c.reloptions, ' ') AS options
       FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_am a ON a.oid = c.relam
       WHERE a.amname = 'vchordrq'`,
    );
    for (const { name, rows, options } of indexes) {
      try {
        await dataSource.query('SELECT vchordrq_prewarm($1::regclass)', [name]);
      } catch (e) {
        console.error(`Vector index ${name} is unreadable, searches through it will fail until it is rebuilt:`, e);
      }

      const lists = Number(/lists\s*=\s*\[\s*(\d*)/.exec(options ?? '')?.[1] || 0);
      const fitting = fittingLists(rows);
      if ((lists === 0) !== (fitting === 0) || lists > fitting * 2 || lists < fitting / 2) {
        console.warn(
          `Vector index ${name} has ${lists || 'no'} partitions for about ${rows} rows, ${fitting || 'none'} would fit: ` +
            'rebuild it as "Vector index layout" in CLAUDE.md describes',
        );
      }
    }
  } catch (e) {
    console.error('Could not check the vector extensions:', e);
  }
}
