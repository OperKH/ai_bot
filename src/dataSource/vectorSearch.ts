import { DataSource, EntityManager } from 'typeorm';

/** An earlier message found for a query, scored by its best frame */
export type MediaMatch = { messageId: string; similarity: number };

/**
 * Runs vector searches in a transaction that keeps the planner on the vector
 * indexes. Every sphere query goes through here, so a new one belongs in this file.
 *
 * The sphere operator `<<=>>` has no selectivity estimate, so the planner takes
 * any sphere for half the table. The vectors live in TOAST and leave the heap
 * small, so a sequential scan then looks cheaper than the index, and which one
 * wins depends on the statistics of the day. On the production data the same
 * near-duplicate lookup took 0.3 ms through the index and 230 ms as a sequential
 * scan. `SET LOCAL enable_seqscan = off` rules the scan out for this transaction
 * only, and the transaction holds the one connection its queries run on.
 */
function withVectorIndex<T>(dataSource: DataSource, work: (manager: EntityManager) => Promise<T>): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query('SET LOCAL enable_seqscan = off');
    return work(manager);
  });
}

/** Collects the parameters of a query; `param` adds one and returns its placeholder */
function queryParams() {
  const params: unknown[] = [];
  return { params, param: (value: unknown) => `$${params.push(value)}` };
}

/**
 * The CTE `hits`: every row of `table` inside the sphere around any of the
 * embeddings, with its `similarity`. It is MATERIALIZED, so the chat filter goes
 * on top of it, never next to the sphere. In the same WHERE the planner prefers
 * the chatId index, which it can estimate, and computes the distance for every
 * row of the chat: 230 ms instead of 0.3 in a chat with all the rows. The two
 * indexes cannot be combined either, vchordrq has no bitmap scan.
 */
function sphereHits(
  table: string,
  columns: string,
  embeddings: string[],
  threshold: number,
  param: (value: unknown) => string,
): string {
  const radius = param(1 - threshold);
  const branches = embeddings.map((embedding) => {
    const vector = `${param(embedding)}::vector`;
    return `SELECT ${columns}, "chatId", 1 - (embedding <=> ${vector}) AS similarity
      FROM ${table} WHERE embedding <<=>> sphere(${vector}, ${radius})`;
  });
  return `hits AS MATERIALIZED (${branches.join('\n UNION ALL ')})`;
}

export interface MediaQuery {
  chatId: number;
  /** A photo has one, a video one per frame, a text search one for the text */
  embeddings: string[];
  /** The lowest similarity that counts as a match */
  threshold: number;
  /** Keyset pagination: only the results ranked after this one */
  after?: MediaMatch | null;
  limit?: number;
}

/**
 * The chat's media within the threshold of any of the embeddings: one result per
 * message (a video has a row per frame), scored by its best frame.
 *
 * Ordered by similarity, then messageId: reposts score exactly the same, and
 * without the tiebreak their order, and so the page boundaries of a text search,
 * changed from query to query.
 */
export async function findSimilarMedia(dataSource: DataSource, query: MediaQuery): Promise<MediaMatch[]> {
  if (query.embeddings.length === 0) return [];
  const { params, param } = queryParams();
  const { after, limit } = query;
  const sql = `WITH ${sphereHits('chat_photo_message', '"messageId"', query.embeddings, query.threshold, param)},
    grouped AS (
      SELECT "messageId", max(similarity) AS similarity
      FROM hits
      WHERE "chatId" = ${param(String(query.chatId))}
      GROUP BY "messageId"
    )
    SELECT "messageId", similarity FROM grouped
    ${after ? `WHERE (similarity, "messageId") < (${param(after.similarity)}::float8, ${param(after.messageId)}::bigint)` : ''}
    ORDER BY similarity DESC, "messageId" DESC
    ${limit === undefined ? '' : `LIMIT ${param(limit)}`}`;

  const t1 = performance.now();
  const matches = await withVectorIndex(dataSource, (manager) => manager.query<MediaMatch[]>(sql, params));
  console.log(`DB query time: ${Math.round(performance.now() - t1)} ms (${query.embeddings.length} embeddings)`);
  return matches;
}

/** An ignore-list entry of the chat within the threshold of any of the embeddings, if there is one */
export async function findIgnoredMedia(
  dataSource: DataSource,
  chatId: number,
  embeddings: string[],
  threshold: number,
): Promise<{ id: string } | undefined> {
  if (embeddings.length === 0) return undefined;
  const { params, param } = queryParams();
  const sql = `WITH ${sphereHits('ignored_media', 'id', embeddings, threshold, param)}
    SELECT id FROM hits WHERE "chatId" = ${param(String(chatId))} LIMIT 1`;
  const [ignored] = await withVectorIndex(dataSource, (manager) => manager.query<{ id: string }[]>(sql, params));
  return ignored;
}
