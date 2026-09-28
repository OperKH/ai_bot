import type { InputRichBlock, InputRichMessage, RichBlockTableCell, RichText } from 'grammy/types';
import { monthOfLabel, plural } from '../../crow/words';
import { getLinkChatId, messageLink } from '../telegramLinks';
import { FALLBACK_TIME_ZONE } from './timeZones';

/**
 * The chat's bayans of the month (docs/media.md#bayans): on the last day of the month, at this time of the chat's
 * zone, the chat gets who posted them and which. The month runs from the moment the previous one's statistics
 * went, so the last evening's bayans count in the next month.
 */
export const STATS_TIME = { hour: 19, minute: 42 };
/** A chat that missed its moment, the bot being down, still gets them this long after */
const STATS_GRACE_MS = 24 * 3_600_000;
const TOP_AUTHORS = 5;
/** A bayan seen twice is every bayan: the bayan of the month is one seen at least this many times */
const TOP_FROM_TIME = 3;
const MESSAGES = ['повідомлення', 'повідомлення', 'повідомлень'] as const;

export interface StatsWindow {
  /** `YYYY-MM` */
  month: string;
  /** The month as Ukrainian says it after «Баяни»: «жовтня» */
  label: string;
  from: Date;
  to: Date;
}

/** A bayan of the month as the store keeps it (`media_repeat`) */
export interface BayanRow {
  messageId: string;
  authorId: string;
  authorName: string;
  firstMessageId: string;
  previousMessageId: string;
  /** Copies the chat had before */
  copies: number;
}

export interface BayanStats {
  /** Media messages of the month, and the bayans among them */
  media: number;
  bayans: number;
  /** Those who posted most of them, the most first */
  authors: { name: string; bayans: number }[];
  /** The bayan of the month: the one the chat has seen most times, `time` being this one; from the third */
  top: { messageId: string; time: number } | null;
  /** The one that came back after the most messages since its first copy */
  oldest: { messageId: string; authorName: string; messagesSince: number } | null;
  /** The one that came after the fewest messages since the copy before */
  quickest: { messageId: string; authorName: string; messagesSince: number } | null;
}

/** The last day of a month at STATS_TIME in the zone */
function monthEnd(month: Temporal.PlainYearMonth, timeZone: string): Temporal.ZonedDateTime {
  return month.toPlainDate({ day: month.daysInMonth }).toZonedDateTime({ timeZone, plainTime: STATS_TIME });
}

/** The month whose statistics are due at `now` in the chat's zone, or null: within a day after its end */
export function dueWindow(now: Date, timeZone: string): StatsWindow | null {
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
  for (const back of [0, 1]) {
    const month = today.toPlainYearMonth().subtract({ months: back });
    const end = monthEnd(month, timeZone).epochMilliseconds;
    if (now.getTime() >= end && now.getTime() < end + STATS_GRACE_MS) {
      const from = monthEnd(month.subtract({ months: 1 }), timeZone).epochMilliseconds;
      return { month: month.toString(), label: monthOfLabel(month.month), from: new Date(from), to: new Date(end) };
    }
  }
  return null;
}

/**
 * Whether some zone's statistics can be due at `now`: a month's end at STATS_TIME and its day of grace fall between
 * the month's last day and the second day of the next in UTC, whatever the zone, so the rest of a month asks nothing
 */
export function monthMayEnd(now: Date): boolean {
  const day = now.getUTCDate();
  return day <= 2 || day === new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Message ids of a chat run in order, so their difference is the messages between */
const since = (messageId: string, earlier: string) => Number(BigInt(messageId) - BigInt(earlier));

/** The month's figures from its bayans and the count of its media */
export function summarize(rows: readonly BayanRow[], media: number): BayanStats {
  const byAuthor = new Map<string, { name: string; bayans: number }>();
  for (const row of rows) {
    const author = byAuthor.get(row.authorId) ?? { name: row.authorName, bayans: 0 };
    // The name as it was most lately: the rows come in the order they were kept
    byAuthor.set(row.authorId, { name: row.authorName, bayans: author.bayans + 1 });
  }
  const best = <T>(pick: (row: BayanRow) => T, better: (a: T, b: T) => boolean) =>
    rows.reduce<{ row: BayanRow; value: T } | null>((found, row) => {
      const value = pick(row);
      return found === null || better(value, found.value) ? { row, value } : found;
    }, null);
  const top = best((row) => row.copies, (a, b) => a >= b);
  const oldest = best((row) => since(row.messageId, row.firstMessageId), (a, b) => a > b);
  const quickest = best((row) => since(row.messageId, row.previousMessageId), (a, b) => a < b);
  return {
    // The media stored before their time was kept are not counted, so a month may count fewer than its bayans
    media: Math.max(media, rows.length),
    bayans: rows.length,
    authors: [...byAuthor.values()].sort((a, b) => b.bayans - a.bayans).slice(0, TOP_AUTHORS),
    top: top && top.value + 1 >= TOP_FROM_TIME ? { messageId: top.row.messageId, time: top.value + 1 } : null,
    oldest: oldest && { messageId: oldest.row.messageId, authorName: oldest.row.authorName, messagesSince: oldest.value },
    quickest: quickest && { messageId: quickest.row.messageId, authorName: quickest.row.authorName, messagesSince: quickest.value },
  };
}

const cell = (text: RichText, align: 'left' | 'right', is_header?: true): RichBlockTableCell => ({
  text,
  align,
  valign: 'middle',
  is_header,
});

/** A line with a link to the message it is about */
const linked = (chatId: number, text: RichText, messageId: string): InputRichBlock => ({
  type: 'paragraph',
  text: [text, ' ', { type: 'url', text: '💬', url: messageLink(chatId, messageId) }],
});

/** The month's statistics as one rich message; names go as text, so nobody is pinged */
export function bayanStatsMessage(stats: BayanStats, window: StatsWindow, chatId: number): InputRichMessage {
  const share = Math.round((stats.bayans / stats.media) * 100);
  const blocks: InputRichBlock[] = [
    { type: 'heading', text: `📊 Баяни ${window.label}`, size: 2 },
    {
      type: 'paragraph',
      text: `Медіа за місяць: ${stats.media}, з них баянів: ${stats.bayans}${share > 0 ? ` — ${share}%` : ''}.`,
    },
    { type: 'heading', text: '🏆 Баяністи місяця', size: 3 },
    {
      type: 'table',
      is_striped: true,
      cells: [
        [cell('Хто', 'left', true), cell('Баянів', 'right', true)],
        ...stats.authors.map((author) => [cell({ type: 'bold', text: author.name }, 'left'), cell(String(author.bayans), 'right')]),
      ],
    },
  ];
  if (stats.top) blocks.push(linked(chatId, `🔁 Баян місяця: чат бачить його вже ${stats.top.time}-й раз.`, stats.top.messageId));
  if (stats.oldest && stats.oldest.messagesSince > 0) {
    const { messagesSince: n, authorName, messageId } = stats.oldest;
    blocks.push(linked(chatId, ['🦖 Найдавніший: ', { type: 'bold', text: authorName }, ` — через ${n} ${plural(n, MESSAGES)} після першої появи.`], messageId));
  }
  if (stats.quickest && stats.quickest.messageId !== stats.oldest?.messageId) {
    const { messagesSince: n, authorName, messageId } = stats.quickest;
    blocks.push(linked(chatId, ['⚡ Найшвидший: ', { type: 'bold', text: authorName }, ` — лише через ${n} ${plural(n, MESSAGES)} після попереднього.`], messageId));
  }
  return { blocks };
}

/** What the monthly statistics need from the store and the chat; the command backs it, the tests a fake */
export interface BayanStatsPort {
  /** The chats with bayans since `since`, with their zone, the last month they got and since when they are watched */
  chats(since: Date): Promise<{ chatId: string; timeZone: string | null; postedMonth: string | null; trackedSince: Date | null }[]>;
  bayans(chatId: string, from: Date, to: Date): Promise<BayanRow[]>;
  mediaCount(chatId: string, from: Date, to: Date): Promise<number>;
  markPosted(chatId: string, month: string): Promise<void>;
  send(chatId: string, message: InputRichMessage): Promise<void>;
}

/** Only the chats with bayans of about the last month can be due */
const CHATS_WINDOW_MS = 40 * 24 * 3_600_000;

/**
 * Sends the statistics of every chat whose month has ended, once a month. A month without bayans goes without, and
 * so does one the bot did not watch from its start — the month it came to the chat, or was deployed in
 */
export async function postDueStats(port: BayanStatsPort, now: Date): Promise<void> {
  if (!monthMayEnd(now)) return;
  for (const chat of await port.chats(new Date(now.getTime() - CHATS_WINDOW_MS))) {
    // A chat with no zone of its own counts in UTC rather than a guess (docs/timezone.md)
    const window = dueWindow(now, chat.timeZone ?? FALLBACK_TIME_ZONE);
    if (!window || chat.postedMonth === window.month) continue;
    const watched = chat.trackedSince !== null && chat.trackedSince <= window.from;
    const rows = watched ? await port.bayans(chat.chatId, window.from, window.to) : [];
    const media = rows.length > 0 ? await port.mediaCount(chat.chatId, window.from, window.to) : 0;
    // Marked before the send: a send that failed on the network may still have been delivered, and twice is worse
    await port.markPosted(chat.chatId, window.month);
    if (!watched) console.log(`[Media] Bayan statistics of ${window.month} skipped in chat ${getLinkChatId(Number(chat.chatId))}: not watched whole`);
    if (rows.length === 0) continue;
    await port.send(chat.chatId, bayanStatsMessage(summarize(rows, media), window, Number(chat.chatId)));
    console.log(`[Media] Bayan statistics of ${window.month} sent to chat ${getLinkChatId(Number(chat.chatId))}: ${rows.length} bayans`);
  }
}
