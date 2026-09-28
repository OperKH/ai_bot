const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A source a story has heard from */
export interface StorySignal {
  sourceId: string;
  /** The vendor's own channel */
  official: boolean;
  /** A model catalog: a listing there means the model is out */
  aggregator: boolean;
}

/** A catalog listing without an announcement is written up after this */
export const AGGREGATOR_WAIT_MS = 60 * MINUTE;
/** Sources that agree without an official one make a rumor after this */
export const RUMOR_WAIT_MS = 45 * MINUTE;
/** A story nobody confirmed in this long is dropped */
export const STORY_GIVE_UP_MS = 6 * HOUR;

export type StoryVerdict = 'wait' | 'write' | 'write-rumor' | 'drop';

/**
 * Whether a pending story is ready to be written: at once when an official
 * source has it; a model already listed in a catalog after an hour without an
 * announcement; two sources agreeing, after 45 minutes, as a rumor from the
 * magpie. Unconfirmed, it is dropped.
 */
export function storyVerdict(createdAt: Date, signals: StorySignal[], now: Date): StoryVerdict {
  const age = now.getTime() - createdAt.getTime();
  if (signals.some((s) => s.official)) return 'write';
  if (signals.some((s) => s.aggregator) && age >= AGGREGATOR_WAIT_MS) return 'write';
  if (new Set(signals.map((s) => s.sourceId)).size >= 2 && age >= RUMOR_WAIT_MS) return 'write-rumor';
  return age >= STORY_GIVE_UP_MS ? 'drop' : 'wait';
}

/** A publisher a game story has heard from */
export interface GameSignal {
  publisher: string;
  /** A platform's own channel */
  official: boolean;
  /** A store's own list — its free games, the games leaving it: the news by itself */
  structured: boolean;
  firstSeenAt: Date;
}

/** A game news of the press waits this long for its publishers, so a big one is known as big when it is written */
export const GAME_SETTLE_MS = 20 * MINUTE;
/** The publishers of a game story are counted within this long of its first entry */
export const COVERAGE_WINDOW_MS = 6 * HOUR;
/** This many publishers within this long of the first entry make a game news a mega one */
export const MEGA_PUBLISHERS = 5;
export const MEGA_WINDOW_MS = 3 * HOUR;
/** A platform's own post and this many publishers in all make it a mega one too */
export const OFFICIAL_MEGA_PUBLISHERS = 3;

/**
 * Whether a pending game story is ready to be written, and how big it is (concept, section 7.2): a store's own
 * list, or a platform's own post of a notable news, at once; the press once `need` publishers wrote of it within
 * six hours of its first entry, after twenty minutes for the others to come. Five publishers within three hours,
 * or a platform's post and three publishers, make it a mega news. Unconfirmed, it is dropped.
 */
export function gameStoryVerdict(
  createdAt: Date,
  signals: GameSignal[],
  need: number,
  importance: 1 | 2 | 3,
  now: Date,
): { verdict: Exclude<StoryVerdict, 'write-rumor'>; importance: 1 | 2 | 3 } {
  const age = now.getTime() - createdAt.getTime();
  const within = (ms: number) =>
    new Set(signals.filter((s) => s.firstSeenAt.getTime() - createdAt.getTime() <= ms).map((s) => s.publisher)).size;
  const publishers = within(COVERAGE_WINDOW_MS);
  const official = signals.some((s) => s.official);
  const mega = within(MEGA_WINDOW_MS) >= MEGA_PUBLISHERS || (official && publishers >= OFFICIAL_MEGA_PUBLISHERS);
  const sized = mega ? 3 : importance;
  if (signals.some((s) => s.structured) || (official && importance >= 2)) return { verdict: 'write', importance: sized };
  if (publishers >= need && age >= GAME_SETTLE_MS) return { verdict: 'write', importance: sized };
  return { verdict: age >= STORY_GIVE_UP_MS ? 'drop' : 'wait', importance: sized };
}
