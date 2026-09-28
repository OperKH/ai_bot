import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowPostKind } from '../entity/CrowPost.entity';
import { BOLDNESS } from './cadence';
import type { Importance } from './categories';
import { isQuiet } from './chatClock';

/** What the dispatcher needs to know of a chat */
export interface DispatchChat {
  boldness: CrowBoldness;
  /** Set with /timezone; UTC until then */
  timeZone: string;
  quietFrom: number | null;
  quietTo: number | null;
  snoozedUntil: Date | null;
  /** No post before this */
  nextPostAt: Date | null;
}

/** A post whose turn has come: planned, and its `notBefore` has passed */
export interface DispatchCandidate {
  postId: number;
  kind: CrowPostKind;
  storyId: number | null;
  /** The first post of its story in this chat — the one that brings the news */
  isFirst: boolean;
  optional: boolean;
  importance: Importance;
  notBefore: Date;
  expiresAt: Date | null;
  /** When the chat last heard of this story; null before the story's first post */
  storyLastSentAt: Date | null;
}

/**
 * What each kind of post is to the queue and the sender, so that a new kind decides each of it:
 * - `name` — how the log calls it;
 * - `limited` — the chat's hourly and daily limits count and stop it: its news, and the jabs, bets and quizzes of
 *   its arcs. The crow's introduction and her goodbye, the weekly digest, a bet's outcome, the streams, the
 *   reminders of the games that come or go, GTA VI's countdown, the release radar and her birthday are not news,
 *   and are neither counted nor stopped — a goodbye matters most on the busiest day, a reminder cannot wait for
 *   the next hour. Her talks go at once, past the queue;
 * - `shoo` — it carries «Кш!»: not the crow saying who she is, her goodbye before the night, her birthday once a
 *   year, her answer to a cat who called her, nor the polls — a bet, a quiz — which take no buttons of the
 *   crow's. Joining a talk uncalled, she carries it.
 */
export const POST_KINDS: Record<CrowPostKind, { name: string; limited: boolean; shoo: boolean }> = {
  arc: { name: 'Post', limited: true, shoo: true },
  digest: { name: 'Morning digest', limited: true, shoo: true },
  jab: { name: 'Jab', limited: true, shoo: true },
  intro: { name: 'Introduction', limited: false, shoo: false },
  goodbye: { name: 'Evening goodbye', limited: false, shoo: false },
  reply: { name: 'Reply', limited: false, shoo: false },
  chime: { name: 'Chime-in', limited: false, shoo: true },
  told: { name: '«Я ж казала»', limited: false, shoo: true },
  update: { name: 'Rumor update', limited: true, shoo: true },
  weekly: { name: 'Weekly digest', limited: false, shoo: true },
  bet: { name: 'Bet', limited: true, shoo: false },
  outcome: { name: 'Bet outcome', limited: false, shoo: true },
  event: { name: 'Stream announcement', limited: false, shoo: true },
  reminder: { name: 'Stream reminder', limited: false, shoo: true },
  quiz: { name: 'Quiz', limited: true, shoo: false },
  due: { name: 'Reminder', limited: false, shoo: true },
  countdown: { name: 'Countdown', limited: false, shoo: true },
  radar: { name: 'Release radar', limited: false, shoo: true },
  birthday: { name: 'Birthday', limited: false, shoo: false },
};

const kinds = (has: (kind: (typeof POST_KINDS)[CrowPostKind]) => boolean): readonly CrowPostKind[] =>
  (Object.keys(POST_KINDS) as CrowPostKind[]).filter((kind) => has(POST_KINDS[kind]));

/** The posts the chat's limits count and stop */
export const LIMITED_KINDS = kinds((kind) => kind.limited);
/** The posts without «Кш!» */
export const WITHOUT_SHOO = kinds((kind) => !kind.shoo);

const outsideLimits = (candidate: DispatchCandidate) => !LIMITED_KINDS.includes(candidate.kind);

/** Arc posts the chat got in the last hour and since its local midnight */
export interface SentCounts {
  lastHour: number;
  today: number;
}

export interface DispatchDecision {
  send: DispatchCandidate | null;
  /** Dropped: out of date, or optional when the chat hit its daily limit */
  skip: DispatchCandidate[];
}

/** How much a post wants to go now; the kind of post counts first, then the story */
function priority(candidate: DispatchCandidate, now: Date): number {
  const base = candidate.isFirst ? 300 : candidate.optional ? 100 : 200;
  // A story the chat has not heard of for a while comes up, so arcs take turns
  const idleMinutes = candidate.storyLastSentAt ? (now.getTime() - candidate.storyLastSentAt.getTime()) / 60_000 : 0;
  return base + candidate.importance * 10 + Math.min(idleMinutes / 10, 50);
}

/**
 * Which post of a chat goes now, if any (docs/crow/architecture.md). A chat gets at
 * most one post per tick, and then not before its minimal gap has passed.
 *
 * - Out-of-date posts are dropped even while the chat is quiet, so they do not
 *   pile up for the morning.
 * - Over the hourly limit only the first post of a mega story gets through.
 * - Over the daily limit optional posts are dropped, and only the core of mega
 *   stories goes on.
 */
export function decide(
  chat: DispatchChat,
  candidates: DispatchCandidate[],
  sent: SentCounts,
  now: Date,
): DispatchDecision {
  const skip = candidates.filter((c) => c.expiresAt !== null && c.expiresAt <= now);
  let live = candidates.filter((c) => !skip.includes(c));

  const waiting =
    (chat.snoozedUntil !== null && chat.snoozedUntil > now) ||
    isQuiet(now, chat.timeZone, chat.quietFrom, chat.quietTo) ||
    (chat.nextPostAt !== null && chat.nextPostAt > now);
  if (waiting) return { send: null, skip };

  const level = BOLDNESS[chat.boldness];
  if (sent.today >= level.dailyCap) {
    skip.push(...live.filter((c) => c.optional));
    live = live.filter((c) => outsideLimits(c) || (!c.optional && c.importance === 3));
  } else if (sent.lastHour >= level.hourlyCap) {
    live = live.filter((c) => outsideLimits(c) || (c.isFirst && c.importance === 3));
  }

  const [send = null] = live.sort(
    (a, b) =>
      priority(b, now) - priority(a, now) || a.notBefore.getTime() - b.notBefore.getTime() || a.postId - b.postId,
  );
  return { send, skip };
}

/** The news itself — an opening, a digest, the UPD to a confirmed rumor, the reminder that games come or go */
export function isNews(candidate: Pick<DispatchCandidate, 'isFirst'>, kind: CrowPostKind): boolean {
  return candidate.isFirst || kind === 'update' || kind === 'due';
}

/**
 * Whether a post rings: the news itself does, and filler goes silently.
 * A restrained crow rings only for mega stories, a pestering one for everything —
 * but never for the evening goodbye: it is late, and it is not news.
 */
export function isLoud(
  candidate: Pick<DispatchCandidate, 'isFirst' | 'importance'>,
  boldness: CrowBoldness,
  kind: CrowPostKind = 'arc',
): boolean {
  if (kind === 'goodbye') return false;
  if (boldness === 'pestering') return true;
  return isNews(candidate, kind) && (boldness === 'bold' || candidate.importance === 3);
}

/**
 * When the chat's next post may go after one sent at `sentAt`: the minimal gap
 * — or, after the evening goodbye, not before the quiet hours begin (the
 * goodbye's `expiresAt`), so that it is the day's last post.
 */
export function nextPostTime(post: { kind: CrowPostKind; expiresAt: Date | null }, sentAt: Date, gapMs: number): Date {
  const next = new Date(sentAt.getTime() + gapMs);
  return post.kind === 'goodbye' && post.expiresAt && post.expiresAt > next ? post.expiresAt : next;
}
