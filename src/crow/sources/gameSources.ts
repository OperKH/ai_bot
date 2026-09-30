import { type CategoryId, GTA6_RELEASE } from '../categories';
import type { FeedItem } from './feed';
import { parseEpicFreeGames, parseGamerPowerGiveaways } from './freebies';
import { GAME_PASS_ADDED, GAME_PASS_LEAVING, gamePassSource } from './gamePass';
import { fetchLastChance, parsePlayStationBlog } from './psPlus';
import type { SourceDefinition } from './source';

const MINUTE = 60_000;

/** The game categories; a source of the whole press brings news of any of them */
const GAMES: CategoryId[] = ['playstation', 'nintendo', 'xbox', 'pc', 'freebies', 'gta6', 'releases', 'hacking'];

/** A Steam app's news feed: the store's own word on its sales and fests, and on Valve's hardware and games */
const steamNews = (id: string, name: string, appId: number, categories: CategoryId[]): SourceDefinition => ({
  id,
  name,
  url: `https://store.steampowered.com/feeds/news/app/${appId}/`,
  kind: 'feed',
  intervalMs: 60 * MINUTE,
  official: 'valve',
  categories,
  // A client update is a bug fix, not news
  accept: (item) => !/^Steam Client (Update|Beta)/i.test(item.title),
});

/**
 * The columns of Hookshot's sites that are never news — reviews, features, polls, «What Are You Playing» —
 * dropped before the sorting, which would only spend money on them. A guide to the week's releases stays: it is
 * the release radar's
 */
const HOOKSHOT_NOT_NEWS =
  /^(Review|Mini Review|Hardware Review|Feature|Poll|Talking Point|Soapbox|Video|Interview|Anniversary|Box Art Brawl|Countdown|Random|Gallery|Preview|Hands On|Round Up|Weekly|Reminder|Best|Deals?|ICYMI)\b/i;
const hookshotNews = (item: FeedItem) => !HOOKSHOT_NOT_NEWS.test(item.title) && (!/^Guide:/i.test(item.title) || /this week|next week/i.test(item.title));

/** Guides, podcasts and «where to find» of the press: never news */
const PRESS_NOT_NEWS = /\b(guide|walkthrough|location|how to (get|find|unlock|beat)|best .+ (games|builds|settings)|podcast|wordle|connections hint)\b/i;
const pressNews = (item: FeedItem) => !PRESS_NOT_NEWS.test(item.title);

/** Hookshot Media's four sites are one publisher; so are IGN, Eurogamer and Rock Paper Shotgun, and Future's sites */
const HOOKSHOT = 'Hookshot Media';
const IGN_GROUP = 'IGN Entertainment';

const press = (id: string, name: string, url: string, publisher?: string, accept = pressNews): SourceDefinition => ({
  id,
  name,
  url,
  kind: 'feed',
  intervalMs: 15 * MINUTE,
  ...(publisher ? { publisher } : {}),
  categories: GAMES,
  accept,
});

/**
 * The sources of the game news (docs/crow/pipeline.md#sources): the press, whose publishers are counted to tell
 * big news from small, the platforms' own channels, and the stores' lists of free games and of the games that
 * leave PS Plus. A game story is gathered from all of them by meaning.
 */
export const GAME_SOURCES: readonly SourceDefinition[] = [
  { ...press('vgc', 'VGC', 'https://www.videogameschronicle.com/feed/'), intervalMs: 10 * MINUTE },
  {
    ...press('push-square', 'Push Square', 'https://www.pushsquare.com/feeds/latest', HOOKSHOT, hookshotNews),
    intervalMs: 10 * MINUTE,
    categories: ['playstation', 'freebies', 'gta6', 'releases', 'hacking'],
  },
  {
    ...press('nintendo-life', 'Nintendo Life', 'https://www.nintendolife.com/feeds/latest', HOOKSHOT, hookshotNews),
    intervalMs: 10 * MINUTE,
    categories: ['nintendo', 'freebies', 'releases', 'hacking'],
  },
  {
    ...press('pure-xbox', 'Pure Xbox', 'https://www.purexbox.com/feeds/latest', HOOKSHOT, hookshotNews),
    intervalMs: 10 * MINUTE,
    categories: ['xbox', 'pc', 'freebies', 'gta6', 'releases'],
  },
  {
    ...press('time-extension', 'Time Extension', 'https://www.timeextension.com/feeds/latest', HOOKSHOT, hookshotNews),
    categories: ['hacking', 'releases'],
  },
  { ...press('pc-gamer', 'PC Gamer', 'https://www.pcgamer.com/feeds.xml', 'Future'), categories: ['pc', 'freebies', 'gta6', 'releases', 'hacking'] },
  {
    ...press('rock-paper-shotgun', 'Rock Paper Shotgun', 'https://www.rockpapershotgun.com/feed/news', IGN_GROUP),
    categories: ['pc', 'freebies', 'releases'],
  },
  { ...press('gbatemp', 'GBAtemp', 'https://rss-index.gbatemp.net/official.rss'), intervalMs: 30 * MINUTE, categories: ['hacking', 'nintendo'] },
  {
    // The leaks and rumors of the day, and its hype: the magpie's news for every category, Reddit's one publisher
    id: 'reddit-gaming-leaks',
    name: 'r/GamingLeaksAndRumours',
    url: 'https://www.reddit.com/r/GamingLeaksAndRumours/top/.rss?t=day',
    kind: 'feed',
    intervalMs: 30 * MINUTE,
    publisher: 'Reddit',
    categories: GAMES,
  },
  {
    ...press('gematsu', 'Gematsu', 'https://www.gematsu.com/feed'),
    // Its many posts of a trailer or of gameplay tell no news of their own
    accept: (item) => pressNews(item) && !/\b(trailer|gameplay|screenshots|livestream)$/i.test(item.title),
  },
  { ...press('rockstar-intel', 'RockstarINTEL', 'https://www.rockstarintel.com/feed'), intervalMs: 30 * MINUTE, categories: ['gta6'] },
  press('ign', 'IGN', 'https://feeds.feedburner.com/ign/all', IGN_GROUP),
  press('eurogamer', 'Eurogamer', 'https://www.eurogamer.net/feed', IGN_GROUP),
  press('gamespot', 'GameSpot', 'https://www.gamespot.com/feeds/mashup/'),
  press('kotaku', 'Kotaku', 'https://kotaku.com/rss'),
  press('polygon', 'Polygon', 'https://www.polygon.com/rss/index.xml'),
  press('insider-gaming', 'Insider Gaming', 'https://insider-gaming.com/feed/'),
  press('gamesradar', 'GamesRadar+', 'https://www.gamesradar.com/feeds.xml', 'Future'),
  press('destructoid', 'Destructoid', 'https://www.destructoid.com/feed/'),
  {
    id: 'ps-blog',
    name: 'PlayStation Blog',
    url: 'https://blog.playstation.com/feed/',
    kind: 'custom',
    parse: parsePlayStationBlog,
    intervalMs: 15 * MINUTE,
    official: 'sony',
    // Its posts of PS Plus's monthly games and catalog, which carry the day the games come
    lineup: true,
    // The feed has every post whole
    selfContained: true,
    categories: ['playstation', 'freebies', 'gta6', 'releases'],
    // Its weekly picks and podcasts are no news
    accept: (item) => !/^(Share of the Week|Official PlayStation Podcast)/i.test(item.title),
  },
  {
    id: 'xbox-wire',
    name: 'Xbox Wire',
    url: 'https://news.xbox.com/en-us/feed/',
    kind: 'feed',
    intervalMs: 15 * MINUTE,
    official: 'microsoft',
    // The feed has every post whole: «Next Week on XBOX» with all its games and their days among them
    selfContained: true,
    categories: ['xbox', 'pc', 'freebies', 'releases'],
    // Its podcast is no news
    accept: (item) => !/\bOfficial XBOX Podcast\b/i.test(item.title),
  },
  steamNews('steam-news', 'Steam', 593110, ['pc', 'freebies']),
  steamNews('steam-deck', 'Steam Deck', 1675200, ['pc']),
  steamNews('steam-machine', 'Steam Machine', 4165910, ['pc']),
  steamNews('steam-frame', 'Steam Frame', 4165890, ['pc']),
  steamNews('deadlock', 'Deadlock', 1422450, ['pc']),
  steamNews('half-life-alyx', 'Half-Life: Alyx', 546560, ['pc']),
  {
    id: 'nintendo-uk',
    name: 'Nintendo UK',
    url: 'https://www.nintendo.com/en-gb/news.xml',
    kind: 'feed',
    intervalMs: 30 * MINUTE,
    official: 'nintendo',
    categories: ['nintendo', 'releases'],
  },
  {
    id: 'epic-free-games',
    name: 'Epic Games Store: free games',
    url: 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=UA&allowCountries=UA',
    kind: 'custom',
    parse: parseEpicFreeGames,
    intervalMs: 60 * MINUTE,
    official: 'epic',
    structured: true,
    selfContained: true,
    categories: ['freebies'],
  },
  {
    id: 'gamerpower',
    name: 'GamerPower',
    url: 'https://www.gamerpower.com/api/giveaways?type=game',
    kind: 'custom',
    parse: parseGamerPowerGiveaways,
    intervalMs: 60 * MINUTE,
    structured: true,
    selfContained: true,
    categories: ['freebies'],
  },
  // GTA VI's mysteries, from its release on: the hunters' finds on Reddit, told only once the press confirms them —
  // Reddit is one publisher, however many of its forums find it
  {
    id: 'reddit-gta6',
    name: 'r/GTA6',
    url: 'https://www.reddit.com/r/GTA6/top/.rss?t=day',
    kind: 'feed',
    intervalMs: 30 * MINUTE,
    publisher: 'Reddit',
    activeFrom: GTA6_RELEASE,
    categories: ['gta6'],
  },
  {
    id: 'reddit-chiliad-mystery',
    name: 'r/chiliadmystery',
    url: 'https://www.reddit.com/r/chiliadmystery/new/.rss',
    kind: 'feed',
    intervalMs: 60 * MINUTE,
    publisher: 'Reddit',
    activeFrom: GTA6_RELEASE,
    categories: ['gta6'],
  },
  {
    id: 'google-news-gta6',
    name: 'Google News: GTA VI mysteries',
    url: 'https://news.google.com/rss/search?q=%22GTA%206%22%20(%22easter%20egg%22%20OR%20mystery)%20when:30d&hl=en-US&gl=US&ceid=US:en',
    kind: 'feed',
    intervalMs: 60 * MINUTE,
    activeFrom: GTA6_RELEASE,
    categories: ['gta6'],
  },
  {
    id: 'game-pass-added',
    name: 'Xbox Game Pass: recently added',
    url: 'https://www.xbox.com/en-US/xbox-game-pass/games',
    kind: 'fetch',
    fetch: gamePassSource(GAME_PASS_ADDED),
    intervalMs: 3 * 60 * MINUTE,
    official: 'microsoft',
    structured: true,
    selfContained: true,
    categories: ['xbox', 'freebies'],
  },
  {
    id: 'game-pass-leaving',
    name: 'Xbox Game Pass: leaving soon',
    url: 'https://www.xbox.com/en-US/xbox-game-pass/games',
    kind: 'fetch',
    fetch: gamePassSource(GAME_PASS_LEAVING),
    intervalMs: 3 * 60 * MINUTE,
    official: 'microsoft',
    structured: true,
    selfContained: true,
    categories: ['xbox'],
  },
  {
    id: 'ps-store-last-chance',
    name: 'PlayStation Store: Last Chance to Play',
    url: 'https://store.playstation.com/uk-ua/category/1b3a7ad1-d106-4316-8917-0d4d0c14da42/1',
    kind: 'fetch',
    fetch: fetchLastChance,
    // The list changes once a month, on the third Tuesday
    intervalMs: 3 * 60 * MINUTE,
    official: 'sony',
    structured: true,
    lineup: true,
    selfContained: true,
    categories: ['playstation'],
  },
];
