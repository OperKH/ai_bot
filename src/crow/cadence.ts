import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { Cadence, Importance, Visits } from './categories';

/** A number in [0, 1), as `Math.random` gives; the tests pass a seeded one */
export type Random = () => number;

/** No two posts of the crow in a chat come closer than this, whatever arcs they belong to */
export const MIN_GAP_MS = 5 * 60_000;
/** Added at random to the minimal gap, so the crow does not come like clockwork */
export const MIN_GAP_JITTER_MS = 3 * 60_000;

/** The cats it takes to shoo the crow away with «Кш!»: her answer is written for two and for three */
export type ShooCats = 2 | 3;

export interface BoldnessLevel {
  label: string;
  /** The level in the menu, as crows: 🐦‍⬛ to 🐦‍⬛🐦‍⬛🐦‍⬛ */
  crows: number;
  /** Scales the number of posts per story */
  multiplier: number;
  /** Arc posts per hour; above it only the first post of a mega story gets through */
  hourlyCap: number;
  /** Arc posts per day; above it optional posts are dropped and only mega stories go on */
  dailyCap: number;
  /** Cats pressing «Кш!» within the hour that send her away for an hour */
  shooCats: ShooCats;
  /** Talks she joins uncalled in an hour */
  chimesPerHour: number;
  /** Whether the cats she names get a notification: a restrained crow names them without one */
  pings: boolean;
}

/** How pushy the crow is in a chat (docs/crow/behavior.md) */
export const BOLDNESS: Record<CrowBoldness, BoldnessLevel> = {
  restrained: { label: 'Стримана', crows: 1, multiplier: 0.5, hourlyCap: 3, dailyCap: 12, shooCats: 2, chimesPerHour: 2, pings: false },
  bold: { label: 'Нагла', crows: 2, multiplier: 1, hourlyCap: 6, dailyCap: 24, shooCats: 2, chimesPerHour: 4, pings: true },
  pestering: { label: 'Заєбуча', crows: 3, multiplier: 1.5, hourlyCap: 8, dailyCap: 36, shooCats: 3, chimesPerHour: 6, pings: true },
};

export const BOLDNESS_ORDER: readonly CrowBoldness[] = ['restrained', 'bold', 'pestering'];

/** How many posts of a story a chat gets */
export function visitsFor(cadence: Cadence, importance: Importance, boldness: CrowBoldness): number {
  const { visits } = cadence.byImportance[importance];
  return Math.min(cadence.hardMax, Math.max(1, Math.round(visits * BOLDNESS[boldness].multiplier)));
}

/** The minimal gap before the chat's next post, with its random part */
export function nextPostGap(random: Random): number {
  return MIN_GAP_MS + Math.round(random() * MIN_GAP_JITTER_MS);
}

/** Each gap of the tail is about this many times the one before */
const TAIL_RATIO = 1.9;
/** Spread of the tail gaps: log-normal, about ±25% */
const JITTER_SIGMA = 0.22;

/** A standard normal number (Box–Muller) */
function gaussian(random: Random): number {
  const u = 1 - random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * The gaps between the `count` posts of an arc: first a burst — the opening
 * posts within `burst.withinMs` — then gaps growing geometrically, so the arc
 * fills its window and gets rarer towards the end. Every gap is at least the
 * minimal one. The gaps are jittered, so every chat gets its own rhythm.
 *
 * With 8 posts over 12 h and a burst of 3 within 20 min the ideal gaps are about
 * 7, 9, 27, 51, 96, 183 and 348 minutes.
 */
export function planGaps(profile: Visits, count: number, random: Random): number[] {
  if (count <= 1) return [];
  const gaps: number[] = [];

  const burstGaps = Math.min(count, profile.burst?.visits ?? 1) - 1;
  if (profile.burst && burstGaps > 0) {
    const maxGap = Math.max(MIN_GAP_MS, profile.burst.withinMs / burstGaps);
    for (let i = 0; i < burstGaps; i++) gaps.push(MIN_GAP_MS + random() * (maxGap - MIN_GAP_MS));
  }

  const tailCount = count - 1 - gaps.length;
  if (tailCount > 0) {
    const used = gaps.reduce((sum, gap) => sum + gap, 0);
    const remaining = Math.max((profile.windowMs ?? 0) - used, tailCount * MIN_GAP_MS);
    const first = (remaining * (TAIL_RATIO - 1)) / (TAIL_RATIO ** tailCount - 1);
    for (let k = 0; k < tailCount; k++) {
      const jitter = Math.exp(JITTER_SIGMA * gaussian(random));
      gaps.push(Math.max(MIN_GAP_MS, first * TAIL_RATIO ** k * jitter));
    }
  }
  return gaps.map(Math.round);
}

/**
 * The messages of an arc a chat gets when it gets fewer than were written: the
 * opening always, then the core messages in order, then the optional ones. The
 * arc is written once, for the boldest chat.
 */
export function pickMessages<T extends { seq: number; optional: boolean }>(messages: T[], count: number): T[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  if (count >= sorted.length) return sorted;
  const rest = sorted.slice(1);
  const kept = [...rest.filter((m) => !m.optional), ...rest.filter((m) => m.optional)].slice(0, Math.max(0, count - 1));
  return [sorted[0], ...kept].sort((a, b) => a.seq - b.seq);
}
