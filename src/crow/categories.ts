/** 1 — a trifle, 2 — notable, 3 — mega */
export type Importance = 1 | 2 | 3;

/** How many posts a story of one importance gets, and over how long */
export interface Visits {
  visits: number;
  /** How long the arc lasts; the gaps grow so that the posts fill it */
  windowMs?: number;
  /** The first posts come close together: `visits` of them within `withinMs` */
  burst?: { visits: number; withinMs: number };
}

export interface Cadence {
  /** No chat gets more posts of a story than this, however bold the crow is there */
  hardMax: number;
  byImportance: Record<Importance, Visits>;
}

export type CategoryId =
  | 'ai-enterprise'
  | 'ai-homebrew'
  | 'vibecoding'
  | 'playstation'
  | 'ps-plus'
  | 'nintendo'
  | 'xbox'
  | 'pc'
  | 'freebies'
  | 'gta6'
  | 'releases'
  | 'hacking';

/**
 * What a category's news are, which decides how its stories are gathered: an AI story is the topic of a model
 * and is confirmed by its vendor's word; a game story is the entries of several publishers about one news,
 * gathered by meaning, and is confirmed by how many of them wrote of it (docs/crow/pipeline.md#game-stories)
 */
export type CategoryDomain = 'ai' | 'games';

export interface Category {
  id: CategoryId;
  domain: CategoryDomain;
  /**
   * A game story of the category is written once this many publishers wrote of it; the official channels and
   * the stores' own lists write theirs at once
   */
  publishers?: number;
  /** The button in the `/crow` menu */
  button: string;
  /** What the category is about, shown next to the button */
  caption: (now: Date) => string;
  cadence: Cadence;
  /** Its news are its alone: an entry sorted into it is in no other category, as PS Plus's lists are not Плойка's */
  exclusive?: boolean;
  /** Toasts when the category is switched on and off */
  toasts: { on: string; off: string };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** GTA VI comes out on 19.11.2026; from then on the category is about its mysteries */
export const GTA6_RELEASE = new Date('2026-11-18T22:00:00Z');
/** Its day, as every chat counts the days to it in its own zone */
export const GTA6_RELEASE_DAY = '2026-11-19';

/** A platform's news is its opening; a pestering crow adds a word on it */
const PLATFORM: Cadence = {
  hardMax: 2,
  byImportance: {
    3: { visits: 1, windowMs: 8 * HOUR },
    2: { visits: 1, windowMs: 4 * HOUR },
    1: { visits: 1 },
  },
};

/** A list of games that come for free, or with a subscription: the list, and a word on its best a day or two later */
const LISTS: Cadence = {
  hardMax: 2,
  byImportance: {
    3: { visits: 2, windowMs: 48 * HOUR },
    2: { visits: 2, windowMs: 48 * HOUR },
    1: { visits: 1 },
  },
};

/**
 * The categories, in the order of the menu. The number of posts per story is set
 * per category (owner decisions 3 and 10): flagship AI releases pester the chat all
 * day, an open model or a new command of Claude Code is worth a post or two.
 */
export const CATEGORIES: readonly Category[] = [
  {
    id: 'ai-enterprise',
    domain: 'ai',
    button: '🤖 AI Enterprise',
    caption: () => 'флагманські моделі',
    cadence: {
      hardMax: 8,
      byImportance: {
        3: { visits: 6, windowMs: 30 * HOUR, burst: { visits: 2, withinMs: 20 * MINUTE } },
        2: { visits: 3, windowMs: 12 * HOUR },
        1: { visits: 1, windowMs: 4 * HOUR },
      },
    },
    toasts: {
      on: '🤖 AI Enterprise увімкнено. Ви самі цього хотіли.',
      off: '🤖 AI Enterprise вимкнено. Сидітимете на старій моделі, як печерні коти.',
    },
  },
  {
    id: 'ai-homebrew',
    domain: 'ai',
    button: '🦙 AI Homebrew',
    caption: () => 'відкриті моделі',
    // An open model is a post or two of material
    cadence: {
      hardMax: 2,
      byImportance: {
        3: { visits: 2, windowMs: 8 * HOUR },
        2: { visits: 1, windowMs: 4 * HOUR },
        1: { visits: 1 },
      },
    },
    toasts: {
      on: '🦙 AI Homebrew увімкнено. Гріймо відеокарти вдома.',
      off: '🦙 AI Homebrew вимкнено. Хмара теж гріє. Чужа.',
    },
  },
  {
    id: 'vibecoding',
    domain: 'ai',
    button: '🧑‍💻 Вайбкодинг',
    caption: () => 'Claude Code, Codex, Cursor',
    // What matters are new commands and features; a release is a post or two
    cadence: {
      hardMax: 2,
      byImportance: {
        3: { visits: 2, windowMs: 6 * HOUR },
        2: { visits: 2, windowMs: 4 * HOUR },
        1: { visits: 1 },
      },
    },
    toasts: {
      on: '🧑‍💻 Вайбкодинг увімкнено. Нові команди Claude Code — від мене першої.',
      off: '🧑‍💻 Вайбкодинг вимкнено. Пишіть код руками, як діди.',
    },
  },
  {
    id: 'playstation',
    domain: 'games',
    publishers: 3,
    button: '🎮 Плойка',
    caption: () => 'PlayStation і State of Play',
    cadence: PLATFORM,
    toasts: {
      on: '🎮 Плойку увімкнено. State of Play, ексклюзиви, ціни — усе принесу.',
      off: '🎮 Плойку вимкнено. Сподіваюся, у вас хоч Steam Deck є.',
    },
  },
  {
    id: 'ps-plus',
    domain: 'games',
    publishers: 2,
    button: '➕ PS Plus',
    caption: () => 'ігри місяця й каталог',
    // Only the lists: the month's games, those coming to the catalog and leaving it — sent first (docs/crow/behavior.md#game-news)
    cadence: LISTS,
    exclusive: true,
    toasts: {
      on: '➕ PS Plus увімкнено. Що Sony дає і що забирає з каталогу — каркну першою.',
      off: '➕ PS Plus вимкнено. Хай підписка сама вам пише, що з неї зникає.',
    },
  },
  {
    id: 'nintendo',
    domain: 'games',
    publishers: 3,
    button: '🍄 Нінтендо',
    caption: () => 'Nintendo і Switch 2',
    cadence: PLATFORM,
    toasts: {
      on: '🍄 Нінтендо увімкнено. Готуйте гаманці.',
      off: '🍄 Нінтендо вимкнено. Маріо плаче в кутку.',
    },
  },
  {
    id: 'xbox',
    domain: 'games',
    publishers: 3,
    button: '🟩 Бокс',
    caption: () => 'Xbox і Game Pass',
    // Game Pass's batches are its news too, so a word more than the other platforms
    cadence: {
      hardMax: 3,
      byImportance: {
        3: { visits: 2, windowMs: 8 * HOUR },
        2: { visits: 1, windowMs: 4 * HOUR },
        1: { visits: 1 },
      },
    },
    toasts: {
      on: '🟩 Бокс увімкнено. Game Pass, Xbox і все, що вони знову переносять на PS5.',
      off: '🟩 Бокс вимкнено. Мудро: там і так усе виходить на PS5.',
    },
  },
  {
    id: 'pc',
    domain: 'games',
    publishers: 3,
    button: '🖥 Пекарня',
    caption: () => 'ПК і Steam',
    cadence: PLATFORM,
    toasts: {
      on: '🖥 Пекарню увімкнено. Steam, розпродажі й залізо Valve — розігріваю відеокарту.',
      off: '🖥 Пекарню вимкнено. Консольщики, радійте.',
    },
  },
  {
    id: 'freebies',
    domain: 'games',
    publishers: 2,
    button: '🆓 Халява',
    caption: () => 'безкоштовні ігри',
    cadence: LISTS,
    toasts: {
      on: '🆓 Халяву увімкнено. Краду для вас безкоштовні ігри.',
      off: '🆓 Халяву вимкнено. Любите платити? Поважаю.',
    },
  },
  {
    id: 'gta6',
    domain: 'games',
    publishers: 2,
    button: '🌴 GTA VI',
    caption: (now) => (now < GTA6_RELEASE ? 'відлік до 19.11' : 'таємниці та пасхалки'),
    cadence: {
      hardMax: 3,
      byImportance: {
        3: { visits: 2, windowMs: 12 * HOUR },
        2: { visits: 1, windowMs: 6 * HOUR },
        1: { visits: 1 },
      },
    },
    toasts: {
      on: '🌴 GTA VI увімкнено. Рахуватимемо дні разом.',
      off: '🌴 GTA VI вимкнено. Однаково купите її в день релізу.',
    },
  },
  {
    id: 'releases',
    domain: 'games',
    publishers: 2,
    button: '📅 Реліз-радар',
    caption: () => 'релізи тижня й переноси',
    // The week's releases come as one post on Monday (releases.ts); a delay is a post of its own
    cadence: {
      hardMax: 1,
      byImportance: { 3: { visits: 1 }, 2: { visits: 1 }, 1: { visits: 1 } },
    },
    toasts: {
      on: '📅 Реліз-радар увімкнено. Що виходить цього тижня й хто знову переніс — від мене першої.',
      off: '📅 Реліз-радар вимкнено. Про переноси дізнаватиметеся з мемів.',
    },
  },
  {
    id: 'hacking',
    domain: 'games',
    // Its news is niche: one publisher of the scene is enough
    publishers: 1,
    button: '🏴‍☠️ Хакерня',
    caption: () => 'взломи, емулятори, хоумбрю',
    cadence: {
      hardMax: 2,
      byImportance: {
        3: { visits: 2, windowMs: 6 * HOUR },
        2: { visits: 1 },
        1: { visits: 1 },
      },
    },
    toasts: {
      on: '🏴‍☠️ Хакерню увімкнено. Взломи й емулятори — без піратських посилань, я ж порядна ворона.',
      off: '🏴‍☠️ Хакерню вимкнено. Оновлюйте прошивки, коти, ризикуйте.',
    },
  },
];

export function findCategory(id: string): Category | undefined {
  return CATEGORIES.find((category) => category.id === id);
}

/** The categories of the game news, which the game sorting places entries into */
export const GAME_CATEGORY_IDS = CATEGORIES.filter((category) => category.domain === 'games').map((category) => category.id);

/** The categories of a news, once each: an exclusive one among them is all of them — PS Plus's lists are not Плойка's */
export function ownCategories<T extends string>(ids: readonly T[]): T[] {
  const own = ids.find((id) => findCategory(id)?.exclusive);
  return own ? [own] : [...new Set(ids)];
}

/** Whether a story is game news: gathered by meaning and confirmed by its publishers, rather than by its vendor */
export function isGameStory(categories: readonly string[]): boolean {
  return categories.some((id) => findCategory(id)?.domain === 'games');
}

/**
 * How many publishers a game story must have for its arc: the fewest its categories ask — the chat that follows
 * GTA VI hears of it from two publishers, where news of a platform takes three
 */
export function publishersNeeded(categories: readonly string[]): number {
  const needs = categories.map((id) => findCategory(id)?.publishers).filter((need) => need !== undefined);
  return needs.length > 0 ? Math.min(...needs) : 3;
}

/** The category as the menu names it, for prompts: «🤖 AI Enterprise — флагманські моделі» */
export function categoryLabel(category: Category, now: Date): string {
  return `${category.button} — ${category.caption(now)}`;
}

/** The first known of a story's categories as `categoryLabel` names it; the ids, when none is known any more */
export function categoriesLabel(ids: readonly string[], now: Date): string {
  const category = ids.map(findCategory).find((c) => c !== undefined);
  return category ? categoryLabel(category, now) : ids.join(', ');
}
