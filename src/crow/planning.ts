import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowMention } from '../entity/CrowPost.entity';
import { pickMessages, planGaps, type Random, visitsFor } from './cadence';
import { type Cadence, type Category, findCategory, type Importance, type Visits } from './categories';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** News older than this is not brought to a chat any more: the arc is cancelled there */
export const FIRST_POST_TTL_MS = 24 * HOUR;
/** An optional post that could not go out this long after its time is dropped */
const OPTIONAL_GRACE_MS = 2 * HOUR;

/** A message of an arc, as planning sees it */
export interface ArcMessage {
  id: number;
  seq: number;
  optional: boolean;
}

/** A post to insert into a chat's queue */
export interface PlannedPost {
  kind: 'arc' | 'jab' | 'bet' | 'quiz';
  /** The arc's message; a jab has its own text instead */
  storyMessageId: number | null;
  text: string | null;
  mention: CrowMention | null;
  /** The post's place in the chat's chain */
  seq: number;
  optional: boolean;
  importance: Importance;
  gapMs: number;
  /** Set for the first post only; the others get theirs when the one before is done */
  notBefore: Date | null;
  expiresAt: Date | null;
}

/**
 * The category whose cadence a chat hears a story with: of the story's categories
 * the chat is subscribed to, the one that allows the most posts. Undefined when
 * the chat is subscribed to none of them.
 */
export function cadenceCategory(storyCategories: string[], subscriptions: ReadonlySet<string>): Category | undefined {
  return storyCategories
    .filter((id) => subscriptions.has(id))
    .map(findCategory)
    .filter((category) => category !== undefined)
    .sort((a, b) => b.cadence.hardMax - a.cadence.hardMax)[0];
}

/**
 * A chat's schedule of an arc: which of its messages the chat gets, with the
 * boldness of the chat, and the gaps between them. The first post may go at
 * once; each next one waits for the one before it (see `activation`).
 */
export function planArc(
  messages: ArcMessage[],
  cadence: Cadence,
  importance: Importance,
  boldness: CrowBoldness,
  now: Date,
  random: Random,
): PlannedPost[] {
  return planPosts(messages, visitsFor(cadence, importance, boldness), cadence.byImportance[importance], importance, now, random);
}

/** `planArc` with the number of posts and their profile given */
export function planPosts(
  messages: ArcMessage[],
  count: number,
  profile: Visits,
  importance: Importance,
  now: Date,
  random: Random,
): PlannedPost[] {
  const picked = pickMessages(messages, count);
  const gaps = planGaps(profile, picked.length, random);
  return picked.map((message, i) => ({
    kind: 'arc',
    storyMessageId: message.id,
    text: null,
    mention: null,
    seq: i + 1,
    optional: message.optional,
    importance,
    gapMs: i === 0 ? 0 : gaps[i - 1],
    notBefore: i === 0 ? now : null,
    expiresAt: i === 0 ? new Date(now.getTime() + FIRST_POST_TTL_MS) : null,
  }));
}

/**
 * When a post's turn comes, once the post before it in the arc is done (sent,
 * dropped or failed) at `previousDoneAt`. An optional post goes stale if it
 * cannot go out soon after: it is filler, and filler of the night is not worth
 * a morning post.
 */
export function activation(
  post: { gapMs: number; optional: boolean },
  previousDoneAt: Date,
): { notBefore: Date; expiresAt: Date | null } {
  const notBefore = new Date(previousDoneAt.getTime() + post.gapMs);
  const expiresAt = post.optional ? new Date(notBefore.getTime() + Math.max(OPTIONAL_GRACE_MS, post.gapMs)) : null;
  return { notBefore, expiresAt };
}

/**
 * A post of its own to put into a chat's chain of an arc — a jab, a bet, a quiz: as important as the arc, a random
 * gap after the post before it; `seq` comes when the chain is numbered again
 */
export function chainPost(
  planned: readonly PlannedPost[],
  post: Pick<PlannedPost, 'kind' | 'text' | 'mention' | 'optional'>,
  gap: { minMs: number; maxMs: number },
  random: Random,
): PlannedPost {
  return {
    ...post,
    storyMessageId: null,
    seq: 0,
    importance: planned[0].importance,
    gapMs: Math.round(gap.minMs + random() * (gap.maxMs - gap.minMs)),
    notBefore: null,
    expiresAt: null,
  };
}

/** A chain with `post` put in after its first `at` posts, numbered again */
export function insertPost(planned: readonly PlannedPost[], at: number, post: PlannedPost): PlannedPost[] {
  return numbered([...planned.slice(0, at), post, ...planned.slice(at)]);
}

function numbered(chain: readonly PlannedPost[]): PlannedPost[] {
  return chain.map((post, i) => ({ ...post, seq: i + 1 }));
}

/** A personal jab to put into a chat's chain of an arc */
export interface PlannedJab {
  /** With `{cat}` where the cat is named */
  text: string;
  mention: CrowMention;
}

/** A chat's arc this short gets no jab: it is the news and a fact or two */
export const JAB_MIN_POSTS = 3;
/** A jab comes this long after the post before it, at random */
const JAB_GAP = { minMs: 10 * MINUTE, maxMs: 40 * MINUTE };

/**
 * Puts a chat's jabs into its chain of an arc: the first after the arc's second
 * post, a second one halfway through the rest; the chain is numbered again. A
 * jab is optional, so a chat over its daily limit loses it first.
 */
export function withJabs(planned: PlannedPost[], jabs: PlannedJab[], random: Random): PlannedPost[] {
  if (jabs.length === 0 || planned.length < JAB_MIN_POSTS) return planned;
  const jabPost = (jab: PlannedJab) =>
    chainPost(planned, { kind: 'jab', text: jab.text, mention: jab.mention, optional: true }, JAB_GAP, random);
  const [first, second] = jabs;
  const chain = [...planned.slice(0, 2), jabPost(first)];
  const rest = planned.slice(2);
  const half = Math.ceil(rest.length / 2);
  chain.push(...rest.slice(0, half), ...(second ? [jabPost(second)] : []), ...rest.slice(half));
  return numbered(chain);
}
