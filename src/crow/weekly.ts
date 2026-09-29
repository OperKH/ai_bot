import { getLinkChatId, supergroupMessageLink } from '../bot/telegramLinks';
import type { CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';
import {
  allowedNumbers,
  type Attempt,
  attemptsCost,
  crowPrefix,
  textProblems,
  withoutCrows,
  writeChecked,
} from './arcValidation';
import { categoriesLabel, findCategory, type Importance } from './categories';
import { zoned } from './chatClock';
import type { Priced } from './crowLlm';
import { type CrowJobDefinition, oncePerChat } from './jobs';
import type { WeeklyRequest, WeeklyResult } from './prompts';
import type { CrowStore, SmartestCat, WeekStory } from './store';
import { clip, dayLabel, memoryLine, plural } from './words';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The weekly digest is due on Friday (Temporal counts Monday as 1) at 18:00 in the chat's zone */
export const WEEKLY_DAY = 5;
export const WEEKLY_HOUR = 18;
/** After a downtime it is still made until 21:00; later, the week goes without it */
export const WEEKLY_GRACE_MS = 3 * HOUR;
/** A digest the chat could not hear by midnight — the crow sent away, the quiet hours — is dropped */
const WEEKLY_TTL_MS = 6 * HOUR;
const WEEKLY_INTERVAL_MS = 5 * MINUTE;
const WEEK_MS = 7 * DAY;
/** The bets of this long make the smartest cat */
const SMARTEST_WINDOW_MS = 30 * DAY;
export const TOP_STORIES = 5;
/** Replies count for this many at most, so that one hot thread does not outweigh the news */
const REPLIES_COUNTED = 10;
export const MAX_INTRO_LENGTH = 400;
export const MAX_VERDICT_LENGTH = 250;
const MEMORY_POSTS = 10;
const FACTS_PER_STORY = 3;
const OPTION_MAX = 100;
export const WEEKLY_HEADING = '🗞 Воронячий дайджест тижня';
export const VOTE_QUESTION = '🐦‍⬛ Яка новина тижня найблискучіша?';
/** The word about the week when the model's still fails its checks after the rewrite */
const FALLBACK_INTRO = "🐦‍⬛🐦‍⬛ П'ятниця, коти. Ось що я вам цього тижня натягала в гніздо.";

/**
 * The weekly digest's moment `now` falls into — Friday 18:00 in the chat's zone,
 * and the three hours after it — or null
 */
export function weeklyDue(now: Date, timeZone: string): Date | null {
  const local = zoned(now, timeZone);
  if (local.dayOfWeek !== WEEKLY_DAY) return null;
  const due = local
    .toPlainDate()
    .toZonedDateTime({ timeZone, plainTime: new Temporal.PlainTime(WEEKLY_HOUR) }).epochMilliseconds;
  return now.getTime() >= due && now.getTime() < due + WEEKLY_GRACE_MS ? new Date(due) : null;
}

/**
 * The week's shiniest news, at most five: by importance, and by how much the cats
 * talked back — a reply counts half a point, ten at most — then in the order the
 * chat heard them
 */
export function topStories<T extends Pick<WeekStory, 'importance' | 'replies' | 'sentAt'>>(stories: T[]): T[] {
  const score = (story: T) => story.importance + Math.min(story.replies, REPLIES_COUNTED) / 2;
  return [...stories]
    .sort((a, b) => score(b) - score(a) || a.sentAt.getTime() - b.sentAt.getTime())
    .slice(0, TOP_STORIES);
}

/** How a story of the week is named: by its hero, «Claude Opus 5.5», or else its title */
export const storyName = (story: Pick<WeekStory, 'hero' | 'title'>) => story.hero ?? story.title;

/** Whether the winner the model named is one of the week's news, by a name, a part of one, or the vendor */
function isOfTheWeek(winner: string, stories: readonly Pick<WeekStory, 'hero' | 'title' | 'vendor'>[]): boolean {
  const name = winner.replaceAll('**', '').trim().toLowerCase();
  if (name.length < 2) return false;
  return stories.some((story) =>
    [storyName(story), story.vendor ?? ''].some((known) => {
      const lower = known.toLowerCase();
      return lower.length >= 2 && (lower.includes(name) || name.includes(lower));
    }),
  );
}

/** What is wrong with the model's part of the digest, in words the model gets back when it rewrites it */
export function weeklyProblems(
  result: WeeklyResult,
  stories: readonly Pick<WeekStory, 'hero' | 'title' | 'vendor'>[],
  allowed: Set<string>,
): string[] {
  return [
    ...textProblems(result.intro, allowed, MAX_INTRO_LENGTH).map((problem) => `intro: ${problem}`),
    ...(isOfTheWeek(result.winner, stories) ? [] : [`переможця «${result.winner}» немає серед новин тижня`]),
    ...textProblems(result.verdict, allowed, MAX_VERDICT_LENGTH).map((problem) => `verdict: ${problem}`),
  ];
}

export interface WrittenWeekly {
  /** Null when it still failed its checks after the rewrite */
  result: WeeklyResult | null;
  attempts: Attempt[];
}

/** Writes the model's part as the arcs are written: an attempt, the checks, one rewrite with the problems listed */
export async function writeWeekly(
  write: (request: WeeklyRequest) => Promise<Priced<WeeklyResult>>,
  request: WeeklyRequest,
  stories: readonly Pick<WeekStory, 'hero' | 'title' | 'vendor'>[],
  allowed: Set<string>,
): Promise<WrittenWeekly> {
  const { value, problems, attempts } = await writeChecked(
    write,
    request,
    (result): WeeklyResult => ({
      intro: crowPrefix(result.intro.trim()).text,
      winner: result.winner.replaceAll('**', '').trim(),
      // The verdict goes after the winner's name: a crow in front of it would stand in the middle of the line
      verdict: withoutCrows(result.verdict).trim(),
    }),
    (cleaned) => weeklyProblems(cleaned, stories, allowed),
  );
  return { result: problems.length === 0 ? value : null, attempts };
}

/** How the last vote came out: the options and their votes, if the poll could be stopped */
export interface VoteResult {
  options: string[];
  counts: number[];
}

/** «🗳 Минулого разу ви обрали: **Claude Opus 5.5** — 4 голоси.», or that nobody voted */
export function voteLine(vote: VoteResult): string {
  const total = vote.counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return '🗳 Минулого разу за найкращу новину ніхто не проголосував. Я запам’ятала.';
  const best = vote.counts.indexOf(Math.max(...vote.counts));
  const votes = vote.counts[best];
  return `🗳 Минулого разу ви обрали: **${vote.options[best]}** — ${votes} ${plural(votes, ['голос', 'голоси', 'голосів'])}.`;
}

/** «🧠 Найрозумніший кіт місяця — Олег: 3 з 4 ставок.» */
export function smartestLine(cat: SmartestCat): string {
  return `🧠 Найрозумніший кіт місяця — ${cat.name}: ${cat.wins} з ${cat.bets} ${plural(cat.bets, ['ставки', 'ставок', 'ставок'])}.`;
}

/**
 * The options of the week's vote: a story each, named by its hero, the day added where two share a name, and a
 * number where they share the day too — two options alike would leave the cats guessing which is which
 */
export function voteOptions(stories: readonly { name: string; day: string }[]): string[] {
  const numbered = new Map<string, number>();
  return stories.map((story) => {
    const twins = stories.filter((other) => other.name === story.name);
    if (twins.length === 1) return clip(story.name, OPTION_MAX);
    const sameDay = twins.filter((other) => other.day === story.day).length > 1;
    const key = `${story.name}\n${story.day}`;
    const n = (numbered.get(key) ?? 0) + 1;
    numbered.set(key, n);
    const tag = ` (${story.day}${sameDay ? `, ${n}` : ''})`;
    return clip(story.name, OPTION_MAX - tag.length) + tag;
  });
}

/** A story of the week as the digest shows it */
interface ShownStory {
  story: WeekStory;
  name: string;
  day: string;
}

/**
 * The digest as a post: the heading, the crow's word and the winner, the last
 * vote and the smartest cat, the table of the week's news — each a link to her
 * post that brought it — and the new vote, sent under it
 */
export function weeklyContent(input: {
  chatId: string;
  shown: ShownStory[];
  written: WeeklyResult | null;
  vote: VoteResult | null;
  smartest: SmartestCat | null;
}): { text: string; extras: CrowPostExtras } {
  const { chatId, shown, written } = input;
  const lines = [written?.intro ?? FALLBACK_INTRO];
  if (written) lines.push(`🏆 Переможець тижня — **${written.winner}**: ${written.verdict}`);
  if (input.vote) lines.push(voteLine(input.vote));
  if (input.smartest) lines.push(smartestLine(input.smartest));

  const anchors: NonNullable<CrowPostExtras['anchors']> = {};
  const table: CrowTable = { header: ['Блискучка', 'Коли', '💬'], rows: [] };
  shown.forEach(({ story, name, day }, i) => {
    const category = story.categories.map(findCategory).find((c) => c !== undefined);
    const label = category ? `${category.button.split(' ')[0]} ${name}` : name;
    // A link to her post works in a supergroup; a basic group gets the name alone
    const url = supergroupMessageLink(chatId, story.tgMessageId);
    if (url) {
      anchors[`s${i + 1}`] = { label, url };
      table.rows.push([`{link:s${i + 1}}`, day, String(story.replies)]);
    } else {
      table.rows.push([label, day, String(story.replies)]);
    }
  });
  const extras: CrowPostExtras = { heading: WEEKLY_HEADING, table, anchors };
  if (shown.length >= 2) {
    extras.poll = { question: VOTE_QUESTION, options: voteOptions(shown), storyIds: shown.map(({ story }) => story.storyId) };
  }
  return { text: lines.join('\n'), extras };
}

/** Telegram's side of the week's vote: stopping the last one, which gives its result */
export interface VotePolls {
  /** The votes of each option, or null when Telegram would not stop it: deleted, or closed already */
  stop(chatId: string, messageId: number): Promise<number[] | null>;
}

/**
 * The weekly «Воронячий дайджест» (docs/crow/behavior.md#the-weekly-digest): on
 * Friday at 18:00 in each chat's zone, the week's shiniest news the chat heard,
 * its winner, how the last vote went and the smartest cat of the month, with a
 * vote for the best news under it. A week without news has no digest.
 */
export class WeeklyDigests {
  constructor(
    private readonly store: Pick<
      CrowStore,
      | 'crowChats'
      | 'plannedSince'
      | 'weekStories'
      | 'openVote'
      | 'closeVote'
      | 'smartestCat'
      | 'recentPosts'
      | 'planWeekly'
    >,
    private readonly write: (request: WeeklyRequest) => Promise<Priced<WeeklyResult>>,
    private readonly polls: VotePolls,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return oncePerChat({
      name: 'weekly',
      intervalMs: WEEKLY_INTERVAL_MS,
      clock: this.clock,
      chats: () => this.store.crowChats(),
      moment: (chat, now) => weeklyDue(now, chat.timeZone),
      at: (due) => due,
      keepMs: WEEKLY_GRACE_MS,
      prepare: (chat, due, now) => this.prepare(chat.chatId, chat.timeZone, due, now),
      failed: 'Weekly digest for chat',
    });
  }

  private async prepare(chatId: string, timeZone: string, due: Date, now: Date) {
    if (await this.store.plannedSince(chatId, 'weekly', due)) return;
    const top = topStories(await this.store.weekStories(chatId, new Date(due.getTime() - WEEK_MS), now));
    if (top.length === 0) return;
    const shown = top.map((story) => ({ story, name: storyName(story), day: dayLabel(story.sentAt, now, timeZone) }));

    const vote = await this.lastVote(chatId);
    const smartest = await this.store.smartestCat(chatId, new Date(now.getTime() - SMARTEST_WINDOW_MS));
    const recentPosts = (await this.store.recentPosts(chatId, MEMORY_POSTS)).map((post) => memoryLine(post, now));
    const request: WeeklyRequest = {
      stories: shown.map(({ story, name, day }) => {
        return {
          name,
          title: story.title,
          categoryName: categoriesLabel(story.categories, now),
          importance: story.importance,
          day,
          replies: story.replies,
          facts: story.facts.slice(0, FACTS_PER_STORY),
          verdict: story.stance ? `${story.stance.subject}: ${story.stance.verdict}` : null,
        };
      }),
      lastVote: vote ? voteLine(vote) : null,
      recentPosts,
    };
    const allowed = allowedNumbers(
      ...request.stories.flatMap((story) => [story.name, story.title, ...story.facts.map((fact) => fact.text)]),
      request.lastVote ?? '',
      ...recentPosts,
    );
    const written = await writeWeekly(this.write, request, top, allowed);
    const costUsd = attemptsCost(written.attempts);
    const chat = getLinkChatId(Number(chatId));
    if (written.result === null) {
      console.warn(
        `${LOG_PREFIX} The weekly digest's word for chat ${chat} failed its checks, it goes without:\n  ` +
          written.attempts.at(-1)!.problems.join('\n  '),
      );
    }
    const { text, extras } = weeklyContent({ chatId, shown, written: written.result, vote, smartest });
    await this.store.planWeekly(chatId, {
      text,
      extras,
      importance: Math.max(...top.map((story) => story.importance)) as Importance,
      notBefore: now,
      expiresAt: new Date(due.getTime() + WEEKLY_TTL_MS),
    });
    console.log(`${LOG_PREFIX} Weekly digest of ${top.length} stories planned in chat ${chat} ($${costUsd.toFixed(4)})`);
  }

  /** Stops the chat's last vote and gives its result; null when there was none, or Telegram would not stop it */
  private async lastVote(chatId: string): Promise<VoteResult | null> {
    const open = await this.store.openVote(chatId);
    if (!open) return null;
    const counts = await this.polls.stop(chatId, open.tgMessageId).catch(() => null);
    await this.store.closeVote(open.id, counts, this.clock());
    return counts ? { options: open.options, counts } : null;
  }
}
