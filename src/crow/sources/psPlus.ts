import type { JobState } from '../jobs';
import { BROWSER_HEADERS, type FeedItem, type GameListing, htmlToText, HttpError, type ItemDeadline, parseFeed, rssContents } from './feed';
import { fetchQueryHash } from './psStoreHash';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FETCH_TIMEOUT_MS = 30_000;
/** The store asks for a request a second at most */
const STORE_PAUSE_MS = 1100;
/** The last days before games leave the catalog: the chats are reminded this long before */
export const LEAVING_REMINDER_MS = 3 * DAY;
/**
 * The games of a month come at the rotation, 08:00 UTC in the Ukrainian store (seen in summer; winter is not
 * checked); the chats hear «вже можна забирати» a little after it, to be safe
 */
const ROTATION_UTC_HOUR = 8;
const ARRIVAL_REMINDER_UTC_HOUR = 10;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** The `nth` Tuesday of a month, at an hour of UTC */
function nthTuesday(year: number, month: number, nth: number, hour: number): Date {
  const first = new Date(Date.UTC(year, month, 1, hour));
  const offset = (2 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + 7 * (nth - 1), hour));
}

/**
 * When the games of a PS Plus announcement come to the Ukrainian store: the monthly games of Essential on the
 * first Tuesday of the month, the catalog of Extra and Deluxe on the third (concept, section 7.2.1). The year is
 * the post's, or the next one for January announced in December.
 */
export function psPlusArrival(title: string, publishedAt: Date | null): ItemDeadline | undefined {
  const match = /^PlayStation Plus (Monthly Games|Game Catalog) for ([A-Za-z]+)/i.exec(title);
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  if (!match || month < 0) return undefined;
  const posted = publishedAt ?? new Date();
  const year = posted.getUTCFullYear() + (month < posted.getUTCMonth() - 6 ? 1 : 0);
  const nth = /monthly/i.test(match[1]) ? 1 : 3;
  const at = nthTuesday(year, month, nth, ROTATION_UTC_HOUR);
  return { kind: 'available', at: at.toISOString(), remindAt: nthTuesday(year, month, nth, ARRIVAL_REMINDER_UTC_HOUR).toISOString() };
}

/** A picture of the blog in the size a gallery shows: its image service resizes on the fly */
const blogImage = (url: string) => `${url.replace(/\?.*$/, '')}?fit=1280%2C1280`;

/**
 * The games of a PS Plus announcement of the blog, all of them, each with its picture: a post shows a game's picture,
 * then «**Name | PS5, PS4**», then what it is
 */
export function psPlusGames(html: string): GameListing[] {
  const games: GameListing[] = [];
  let picture: string | null = null;
  // A game's line names its platforms; the section headings, «PlayStation Plus Extra and Premium | Game Catalog», do not
  for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"|<strong\b[^>]*>([^<|]+?)\s*\|\s*(PS[^<]*?)\s*<\/strong>/g)) {
    if (match[1]) {
      picture = match[1];
      continue;
    }
    games.push({ title: htmlToText(match[2]), platforms: htmlToText(match[3]), image: picture ? blogImage(picture) : null });
    picture = null;
  }
  return games;
}

/**
 * The PlayStation Blog's feed: every post whole, and for the announcements of PS Plus — the monthly games and
 * the catalog — the day their games come, which the crow reminds the chats of, and every game with its picture.
 * The posts «(For Southeast Asia)» repeat others for a region the chat is not in.
 */
export function parsePlayStationBlog(xml: string): FeedItem[] {
  const contents = rssContents(xml);
  return parseFeed(xml)
    .filter((item) => !/^\(For Southeast Asia\)/i.test(item.title))
    .map((item) => {
      const deadline = psPlusArrival(item.title, item.publishedAt);
      if (!deadline) return item;
      const games = psPlusGames(contents.get(item.key) ?? '');
      return { ...item, deadline, ...(games.length > 0 ? { games } : {}) };
    });
}

// The games leaving the catalog: the «Last Chance to Play» category of the Ukrainian PS Store

const GRAPHQL_URL = 'https://web.np.playstation.com/api/graphql/v1/op';
/** «Last Chance to Play» of the Ukrainian store (SIEE): its list differs from the American one */
export const LAST_CHANCE_CATEGORY = '1b3a7ad1-d106-4316-8917-0d4d0c14da42';
const LAST_CHANCE_URL = `https://store.playstation.com/uk-ua/category/${LAST_CHANCE_CATEGORY}/1`;
interface StoreProduct {
  id: string;
  name: string;
  platforms?: string[];
  media?: { role: string; type: string; url: string }[];
}

/** The picture of a product for a gallery: its wide art first, resized by the store's image service */
const PICTURE_ROLES = ['BACKGROUND', 'FOUR_BY_THREE_BANNER', 'GAMEHUB_COVER_ART', 'MASTER', 'EDITION_KEY_ART'];
function productImage(product: StoreProduct): string | null {
  const images = (product.media ?? []).filter((media) => media.type === 'IMAGE');
  const picture = PICTURE_ROLES.map((role) => images.find((media) => media.role === role)).find(Boolean) ?? images[0];
  return picture ? `${picture.url.replace(/\?.*$/, '')}?w=1280` : null;
}

/** The store's answer to a hash it does not keep, rather than a failure of the request */
const isUnknownQuery = (status: number, body: string) =>
  /PersistedQueryNotFound|not whitelisted/i.test(body) && (status === 400 || status === 200);

/**
 * The products of the Ukrainian «Last Chance to Play» by a hash of the store's query, or `unknown-query` when the
 * store does not take the hash (any more)
 */
export async function lastChanceProducts(hash: string): Promise<StoreProduct[] | 'unknown-query'> {
  const params = new URLSearchParams({
    operationName: 'categoryGridRetrieve',
    variables: JSON.stringify({ id: LAST_CHANCE_CATEGORY, pageArgs: { size: 48, offset: 0 } }),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });
  const response = await fetch(`${GRAPHQL_URL}?${params}`, {
    headers: {
      ...BROWSER_HEADERS,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-psn-store-locale-override': 'uk-UA',
      origin: 'https://store.playstation.com',
      referer: 'https://store.playstation.com/',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await response.text();
  if (isUnknownQuery(response.status, body)) return 'unknown-query';
  if (!response.ok) throw new HttpError(response.status, "from the PS Store's GraphQL");
  const grid = (JSON.parse(body) as { data?: { categoryGridRetrieve?: { products?: StoreProduct[] } } }).data?.categoryGridRetrieve;
  if (!grid) throw new Error(`The PS Store's GraphQL gave no grid: ${body.slice(0, 200)}`);
  return grid.products ?? [];
}

/** When a product leaves PS Plus, from its page in the Ukrainian store: the `endTime` of its PS Plus price; null — not found */
export function leavingTime(html: string): Date | null {
  const match = /"serviceBranding":\["PS_PLUS"\],"endTime":"(\d{12,})"/.exec(html);
  return match ? new Date(Number(match[1])) : null;
}

async function productLeavingTime(productId: string): Promise<Date | null> {
  const response = await fetch(`https://store.playstation.com/uk-ua/product/${encodeURIComponent(productId)}`, {
    headers: { ...BROWSER_HEADERS, 'accept-language': 'uk-UA,uk;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status, `for the PS Store's page of ${productId}`);
  return leavingTime(await response.text());
}

const monthDay = (date: Date) => `${MONTHS[date.getUTCMonth()][0].toUpperCase()}${MONTHS[date.getUTCMonth()].slice(1)} ${date.getUTCDate()}`;

/**
 * The games leaving the catalog as entries: one a day they leave on, since the crow tells of them together.
 * The two editions of a game — PS4 and PS5 are two products — are one line. A game whose day is unknown waits.
 */
export function leavingEntries(products: readonly StoreProduct[], ends: Readonly<Record<string, number | null>>): FeedItem[] {
  const days = new Map<string, { at: Date; games: Map<string, { platforms: Set<string>; image: string | null }> }>();
  for (const product of products) {
    const end = ends[product.id];
    if (!end) continue;
    const at = new Date(end);
    const day = at.toISOString().slice(0, 10);
    const entry = days.get(day) ?? { at, games: new Map() };
    const name = product.name.replace(/\s+PS4\s*&\s*PS5$/i, '').trim();
    const game = entry.games.get(name) ?? { platforms: new Set<string>(), image: productImage(product) };
    for (const platform of product.platforms ?? []) game.platforms.add(platform);
    entry.games.set(name, game);
    days.set(day, entry);
  }
  return [...days.entries()].map(([day, { at, games }]) => ({
    key: `ps-plus-leaving:${day}`,
    title: `${games.size} games leave PlayStation Plus Extra and Deluxe on ${monthDay(at)}`,
    url: LAST_CHANCE_URL,
    summary:
      `Leaving the PlayStation Plus Game Catalog (Extra and Deluxe) of the Ukrainian PlayStation Store on ${monthDay(at)}, ` +
      `${at.getUTCFullYear()}: ` +
      [...games].map(([name, { platforms }]) => (platforms.size > 0 ? `${name} (${[...platforms].sort().join(', ')})` : name)).join('; ') +
      '.',
    publishedAt: null,
    imageUrl: null,
    games: [...games].map(([title, { platforms, image }]) => ({ title, platforms: [...platforms].sort().join(', '), image })),
    deadline: { kind: 'ends', at: at.toISOString(), remindAt: new Date(at.getTime() - LEAVING_REMINDER_MS).toISOString() },
  }));
}

/**
 * The source of the games leaving PS Plus: the list of the Ukrainian store, and for a game new on it the moment
 * it leaves, from its page — a request a second. The job's state keeps the moments, so a page is read once, and
 * the hash of the store's query: the first poll, and a poll the store no longer takes the hash on, finds the
 * current one in the store's bundles (`psStoreHash.ts`).
 */
export async function fetchLastChance(
  state: JobState,
  pauseMs = STORE_PAUSE_MS,
  findHash: () => Promise<string> = () => fetchQueryHash(LAST_CHANCE_URL, 'categoryGridRetrieve'),
): Promise<{ items: FeedItem[]; state: JobState }> {
  let hash = typeof state.hash === 'string' ? state.hash : null;
  let products = hash ? await lastChanceProducts(hash) : 'unknown-query';
  if (products === 'unknown-query') {
    hash = await findHash();
    console.log(`[Crow] The PS Store's query categoryGridRetrieve has the hash ${hash.slice(0, 8)}… now`);
    products = await lastChanceProducts(hash);
    if (products === 'unknown-query') throw new Error(`The PS Store takes not even the hash of its own bundles, ${hash.slice(0, 8)}…`);
  }
  const known = (state.ends ?? {}) as Record<string, number | null>;
  const ends: Record<string, number | null> = {};
  for (const product of products) {
    if (product.id in known && known[product.id] !== null) {
      ends[product.id] = known[product.id];
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    ends[product.id] = (await productLeavingTime(product.id))?.getTime() ?? null;
  }
  return { items: leavingEntries(products, ends), state: { ...state, ends, hash } };
}
