import type { FeedItem, GameListing } from './feed';

const HOUR = 3_600_000;
/** The last day of a giveaway: the chats hear of it this long before it ends */
export const GIVEAWAY_REMINDER_MS = 24 * HOUR;
/** A giveaway worth less than this, in dollars, is no news: the stores give away small games every day */
export const GIVEAWAY_MIN_WORTH = 10;

interface EpicOffer {
  startDate: string;
  endDate: string;
  discountSetting?: { discountPercentage?: number };
}

interface EpicElement {
  title: string;
  productSlug?: string | null;
  urlSlug?: string | null;
  catalogNs?: { mappings?: { pageSlug: string; pageType?: string }[] | null } | null;
  offerMappings?: { pageSlug: string; pageType?: string }[] | null;
  keyImages?: { type: string; url: string }[];
  price?: {
    totalPrice?: { originalPrice?: number; discountPrice?: number; currencyCode?: string; fmtPrice?: { originalPrice?: string } };
  };
  promotions?: {
    promotionalOffers?: { promotionalOffers: EpicOffer[] }[];
    upcomingPromotionalOffers?: { promotionalOffers: EpicOffer[] }[];
  } | null;
}

/** The game's free offer among the offers of a promotion: its price cut to nothing */
const freeOffer = (offers: { promotionalOffers: EpicOffer[] }[] | undefined): EpicOffer | undefined =>
  offers?.flatMap((group) => group.promotionalOffers).find((offer) => offer.discountSetting?.discountPercentage === 0);

/** The game's page in the store, from its mappings: the product slug is empty for most games */
function epicPage(element: EpicElement): string | null {
  const slug =
    element.catalogNs?.mappings?.find((m) => m.pageType === 'productHome')?.pageSlug ??
    element.catalogNs?.mappings?.[0]?.pageSlug ??
    element.offerMappings?.[0]?.pageSlug ??
    element.productSlug?.replace(/\/home$/, '') ??
    null;
  return slug ? `https://store.epicgames.com/en-US/p/${slug}` : null;
}

/** A price of the store's, in its minor units, as the chat reads it: «459 ₴», «249.50 ₴» */
function storePrice(minor: number, currency: string): string {
  const amount = minor / 100;
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency === 'UAH' ? `${shown} ₴` : `${shown} ${currency}`;
}

/** What a game of the giveaway cost and costs now; none for a game that is free anyway */
function epicPrice(element: EpicElement): GameListing['price'] {
  const total = element.price?.totalPrice;
  if (!total?.originalPrice || total.currencyCode === undefined) return null;
  return { was: storePrice(total.originalPrice, total.currencyCode), now: storePrice(total.discountPrice ?? 0, total.currencyCode) };
}

const utcLabel = (iso: string) => new Date(iso).toUTCString().replace(':00 GMT', ' UTC');

/**
 * The Epic Games Store's free games (its `freeGamesPromotions`, for the Ukrainian store): one entry for the
 * week's giveaway, whichever games it holds, with the next week's games in its text — the crow tells both. The
 * key is the week's start, so the next giveaway is new news. The prices are the Ukrainian store's.
 */
export function parseEpicFreeGames(json: string): FeedItem[] {
  const elements = (JSON.parse(json) as { data: { Catalog: { searchStore: { elements: EpicElement[] } } } }).data.Catalog
    .searchStore.elements;
  const now = elements
    .map((element) => ({ element, offer: freeOffer(element.promotions?.promotionalOffers) }))
    .filter((game): game is { element: EpicElement; offer: EpicOffer } => game.offer !== undefined);
  if (now.length === 0) return [];
  const next = elements
    .map((element) => ({ element, offer: freeOffer(element.promotions?.upcomingPromotionalOffers) }))
    .filter((game): game is { element: EpicElement; offer: EpicOffer } => game.offer !== undefined);
  const { startDate, endDate } = now[0].offer;
  const price = (element: EpicElement) => element.price?.totalPrice?.fmtPrice?.originalPrice;
  const names = now.map(({ element }) => element.title);
  const summary = [
    `Free to keep on the Epic Games Store until ${utcLabel(endDate)}: ` +
      now.map(({ element }) => (price(element) ? `${element.title} (usually ${price(element)})` : element.title)).join(', ') +
      '.',
    next.length > 0 ? `Next free games, from ${utcLabel(next[0].offer.startDate)}: ${next.map(({ element }) => element.title).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const wide = (element: EpicElement) => element.keyImages?.find((image) => image.type === 'OfferImageWide')?.url ?? null;
  const image = wide(now[0].element);
  return [
    {
      key: `epic:${startDate}`,
      title: `Epic Games Store gives away ${names.join(' and ')}`,
      url: now.length === 1 ? epicPage(now[0].element) : 'https://store.epicgames.com/en-US/free-games',
      summary,
      publishedAt: new Date(startDate),
      imageUrl: image,
      games: now.map(({ element }) => ({
        title: element.title,
        platforms: 'PC',
        image: wide(element),
        url: epicPage(element),
        price: epicPrice(element),
      })),
      deadline: {
        kind: 'ends',
        at: new Date(endDate).toISOString(),
        remindAt: new Date(new Date(endDate).getTime() - GIVEAWAY_REMINDER_MS).toISOString(),
      },
    },
  ];
}

interface GamerPowerGiveaway {
  id: number;
  title: string;
  worth: string;
  image?: string;
  description?: string;
  platforms: string;
  end_date: string;
  published_date: string;
  type: string;
  status: string;
  gamerpower_url: string;
  /** GamerPower's way to the giveaway in its store */
  open_giveaway_url?: string;
}

/** The stores whose giveaways the chat can take: Epic has its own source, and itch.io, IndieGala or phones are not the chat's */
const GIVEAWAY_STORES = /\b(Steam|GOG|Ubisoft Connect|EA (Origin|App)|Battle\.net|Xbox|PS[45]|Playstation|Nintendo Switch)\b/i;

/** A date of GamerPower's, «2026-10-01 23:59:00», as a moment: its times are UTC */
const gamerPowerDate = (value: string): Date | null => {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * GamerPower's giveaways of games (`api/giveaways?type=game`): the free games of the stores the chat uses, worth
 * at least ten dollars. A limited key giveaway runs out before the chat hears of it, so it is left out. The link
 * is GamerPower's page, the attribution its terms ask for.
 */
export function parseGamerPowerGiveaways(json: string): FeedItem[] {
  return (JSON.parse(json) as GamerPowerGiveaway[]).flatMap((giveaway) => {
    const worth = Number(giveaway.worth.replace(/[^\d.]/g, ''));
    if (giveaway.type !== 'Game' || giveaway.status !== 'Active' || /\bkey giveaway\b/i.test(giveaway.title)) return [];
    if (!GIVEAWAY_STORES.test(giveaway.platforms) || /Epic Games/i.test(giveaway.platforms)) return [];
    if (!(worth >= GIVEAWAY_MIN_WORTH)) return [];
    const ends = giveaway.end_date === 'N/A' ? null : gamerPowerDate(giveaway.end_date);
    return [
      {
        key: `gamerpower:${giveaway.id}`,
        title: giveaway.title.replace(/\s+Giveaway$/i, ''),
        url: giveaway.gamerpower_url,
        summary: [
          giveaway.description ?? '',
          `Worth ${giveaway.worth}, on ${giveaway.platforms}.`,
          ends ? `Until ${ends.toUTCString().replace(':00 GMT', ' UTC')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        publishedAt: gamerPowerDate(giveaway.published_date),
        imageUrl: giveaway.image ?? null,
        games: [
          {
            title: giveaway.title.replace(/\s+Giveaway$/i, '').replace(/\s+\([^)]*\)$/, ''),
            platforms: giveaway.platforms,
            image: giveaway.image ?? null,
            url: giveaway.open_giveaway_url ?? giveaway.gamerpower_url,
            price: { was: giveaway.worth, now: '$0' },
          },
        ],
        ...(ends
          ? {
              deadline: {
                kind: 'ends' as const,
                at: ends.toISOString(),
                remindAt: new Date(ends.getTime() - GIVEAWAY_REMINDER_MS).toISOString(),
              },
            }
          : {}),
      },
    ];
  });
}
