import type { MediaMatch } from '../../dataSource/vectorSearch';

/**
 * What replying with matches needs from the chat and the store. The command
 * backs it with Telegraf and TypeORM; the tests with a fake.
 */
export interface MatchReplyPort {
  /** Sends a message, as a reply to `replyToId` when given; returns the sent message's id */
  send(text: string, replyToId?: number): Promise<number>;
  /**
   * Replies to an earlier message even if it no longer exists
   * (`allow_sending_without_reply`); `attached` tells whether it still did.
   * With `moreCallbackData` the reply carries the "Ще" button.
   */
  replyToEarlier(
    replyToId: number,
    text: string,
    moreCallbackData?: string,
  ): Promise<{ messageId: number; attached: boolean }>;
  delete(messageId: number): Promise<void>;
  /** Drops a deleted message from the store, so it is not found again */
  forget(messageId: string): Promise<void>;
  /** The pause between two replies */
  pause(): Promise<void>;
}

/** Captions of the "seen it before" replies, in the order they are shown */
const DUPLICATE_VARIANTS = ['ось тут', 'ще тут', 'і ось', 'навіть це', 'і оце щось схоже'];

/**
 * Replies to an earlier message and returns the reply's id, or null when that
 * message has been deleted.
 *
 * The Bot API does not tell a bot about deletions in a group. The reply goes out
 * with `allow_sending_without_reply`, so for a deleted message it arrives
 * unattached: that is what gives it away. The stray reply is taken back, and the
 * message is forgotten so it is not found again.
 */
async function replyToMatch(
  port: MatchReplyPort,
  match: MediaMatch,
  text: string,
  moreCallbackData?: string,
): Promise<number | null> {
  const reply = await port.replyToEarlier(Number(match.messageId), text, moreCallbackData);
  if (reply.attached) return reply.messageId;

  await port.delete(reply.messageId);
  await port.forget(match.messageId);
  return null;
}

/**
 * The "seen it before" thread under a new photo or video: up to `limit` of the
 * earlier messages in `matches` (best first) that still exist. If none does, the
 * header goes too, so nobody is called out without the evidence.
 */
export async function replyWithDuplicates(
  port: MatchReplyPort,
  messageId: number,
  matches: MediaMatch[],
  limit: number,
): Promise<void> {
  if (matches.length === 0) return;
  const headerId = await port.send('🕵️‍♀️ Здається, я це вже десь бачив...', messageId);
  let shown = 0;
  for (const match of matches) {
    if (shown === limit) break;
    const variant = DUPLICATE_VARIANTS[shown % DUPLICATE_VARIANTS.length];
    if ((await replyToMatch(port, match, `${variant} (${Math.round(match.similarity * 1e4) / 1e2}%)`)) !== null) {
      shown++;
    }
    await port.pause();
  }
  if (shown === 0) await port.delete(headerId);
}

/** One page of `/searchmedia` results */
export interface SearchPage {
  /** The search text, shown in every result */
  text: string;
  /** Where the previous page stopped; null on the first page */
  cursor: MediaMatch | null;
  /** The user's command, answered by a header; only on the first page */
  firstMessageId?: number;
  limit: number;
  /** The stored search, which the "Ще" button points at */
  searchId: number;
  /** The next `count` results of the ranking after `cursor` */
  find(cursor: MediaMatch | null, count: number): Promise<MediaMatch[]>;
}

/** Where a page of search results stopped */
export interface SearchPageEnd {
  /** The last result examined; the next page starts after it */
  cursor: MediaMatch | null;
  /** The reply that carries the "Ще" button; null when the results ran out */
  buttonMessageId: number | null;
}

/**
 * Shows a page of search results. Results whose message is gone are dropped as
 * they come up (see `replyToMatch`) and the page is filled from further down the
 * ranking, so it only comes up short at the end of the results.
 *
 * Asking for one more than needed tells whether a next page exists. Only the last
 * result of a batch can fill the page, so it is the one sent with the "Ще"
 * button; if it turns out stray, the button is taken back with it.
 */
export async function showSearchPage(port: MatchReplyPort, page: SearchPage): Promise<SearchPageEnd> {
  let cursor = page.cursor;
  let headerId: number | undefined;
  let buttonMessageId: number | null = null;
  let shown = 0;
  let hasMore = true;

  while (shown < page.limit && hasMore) {
    const wanted = page.limit - shown;
    const matches = await page.find(cursor, wanted + 1);
    hasMore = matches.length > wanted;
    for (const match of matches.slice(0, wanted)) {
      if (page.firstMessageId !== undefined && headerId === undefined) {
        headerId = await port.send('🔎 Ось, що мені вдалось знайти:', page.firstMessageId);
      }
      const button = hasMore && shown === page.limit - 1 ? moreButtonData(page.searchId) : undefined;
      try {
        const replyId = await replyToMatch(port, match, `${page.text} (${match.similarity.toPrecision(4)})`, button);
        if (replyId !== null) {
          shown++;
          if (button !== undefined) buttonMessageId = replyId;
        }
      } catch (e) {
        console.log(`messageId: ${match.messageId}`, e);
      }
      cursor = match;
      await port.pause();
    }
  }

  if (shown === 0 && page.firstMessageId !== undefined) {
    // Every result on the way had been deleted: take the header back as well
    if (headerId !== undefined) await port.delete(headerId);
    await port.send('🤷‍♂️ Нічого нема.', page.firstMessageId);
  } else if (!hasMore) {
    await port.send('💃 Це все!');
  }
  return { cursor, buttonMessageId };
}

/** Callback data of the "Ще" button of a stored search */
function moreButtonData(searchId: number): string {
  return `islm-${searchId}`;
}

/**
 * The search id in the callback data of a "Ще" button (`islm-<id>`), or null for
 * a button from before searches were stored, whose payload was JSON.
 */
export function parseMoreCallback(data: string): number | null {
  const match = /^islm-(\d+)$/.exec(data);
  return match ? Number(match[1]) : null;
}
