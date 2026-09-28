import { fetchText } from './feed';

/** Nintendo of Europe's store search, which its own site uses: the games of a span of days, with their systems */
const SEARCH_URL = 'https://searching.nintendo-europe.com/en/select';
/** A busy week has some sixty games; this is only a bound */
const RELEASES_READ = 200;
/** The fields read of a game: the rest of its hundred make the answer 17 times the size */
const FIELDS = 'title,system_names_txt,dates_released_dts,publisher,downloads_rank_i';
/** The store's downloads rank of a game nobody has bought yet */
const UNRANKED = 999_999;

/** A game of the store's week, once for all its systems */
export interface NintendoRelease {
  title: string;
  /** `Switch 2`, `Switch` */
  systems: string[];
  /** `YYYY-MM-DD`, the European one */
  date: string;
  publisher: string | null;
  /** The store's rank by downloads and pre-orders, 1 the most; null — none yet */
  rank: number | null;
}

interface SearchDoc {
  title?: string;
  system_names_txt?: string[];
  dates_released_dts?: string[];
  publisher?: string;
  downloads_rank_i?: number;
}

/** A game's name as one source or another may spell it: any case, no marks, dashes or colons */
export const gameKey = (title: string): string =>
  title.toLowerCase().replace(/[™®]/g, '').replace(/[\s:–—-]+/g, ' ').trim();

/** The games of a search answer, one per title: its Switch and Switch 2 versions are one game */
export function parseNintendoReleases(json: string): NintendoRelease[] {
  const docs = (JSON.parse(json) as { response?: { docs?: SearchDoc[] } }).response?.docs ?? [];
  const games = new Map<string, NintendoRelease>();
  for (const doc of docs) {
    const date = doc.dates_released_dts?.[0]?.slice(0, 10);
    if (!doc.title || !date) continue;
    const title = doc.title.replace(/[™®]/g, '').replace(/\s+/g, ' ').trim();
    const rank = doc.downloads_rank_i && doc.downloads_rank_i < UNRANKED ? doc.downloads_rank_i : null;
    const game = games.get(gameKey(title)) ?? { title, systems: [], date, publisher: doc.publisher?.trim() || null, rank: null };
    game.systems = [...new Set([...game.systems, ...(doc.system_names_txt ?? []).map((system) => system.replace(/^Nintendo /, ''))])];
    if (date < game.date) game.date = date;
    if (rank !== null && (game.rank === null || rank < game.rank)) game.rank = rank;
    games.set(gameKey(title), game);
  }
  return [...games.values()];
}

/** The Switch and Switch 2 games released in Europe between two days, both included */
export async function nintendoReleases(from: Temporal.PlainDate, to: Temporal.PlainDate): Promise<NintendoRelease[]> {
  const params = new URLSearchParams({
    q: '*',
    fq: `type:GAME AND dates_released_dts:[${from.toString()}T00:00:00Z TO ${to.toString()}T23:59:59Z]`,
    fl: FIELDS,
    sort: 'dates_released_dts asc',
    rows: String(RELEASES_READ),
    wt: 'json',
  });
  // Asked without an ETag, it never answers «not modified»
  const fetched = await fetchText(`${SEARCH_URL}?${params}`);
  return fetched.notModified ? [] : parseNintendoReleases(fetched.body);
}
