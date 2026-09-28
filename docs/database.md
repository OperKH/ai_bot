# Database, migrations and vector search

PostgreSQL with the VectorChord extension (required for vector operations and the `vchordrq` index). The
image is set in `docker-compose.yaml`:

```yaml
image: tensorchord/vchord-postgres:pg16-v1.1.1
```

The general rules — `timestamptz`, no foreign keys, migrations — are in
[CLAUDE.md](../CLAUDE.md#database); each module's tables are described in its own doc.

## Migrations

Migrations run automatically on startup (`migrationsRun: true` in the data source). `migrationsTransactionMode`
is `each`: every migration runs in its own transaction, and a migration may set `transaction = false`
(needed for `VACUUM`). The default `all` mode rejects any migration that sets `transaction`.

Generate one from the compiled data source, so run `npm run build` first:

```bash
npx typeorm migration:generate ./src/migrations/MigrationName -d ./dist/dataSource/dataSource.js
```

The first migration used to create pgvecto.rs (`vectors`, the original engine), which the VectorChord
images do not ship. It now creates pgvector's `vector` instead, so a fresh database can be built from
migrations alone.

**Why `timestamptz`:** a `timestamp` column takes a JS Date in the bot process's time zone while `now()`
fills it in the database's (UTC), so where the two differ, as on a developer machine in Kyiv, "messages of
the last 3 hours" found nothing (migration `UseTimestampWithTimeZone`).

## Upgrading VectorChord or pgvector

The image ships the extension library, but the SQL objects that `CREATE EXTENSION` made stay at their old
version until `ALTER EXTENSION ... UPDATE`. vchordrq indexes also carry an on-disk format number: an index
built by an older format group is unreadable after the upgrade, and every search, insert and VACUUM on it
fails with `bad version number`.

- Bump the image tag and add a migration in the same commit. See
  [1790280230614-UpdateVectorChord.ts](../src/migrations/1790280230614-UpdateVectorChord.ts): check the
  image's version, drop the vchordrq indexes, `VACUUM`, `ALTER EXTENSION ... UPDATE`, build the indexes
  again (sized as in [Vector index layout](#vector-index-layout)) and `ANALYZE`.
- `VACUUM` before the rebuild works around VectorChord #470: a build over dead tuples fails with
  `missing chunk for toast value`.
- There is no in-place downgrade; going back means restoring a backup.
- At startup [vectorExtensions.ts](../src/dataSource/vectorExtensions.ts) warns when an installed version
  differs from the image's, and reports vchordrq indexes that cannot be read. It only logs, and the bot
  starts without waiting for it.

## Vector similarity search

Images and text are converted to 512-dimensional CLIP embeddings, stored in a `vector(512)` column and
written as `'[...]'` strings; queries use the cosine distance with configurable thresholds.

**Every sphere query goes through [vectorSearch.ts](../src/dataSource/vectorSearch.ts).**
`findSimilarMedia` (a chat's media: near-duplicates of a photo or of a video's frames, and the text search)
and `findIgnoredMedia` (the ignore list) run inside `withVectorIndex`. A new vector query goes into that file.
The crow's queries there (`talkMaterialScores`, `closestGameStories`) are no sphere queries: they narrow to one chat's
stories or the entries of the last days' game stories first and compare the few dozen EmbeddingGemma vectors (`halfvec(768)`) left
exactly, so they need neither an index nor `withVectorIndex`.
The sphere operator `<<=>>` (within a radius, `1 - threshold`) is what the vchordrq index answers, and two
things keep the planner on it:

- **`SET LOCAL enable_seqscan = off`.** `<<=>>` has no selectivity estimate, so the planner assumes any
  sphere holds half the table. The vectors are stored in TOAST (about 490 MB) and leave the heap at 16 MB,
  so a sequential scan then looks cheaper than the index. The choice flips with the statistics: on the
  production copy the same near-duplicate lookup went through the index right after a migration and
  became a sequential scan after the next autoanalyze. `SET LOCAL` holds for the transaction's one
  connection and resets at commit.
- **The chat filter on top of a `MATERIALIZED` CTE.** The sphere scan runs alone in the CTE; the `chatId`
  filter, the grouping by message and the ordering apply on top of it. With `chatId` in the same WHERE the
  planner takes the chatId B-tree, which it can estimate, and computes the distance for every row of the
  chat. The two indexes cannot be combined either: vchordrq has no bitmap scan.

Measured on the production copy (185k rows, one chat holding nearly all of them):

| Query                      | Sequential scan (planner's choice) | Through `vectorSearch.ts` |
| -------------------------- | ---------------------------------- | ------------------------- |
| Near-duplicate of a photo  | 227 ms                             | 0.3 ms                    |
| `chatId` in the same WHERE | 226 ms (chatId B-tree)             | —                         |
| Text search page           | 425 ms                             | 80–150 ms                 |

Letting the index sort (`ORDER BY embedding <=> q LIMIT n`) also keeps it on the index, but it reranks
every candidate of the probed partitions: 25 ms for a near-duplicate.

**Search parameters live on the index, never in a `SET`.** `probes` (how many of the index's `lists`
partitions a query scans) is an index storage parameter since VectorChord 1.1: `WITH (..., probes = '93')`
at creation, `ALTER INDEX ... SET (probes = '...')` to tune it without a rebuild. Do not
`SET vchordrq.probes` from code:

- a `SET` through `dataSource.query` lands on one pooled connection, and the query after it may run on
  another;
- the GUC also overrides every other vchordrq index the connection touches. An index built with
  `lists = []` fails outright under it (`need 0 probes, but 1 probes provided`).

## Vector index layout

The layout follows the table's size, after VectorChord's guidance (`indexOptions` in the migration
`UpdateVectorChord`):

- **Below 100k rows: no partitions** (`lists = []`). Every vector is checked, so nothing is missed.
  Partitions on a small table lose matches: on the dev database (169 rows) `lists = [400]` found half of
  the exact near-duplicates, and some photos did not even find themselves.
- **From 100k rows: about rows / 500 partitions, `probes` a quarter of them.** Production has
  `lists = [370]`, `probes = '93'`. One `probes` serves both kinds of query, so no code needs a `SET`.

Measured on the production copy (185k rows; the text search at threshold 0.225, recall of the exact top 30
over five queries):

| Layout                      | Near-duplicate | Text search page | Text recall |
| --------------------------- | -------------- | ---------------- | ----------- |
| `lists = [400]`, probes 10  | 0.4 ms         | 15 ms            | 20–57%      |
| `lists = [400]`, probes 100 | 2.3 ms         | 160 ms           | 67–93%      |
| `lists = [400]`, probes 400 | 5.9 ms         | 550 ms           | 100%        |
| `lists = []`                | 5.1 ms         | 420 ms           | 100%        |

Near-duplicates were all found in every layout.

An index is sized for the rows it was built on, and the table keeps growing. At startup
[vectorExtensions.ts](../src/dataSource/vectorExtensions.ts) warns when an index's partitions no longer fit
(none on a table past 100k rows, or off by more than twice). A new vector index follows the same rule. To
rebuild one, in a migration:

```sql
DROP INDEX chat_photo_message_embedding_idx;
VACUUM chat_photo_message;  -- VectorChord #470: a build over dead tuples fails
CREATE INDEX chat_photo_message_embedding_idx ON chat_photo_message
  USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
    residual_quantization = true
    [build.internal]
    lists = [<rows / 500>]
    spherical_centroids = true
    build_threads = 4
    sampling_factor = 256
  $$, probes = '<lists / 4>');
ANALYZE chat_photo_message;  -- the build overwrites the table's row estimate
```

`ANALYZE` after the build matters: a vchordrq build leaves the table's row estimate wrong (4500 for 185k
rows, 0 for 15), and the planner goes by it until the next autoanalyze.

SQL and index behaviour need a real Postgres/VectorChord and are not unit-tested.
