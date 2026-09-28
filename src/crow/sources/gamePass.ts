import type { JobState } from '../jobs';
import { BOT_USER_AGENT, type FeedItem } from './feed';

const FETCH_TIMEOUT_MS = 20_000;
const CATALOG_URL = 'https://catalog.gamepass.com/sigls/v2';
const PRODUCTS_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
/** The display catalog answers for this many products a request */
const PRODUCTS_BATCH = 20;

/** A list of Game Pass the crow follows, as the catalog names it (`siglId`) */
export interface GamePassList {
  id: string;
  /** What the list is: the games that came, or those about to go */
  kind: 'added' | 'leaving';
}

export const GAME_PASS_ADDED: GamePassList = { id: 'f13cf6b4-57e6-4459-89df-6aec18cf0538', kind: 'added' };
export const GAME_PASS_LEAVING: GamePassList = { id: '393f05bf-e596-4ef6-9487-6d4fa0eab987', kind: 'leaving' };

/** The products of a list, in its order: its first element describes the list itself */
export function parseGamePassList(json: string): string[] {
  return (JSON.parse(json) as { id?: string }[]).flatMap((entry) => (entry.id ? [entry.id] : []));
}

interface CatalogProduct {
  ProductId: string;
  LocalizedProperties: { ProductTitle: string; Images?: { ImagePurpose: string; Uri: string }[] }[];
}

/** The titles and pictures of the products, from Microsoft's display catalog */
export function parseCatalogProducts(json: string): { id: string; title: string; image: string | null }[] {
  return (JSON.parse(json) as { Products?: CatalogProduct[] }).Products?.map((product) => {
    const properties = product.LocalizedProperties[0];
    const art = properties?.Images?.find((image) => image.ImagePurpose === 'SuperHeroArt') ?? properties?.Images?.[0];
    return {
      id: product.ProductId,
      title: (properties?.ProductTitle ?? product.ProductId).replace(/[™®]/g, '').trim(),
      image: art ? `https:${art.Uri.replace(/^https?:/, '')}` : null,
    };
  }) ?? [];
}

async function getJson(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': BOT_USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

/** The games that are new to a list since the list the state remembers, as one entry: they came, or go, together */
export function gamePassEntry(
  list: GamePassList,
  games: readonly { id: string; title: string; image: string | null }[],
): FeedItem | null {
  if (games.length === 0) return null;
  const names = games.map((game) => game.title);
  const ids = games.map((game) => game.id).sort();
  return {
    key: `gamepass-${list.kind}:${ids.join(',')}`,
    title:
      list.kind === 'added'
        ? `Added to Xbox Game Pass: ${names.join(', ')}`
        : `Leaving Xbox Game Pass soon: ${names.join(', ')}`,
    url: 'https://www.xbox.com/en-US/xbox-game-pass/games',
    summary:
      list.kind === 'added'
        ? `Recently added to the Xbox Game Pass catalog: ${names.join('; ')}.`
        : `Leaving the Xbox Game Pass catalog soon: ${names.join('; ')}.`,
    publishedAt: null,
    imageUrl: games[0].image,
    games: games.map((game) => ({ title: game.title, platforms: '', image: game.image })),
  };
}

/**
 * A list of Game Pass as a source: the games new on it since the last poll, with their titles from the display
 * catalog, make one entry. The list is kept in the job's state, so a game that stays on it is news once.
 */
export function gamePassSource(list: GamePassList) {
  return async (state: JobState): Promise<{ items: FeedItem[]; state: JobState }> => {
    const ids = parseGamePassList(await getJson(`${CATALOG_URL}?id=${list.id}&language=en-us&market=US`));
    const known = new Set((state.ids ?? []) as string[]);
    const fresh = ids.filter((id) => !known.has(id));
    const games: { id: string; title: string; image: string | null }[] = [];
    for (let i = 0; i < fresh.length; i += PRODUCTS_BATCH) {
      const batch = fresh.slice(i, i + PRODUCTS_BATCH);
      games.push(
        ...parseCatalogProducts(await getJson(`${PRODUCTS_URL}?bigIds=${batch.join(',')}&market=US&languages=en-us`)),
      );
    }
    const entry = gamePassEntry(list, games);
    return { items: entry ? [entry] : [], state: { ...state, ids } };
  };
}
