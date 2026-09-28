import { getLinkChatId } from '../bot/telegramLinks';
import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowMention, CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowBet, CrowFact } from '../entity/CrowStory.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';
import {
  allowedNumbers,
  type Attempt,
  crowPrefix,
  textProblems,
  withoutCrows,
  writeChecked,
  writeText,
  type WrittenText,
} from './arcValidation';
import { BOLDNESS, type Random } from './cadence';
import type { Priced } from './crowLlm';
import { withoutMarkup } from './crowMessage';
import type { CrowJobDefinition } from './jobs';
import { chainPost, insertPost, type PlannedPost } from './planning';
import type {
  BetOutcomeRequest,
  BetRequest,
  BetResult,
  ResolveBetRequest,
  ResolveBetResult,
  TalkResult,
} from './prompts';
import type { OutgoingPoll } from './scheduler';
import type { BetStreaks, BetVote, CrowStore, DueBet } from './store';
import { agoLabel, dateLabel, plural } from './words';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A bet's day is this many days ahead at least, so the cats have time to bet, and three months at most */
export const MIN_BET_DAYS = 2;
export const MAX_BET_DAYS = 92;
/** At most this many bets a week in a chat, and one open at a time */
export const BETS_PER_WEEK = 2;
/** Telegram closes a poll by itself this long after it at most; a bet closing later is stopped by the crow */
const TELEGRAM_POLL_MAX_MS = 2_628_000 * 1000;
const CLOSE_MARGIN_MS = HOUR;
/** A bet is not sent this close to its closing: there would be no time to bet */
export const MIN_BETTING_MS = 12 * HOUR;
/** The outcome of a bet is looked for at noon of the day after its day, when the news has come */
const RESOLVE_HOUR = 12;
/** The owner has this long to say how an unclear bet ended; after it, the bet is called off */
export const OWNER_WAIT_MS = 7 * DAY;
const QUESTION_MAX = 300;
const OPTION_MAX = 100;
export const BET_OPTIONS = { min: 2, max: 4 };
/** What the prompt asks for (prompts.ts), short of Telegram's limits above */
export const BET_ASKED = { question: 200, option: 60 };
const MAX_OUTCOME_LENGTH = 500;
/** Cats in the table of an outcome, the winners first */
const TABLE_ROWS = 15;
const OUTCOME_TTL_MS = 24 * HOUR;
const BETS_INTERVAL_MS = 10 * MINUTE;
/** A bet goes after the arc's first three posts, this long after the post before it */
const BET_AFTER_POSTS = 3;
const BET_GAP = { minMs: 15 * MINUTE, maxMs: 45 * MINUTE };
const NEWS_FACTS = 6;
/** The stems a month is named by in a deadline, «до кінця листопада», «у листопаді» */
const MONTH_STEMS = ['січ', 'лют', 'берез', 'квіт', 'трав', 'черв', 'лип', 'серп', 'верес', 'жовт', 'листопад', 'груд'];

/** Whether a fact names the day of a bet: «19 листопада», or the month when the day is its last, «до кінця листопада» */
export function namesDay(fact: string, day: Temporal.PlainDate): boolean {
  const text = fact.toLowerCase();
  if (text.includes(dateLabel(day))) return true;
  return day.day === day.daysInMonth && text.includes(MONTH_STEMS[day.month - 1]);
}

type ProposedBet = NonNullable<BetResult['bet']>;

/**
 * What is wrong with a bet, in words the model gets back when it rewrites it: its
 * day must be ahead — two days to three months — and named by the fact it cites,
 * so that nothing is made up; the texts are checked as an arc message is.
 */
export function betProblems(bet: ProposedBet, facts: readonly CrowFact[], today: Temporal.PlainDate, allowed: Set<string>): string[] {
  const problems = textProblems(bet.question, allowed, QUESTION_MAX).map((problem) => `question: ${problem}`);
  if (bet.options.length < BET_OPTIONS.min || bet.options.length > BET_OPTIONS.max) {
    problems.push(`варіантів має бути від ${BET_OPTIONS.min} до ${BET_OPTIONS.max}`);
  }
  if (new Set(bet.options).size !== bet.options.length) problems.push('варіанти повторюються');
  for (const option of bet.options) {
    if (!option) problems.push('порожній варіант');
    problems.push(...textProblems(option, allowed, OPTION_MAX).map((problem) => `варіант «${option}»: ${problem}`));
  }
  if (!Number.isInteger(bet.crowPick) || bet.crowPick < 0 || bet.crowPick >= bet.options.length) {
    problems.push('crowPick має бути номером одного з варіантів');
  }
  let day: Temporal.PlainDate | null = null;
  try {
    day = Temporal.PlainDate.from(bet.resolvesOn);
  } catch {
    problems.push(`resolvesOn «${bet.resolvesOn}» — не дата YYYY-MM-DD`);
  }
  if (day) {
    const ahead = today.until(day).days;
    if (ahead < MIN_BET_DAYS || ahead > MAX_BET_DAYS) {
      problems.push(`день події має бути через ${MIN_BET_DAYS}–${MAX_BET_DAYS} днів від сьогодні, а не через ${ahead}`);
    }
    const fact = facts.find((f) => f.id === bet.factId);
    if (!fact) problems.push(`факту ${bet.factId} немає`);
    else if (!namesDay(fact.text, day)) problems.push(`у факті ${bet.factId} немає дня ${dateLabel(day)}`);
  }
  return problems;
}

export interface WrittenBet {
  /** Null when the story has none, or it still failed its checks after the rewrite */
  bet: CrowBet | null;
  attempts: Attempt[];
}

/** Proposes a bet as the arcs are written: an attempt, the checks, one rewrite with the problems listed */
export async function writeBet(
  write: (request: BetRequest) => Promise<Priced<BetResult>>,
  request: BetRequest,
  facts: readonly CrowFact[],
  today: Temporal.PlainDate,
): Promise<WrittenBet> {
  const allowed = allowedNumbers(request.title, ...facts.map((fact) => fact.text));
  const { value: bet, problems, attempts } = await writeChecked(
    write,
    request,
    // A poll takes no markup: an emphasis would show as asterisks
    (result) =>
      result.bet && {
        ...result.bet,
        question: crowPrefix(withoutMarkup(result.bet.question.trim())).text,
        options: result.bet.options.map((option) => withoutMarkup(option.trim())),
      },
    (bet) => (bet ? betProblems(bet, facts, today, allowed) : []),
  );
  return { bet: bet && problems.length === 0 ? bet : null, attempts };
}

/** When the betting of a chat closes — its day begins — and when the outcome is looked for, in the chat's zone */
export function betTimes(resolvesOn: string, timeZone: string): { closesAt: Date; resolvesAt: Date } {
  const day = Temporal.PlainDate.from(resolvesOn);
  return {
    closesAt: new Date(day.toZonedDateTime({ timeZone }).epochMilliseconds),
    resolvesAt: new Date(
      day.add({ days: 1 }).toZonedDateTime({ timeZone, plainTime: new Temporal.PlainTime(RESOLVE_HOUR) }).epochMilliseconds,
    ),
  };
}

/**
 * The poll of a bet: open votes, so the crow knows who bet on what; Telegram
 * closes it by itself within its 30 days, the crow later ones
 */
export function betPoll(bet: CrowBet, closesAt: Date, now: Date): OutgoingPoll {
  const lastDay = Temporal.PlainDate.from(bet.resolvesOn).subtract({ days: 1 });
  return {
    question: bet.question,
    options: bet.options,
    anonymous: false,
    closeDate: closesAt.getTime() - now.getTime() <= TELEGRAM_POLL_MAX_MS - CLOSE_MARGIN_MS ? closesAt : null,
    description: `🐦‍⬛ Ставки — до ${dateLabel(lastDay)} включно. Я ставлю на «${bet.options[bet.crowPick]}».`,
  };
}

/** Puts a bet into a chat's chain of an arc, after its first three posts — the news and its burst */
export function withBet(planned: PlannedPost[], bet: CrowBet, random: Random): PlannedPost[] {
  if (planned.length === 0) return planned;
  const post = chainPost(planned, { kind: 'bet', text: bet.question, mention: null, optional: false }, BET_GAP, random);
  return insertPost(planned, Math.min(BET_AFTER_POSTS, planned.length), post);
}

/**
 * Who bet on what, winners first — a cat each, named as the crow's boldness
 * names cats: mentioned, or by name alone when she is restrained
 */
export function outcomeTable(
  options: readonly string[],
  outcome: number,
  votes: readonly BetVote[],
  boldness: CrowBoldness,
): { table: CrowTable; mentions: Record<string, CrowMention> } {
  const won = (vote: BetVote) => vote.optionIds.includes(outcome);
  const shown = [...votes].sort((a, b) => Number(won(b)) - Number(won(a))).slice(0, TABLE_ROWS);
  const mentions: Record<string, CrowMention> = {};
  const rows = shown.map((vote, i) => {
    mentions[`u${i + 1}`] = { userId: vote.userId, name: vote.name, username: vote.username, ping: BOLDNESS[boldness].pings };
    return [`{cat:u${i + 1}}`, vote.optionIds.map((id) => options[id] ?? '?').join(', '), won(vote) ? '✅' : '❌'];
  });
  return { table: { header: ['Кіт', 'Ставка', ''], rows }, mentions };
}

/** A streak of guessed bets is told from this long, and a streak that broke, from this long */
export const STREAK_FROM = 3;
export const BROKEN_STREAK_FROM = 5;

/** Of bets the latest first: how many in a row came true up to it, and when it missed, how many in a row had before */
export function streak(results: readonly boolean[]): { current: number; broken: number } {
  const run = (from: number) => {
    let n = 0;
    while (results[from + n] === true) n++;
    return n;
  };
  return results[0] === false ? { current: 0, broken: run(1) } : { current: run(0), broken: 0 };
}

/**
 * The outcome's lines of the streaks: each cat's who has one — mentioned as in the table, or added — and the
 * crow's own
 */
export function streakLines(
  streaks: BetStreaks,
  votes: readonly BetVote[],
  mentions: Readonly<Record<string, CrowMention>>,
  boldness: CrowBoldness,
): { lines: string[]; mentions: Record<string, CrowMention> } {
  const all = { ...mentions };
  const lines: string[] = [];
  for (const vote of votes) {
    const { current, broken } = streak(streaks.cats.get(vote.userId) ?? []);
    if (current < STREAK_FROM && broken < BROKEN_STREAK_FROM) continue;
    let key = Object.keys(all).find((id) => all[id].userId === vote.userId);
    if (!key) {
      key = `s${lines.length + 1}`;
      all[key] = { userId: vote.userId, name: vote.name, username: vote.username, ping: BOLDNESS[boldness].pings };
    }
    lines.push(
      current >= STREAK_FROM
        ? `🔥 {cat:${key}}: ${current} ${plural(current, ['ставка', 'ставки', 'ставок'])} поспіль у яблучко.`
        : `💔 {cat:${key}}: серія з ${broken} вгаданих обірвалася.`,
    );
  }
  const own = streak(streaks.crow);
  if (own.current >= STREAK_FROM) lines.push(`🔥 А я вгадала ${own.current} поспіль.`);
  else if (own.broken >= BROKEN_STREAK_FROM) lines.push(`💔 А моя серія з ${own.broken} вгаданих обірвалася.`);
  return { lines, mentions: all };
}

/** What is wrong with a bet's outcome, in words the model gets back when it rewrites it */
export function outcomeProblems(text: string, allowed: Set<string>): string[] {
  const whens = text.split('{when:bet}').length - 1;
  return [
    ...(whens <= 1 ? [] : ['`{when:bet}` — не більше одного разу']),
    ...textProblems(text, allowed, MAX_OUTCOME_LENGTH),
  ];
}

/** Writes a bet's outcome as the arcs are written: an attempt, the checks, one rewrite; null when it still fails */
export function writeOutcome(
  write: (request: BetOutcomeRequest) => Promise<Priced<TalkResult>>,
  request: BetOutcomeRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => outcomeProblems(text, allowed));
}

/** What a bet's outcome is looked for with, and her word on it written by */
export interface BetWriters {
  resolve: (request: ResolveBetRequest) => Promise<Priced<ResolveBetResult>>;
  outcome: (request: BetOutcomeRequest) => Promise<Priced<TalkResult>>;
}

/** Telegram's side of the bets: closing a poll, and asking the owner how an unclear one ended */
export interface BetPolls {
  stop(chatId: string, messageId: number): Promise<unknown>;
  /** False when there is no owner to ask */
  askOwner(bet: DueBet, reason: string): Promise<boolean>;
}

/**
 * The bets (docs/crow/behavior.md#bets): the `bets` job closes a bet's poll when
 * its day begins, and the day after it looks for the outcome in the news of the
 * bet's categories. A sure outcome, or a called-off event, is told as a reply to
 * the poll, with who bet on what; an unclear one goes to the owner, who has a
 * week to say, after which the bet is called off.
 */
export class BetKeeper {
  constructor(
    private readonly store: Pick<
      CrowStore,
      | 'dueBets'
      | 'betById'
      | 'betEvidence'
      | 'betVotes'
      | 'betStreaks'
      | 'optedOut'
      | 'chat'
      | 'settleBet'
      | 'planOutcome'
      | 'askedBet'
    >,
    private readonly write: BetWriters,
    private readonly polls: BetPolls,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return {
      name: 'bets',
      nextRun: (startedAt) => new Date(startedAt.getTime() + BETS_INTERVAL_MS),
      run: async () => {
        const now = this.clock();
        for (const bet of await this.store.dueBets(now, new Date(now.getTime() - OWNER_WAIT_MS))) {
          await this.advance(bet, now).catch((e) =>
            console.error(`${LOG_PREFIX} Bet ${bet.id} in chat ${getLinkChatId(Number(bet.chatId))} failed:`, e),
          );
        }
      },
    };
  }

  /** The owner said how an unclear bet ended: an option, or null to call it off; false when it is not unclear any more */
  async settleByOwner(pollId: number, outcome: number | null): Promise<boolean> {
    const now = this.clock();
    const bet = await this.store.betById(pollId);
    if (!bet || bet.status !== 'asking' || (outcome !== null && (outcome < 0 || outcome >= bet.options.length))) return false;
    await this.settle(bet, outcome, outcome === null ? 'подію скасували або перенесли' : 'це підтвердили', now);
    return true;
  }

  private async advance(bet: DueBet, now: Date) {
    if (bet.status === 'asking') {
      // The owner kept quiet for a week
      await this.settle(bet, null, null, now);
      return;
    }
    if (bet.status === 'open') {
      // Telegram closes a poll of a month by itself; stopping it again only fails, harmlessly
      await this.polls.stop(bet.chatId, bet.tgMessageId).catch(() => undefined);
      await this.store.settleBet(bet.id, 'closed', null, null);
    }
    if (bet.resolvesAt > now) return;
    const news = await this.store.betEvidence(bet.storyId, new Date(bet.createdAt.getTime() - DAY));
    const { result, costUsd } = await this.write.resolve({
      question: bet.question,
      options: bet.options,
      due: `${dateLabel(Temporal.PlainDate.from(bet.resolvesOn))} ${bet.resolvesOn.slice(0, 4)}`,
      event: bet.eventFact,
      news: news.map((item) => ({ title: item.title, facts: item.facts.slice(0, NEWS_FACTS).map((fact) => fact.text) })),
    });
    const chat = getLinkChatId(Number(bet.chatId));
    const valid = result.outcome !== null && result.outcome >= 0 && result.outcome < bet.options.length;
    console.log(
      `${LOG_PREFIX} Bet ${bet.id} in chat ${chat}: ${result.cancelled ? 'called off' : valid ? `option ${result.outcome}` : 'unclear'}` +
        `${result.sure ? '' : ', unsure'} — ${result.reason} ($${costUsd.toFixed(4)})`,
    );
    if (result.sure && result.cancelled) return this.settle(bet, null, result.reason, now);
    if (result.sure && valid) return this.settle(bet, result.outcome, result.reason, now);
    if (await this.polls.askOwner(bet, result.reason)) {
      await this.store.askedBet(bet.id);
      return;
    }
    await this.settle(bet, null, null, now);
  }

  /**
   * Tells the chat how the bet ended, as a reply to its poll: the option that won and who guessed it, or
   * that it is called off — `reason` null when nobody could tell, in a word of the crow's own
   */
  private async settle(bet: DueBet, outcome: number | null, reason: string | null, now: Date) {
    await this.store.settleBet(bet.id, outcome === null ? 'void' : 'resolved', outcome, now);
    const optedOut = await this.store.optedOut(bet.chatId);
    const votes = (await this.store.betVotes(bet.id)).filter((vote) => !optedOut.has(vote.userId));
    const betAgo = agoLabel(now.getTime() - bet.createdAt.getTime());
    const extras: CrowPostExtras = {
      moments: { bet: { unixTime: Math.floor(bet.createdAt.getTime() / 1000), format: 'r', fallback: betAgo } },
    };
    let text: string;
    if (reason === null) {
      text = `🐦‍⬛ Ставку «${withoutCrows(bet.question)}» знімаю: навіть сорока не знає, чим усе скінчилося.`;
    } else {
      const won = (vote: BetVote) => outcome !== null && vote.optionIds.includes(outcome);
      const request: BetOutcomeRequest = {
        question: bet.question,
        outcome: outcome === null ? null : bet.options[outcome],
        reason,
        crowPick: bet.options[bet.crowPick] ?? '',
        crowWon: outcome !== null && outcome === bet.crowPick,
        winners: votes.filter(won).map((vote) => vote.name),
        losers: votes.filter((vote) => !won(vote)).map((vote) => vote.name),
        maxLength: MAX_OUTCOME_LENGTH,
      };
      const allowed = allowedNumbers(bet.question, reason, ...bet.options);
      const written = await writeOutcome(this.write.outcome, request, allowed);
      text =
        written.text ??
        (outcome === null
          ? `🐦‍⬛ Ставку «${bet.question}» анульовано: ${reason}.`
          : `🐦‍⬛🐦‍⬛ Ставка зіграла: «${bet.options[outcome]}».`);
      if (outcome !== null) {
        const { boldness } = await this.store.chat(bet.chatId);
        if (votes.length > 0) Object.assign(extras, outcomeTable(bet.options, outcome, votes, boldness));
        // This bet is settled already, so it counts in the streaks
        const streaks = await this.store.betStreaks(bet.chatId, votes.map((vote) => vote.userId));
        const told = streakLines(streaks, votes, extras.mentions ?? {}, boldness);
        if (told.lines.length > 0) {
          text = [text, ...told.lines].join('\n');
          extras.mentions = told.mentions;
        }
      }
    }
    await this.store.planOutcome(bet.chatId, {
      storyId: bet.storyId,
      text,
      extras,
      replyToMessageId: String(bet.tgMessageId),
      notBefore: now,
      expiresAt: new Date(now.getTime() + OUTCOME_TTL_MS),
    });
    console.log(`${LOG_PREFIX} Bet ${bet.id} in chat ${getLinkChatId(Number(bet.chatId))} settled: ${outcome ?? 'called off'}`);
  }
}
