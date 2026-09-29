import { createHash } from 'node:crypto';
import { parseXml, XmlElement } from '@rgrove/parse-xml';
import { clip } from '../words';

/** How the bot introduces itself to the sources it polls */
export const BOT_USER_AGENT = 'SightScribeBot/1.3 (+https://github.com/OperKH/ai_bot)';

/** For pages that turn away anything that does not look like a browser */
export const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const FETCH_TIMEOUT_MS = 20_000;
/** What an entry's summary is cut to: enough for sorting and facts, small for the database */
export const SUMMARY_MAX = 6000;

/**
 * A moment an entry's news is about, as a store or a platform's own list states it: when its games come, or when
 * they go. The crow reminds the chats of it (docs/crow/behavior.md#game-news)
 */
export interface ItemDeadline {
  kind: 'available' | 'ends';
  /** ISO */
  at: string;
  /** When the chats hear the reminder: as the games come, or some time before they go */
  remindAt: string;
}

/** A game of a store's or a platform's list: the crow shows every one, with its picture */
export interface GameListing {
  title: string;
  /** «PS5, PS4»; empty when the list does not say */
  platforms: string;
  /** A web address of its picture, as Telegram fetches it */
  image: string | null;
  /** Its page in the store, where a giveaway is taken */
  url?: string | null;
  /** A giveaway's price before it and now, «459 ₴» and «0 ₴»; none for a game that is free anyway */
  price?: { was: string; now: string } | null;
}

/** An entry of a feed or a sitemap */
export interface FeedItem {
  /** The guid, or the link when there is none */
  key: string;
  title: string;
  url: string | null;
  /** Plain text */
  summary: string;
  publishedAt: Date | null;
  imageUrl: string | null;
  deadline?: ItemDeadline;
  /** The games of a list the entry is — PS Plus's month, the games leaving it, a week's giveaway */
  games?: GameListing[];
}

/** What makes the next request conditional */
export interface ConditionalState {
  etag?: string;
  lastModified?: string;
}

export type FetchResult = { notModified: true } | { notModified: false; body: string; state: ConditionalState };

/** Reddit answers an anonymous client about once a minute: after a request, `remaining 0` until the minute ends */
const REDDIT_GAP_MS = 61_000;
let redditTurn: Promise<void> = Promise.resolve();
let lastRedditAt = 0;

/** Waits for Reddit's turn: its requests go one at a time, a minute apart, whichever source makes them */
function paced(url: string): Promise<void> {
  if (!/(^|\.)reddit\.com$/i.test(new URL(url).hostname)) return Promise.resolve();
  const turn = redditTurn.then(async () => {
    const wait = lastRedditAt + REDDIT_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRedditAt = Date.now();
  });
  redditTurn = turn;
  return turn;
}

/**
 * GETs a source, conditionally when it gave an ETag or Last-Modified before.
 * Anything but 200 and 304 is an error.
 */
export async function fetchText(
  url: string,
  state: ConditionalState = {},
  headers: Record<string, string> = { 'user-agent': BOT_USER_AGENT },
): Promise<FetchResult> {
  await paced(url);
  const response = await fetch(url, {
    headers: {
      ...headers,
      ...(state.etag ? { 'if-none-match': state.etag } : {}),
      ...(state.lastModified ? { 'if-modified-since': state.lastModified } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return {
    notModified: false,
    body: await response.text(),
    state: {
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
    },
  };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** HTML as plain text: no tags, scripts or styles, entities decoded, whitespace collapsed */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** What a story reads of a page: its article, or its main part */
const PAGE_TEXT_MAX = 8000;

/** The text and the picture of a page, if the site lets the bot read it; a failure is logged and gives none */
export async function readPage(url: string): Promise<{ text: string; image: string | null } | null> {
  try {
    const page = await fetchText(url, {}, BROWSER_HEADERS);
    if (page.notModified) return null;
    const html = page.body;
    const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
    return { text: clip(htmlToText(main), PAGE_TEXT_MAX), image: metaContent(html, 'og:image') };
  } catch (e) {
    console.warn(`[Crow] Could not read ${url}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** The `content` of a `<meta property|name="…">` of a page, such as `og:image` */
export function metaContent(html: string, property: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== property.toLowerCase()) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return htmlToText(content);
  }
  return null;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function children(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child instanceof XmlElement && child.name === name);
}

function child(element: XmlElement, ...names: string[]): XmlElement | undefined {
  for (const name of names) {
    const found = children(element, name)[0];
    if (found) return found;
  }
  return undefined;
}

function text(element: XmlElement | undefined): string {
  return element?.text.trim() ?? '';
}

function date(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function summaryOf(html: string): string {
  return clip(htmlToText(html), SUMMARY_MAX);
}

function rssItem(item: XmlElement): FeedItem | null {
  const url = text(child(item, 'link')) || null;
  const key = text(child(item, 'guid')) || url;
  if (!key) return null;
  const image =
    child(item, 'media:content', 'media:thumbnail')?.attributes.url ??
    children(item, 'enclosure').find((e) => e.attributes.type?.startsWith('image/'))?.attributes.url ??
    null;
  return {
    key,
    title: htmlToText(text(child(item, 'title'))),
    url,
    summary: summaryOf(text(child(item, 'content:encoded', 'description'))),
    publishedAt: date(text(child(item, 'pubDate', 'dc:date'))),
    imageUrl: image,
  };
}

function atomEntry(entry: XmlElement): FeedItem | null {
  const links = children(entry, 'link');
  const url = (links.find((l) => (l.attributes.rel ?? 'alternate') === 'alternate') ?? links[0])?.attributes.href ?? null;
  const key = text(child(entry, 'id')) || url;
  if (!key) return null;
  return {
    key,
    title: htmlToText(text(child(entry, 'title'))),
    url,
    summary: summaryOf(text(child(entry, 'content', 'summary'))),
    publishedAt: date(text(child(entry, 'published', 'updated'))),
    imageUrl: child(entry, 'media:thumbnail', 'media:content')?.attributes.url ?? null,
  };
}

/** The HTML of each entry of an RSS feed, by its key as `parseFeed` gives it: what a source reads beyond its text */
export function rssContents(xml: string): Map<string, string> {
  const channel = child(parseXml(xml).root ?? new XmlElement('rss'), 'channel');
  const contents = new Map<string, string>();
  for (const item of channel ? children(channel, 'item') : []) {
    const key = text(child(item, 'guid')) || text(child(item, 'link'));
    if (key) contents.set(key, text(child(item, 'content:encoded', 'description')));
  }
  return contents;
}

/** The entries of an RSS 2.0 or Atom feed, in the feed's order */
export function parseFeed(xml: string): FeedItem[] {
  const root = parseXml(xml).root;
  if (!root) return [];
  if (root.name === 'feed') return children(root, 'entry').map(atomEntry).filter((item) => item !== null);
  const channel = child(root, 'channel');
  if (!channel) return [];
  return children(channel, 'item').map(rssItem).filter((item) => item !== null);
}

/**
 * The pages of a sitemap as entries: a new URL is the news. The title is the
 * last part of the path, which the sorting model reads well enough
 * (`/claude-opus-5-5` → «claude opus 5 5»).
 */
export function parseSitemap(xml: string): FeedItem[] {
  const root = parseXml(xml).root;
  if (!root) return [];
  return children(root, 'url').flatMap((entry) => {
    const url = text(child(entry, 'loc'));
    if (!url) return [];
    const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
    return [
      {
        key: url,
        title: slug.replace(/[-_]+/g, ' '),
        url,
        summary: '',
        publishedAt: date(text(child(entry, 'lastmod'))),
        imageUrl: null,
      },
    ];
  });
}
