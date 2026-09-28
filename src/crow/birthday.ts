import { getLinkChatId, supergroupMessageLink } from '../bot/telegramLinks';
import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowMention, CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';
import {
  allowedNumbers,
  attemptsCost,
  MAX_TABLE_ROWS,
  textProblems,
  writeText,
  type WrittenText,
} from './arcValidation';
import { BOLDNESS } from './cadence';
import { localDate, zoned } from './chatClock';
import type { Priced } from './crowLlm';
import { type CrowJobDefinition, oncePerChat } from './jobs';
import type { BirthdayRequest, TalkResult } from './prompts';
import type { CrowStore, CrowYearData } from './store';
import { storyName } from './weekly';
import { memoryLine, monthLabel, plural } from './words';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOG_PREFIX = '[Crow]';
/**
 * The crow's birthday in a chat (docs/crow/behavior.md#birthday): the day of her first post there, every year, at this
 * time of the chat's zone — her year there, like the year's reviews of the services, and the cats' awards
 */
export const BIRTHDAY_TIME = { hour: 12, minute: 34 };
/** A chat whose moment passed while the bot was down still gets it this long after */
const BIRTHDAY_GRACE_MS = 3 * HOUR;
const BIRTHDAY_INTERVAL_MS = 5 * MINUTE;
const BIRTHDAY_TTL_MS = 12 * HOUR;
export const MAX_BIRTHDAY_LENGTH = 400;
const MEMORY_POSTS = 10;
/** A hero of one story is no hero of the year */
const MIN_HERO_STORIES = 2;

const years = (n: number) => `${n} ${plural(n, ['рік', 'роки', 'років'])}`;
const FALLBACK_WORD = (n: number) => `🐦‍⬛🐦‍⬛ ${years(n)} тому я вперше каркнула в цьому чаті. Ось що з того вийшло.`;

/** Her birthday's moment `now` falls into in the chat's zone, and how old she is there, or null */
export function birthdayDue(now: Date, timeZone: string, firstPostAt: Date): { due: Date; years: number } | null {
  const born = localDate(firstPostAt, timeZone);
  const today = localDate(now, timeZone);
  const age = today.year - born.year;
  // Born on the 29th of February, she has it on the 28th in the other years
  if (age < 1 || !born.with({ year: today.year }).equals(today)) return null;
  const due = today.toZonedDateTime({ timeZone, plainTime: BIRTHDAY_TIME }).epochMilliseconds;
  return now.getTime() >= due && now.getTime() < due + BIRTHDAY_GRACE_MS ? { due: new Date(due), years: age } : null;
}

/** Her year in a chat, counted from the store's rows */
export interface CrowYear {
  stories: number;
  crows: number;
  hero: { name: string; stories: number } | null;
  busiestMonth: { month: number; stories: number } | null;
  rumors: { told: number; confirmed: number };
  told: number;
  bets: { total: number; crowWins: number };
  streams: number;
  quizzes: number;
  /** The story the cats replied to most */
  newsOfTheYear: { name: string; replies: number; tgMessageId: string | null } | null;
  /** The weekly vote's winner with the most votes */
  voted: { name: string; votes: number } | null;
}

/** The figures of her year: the months counted in the chat's zone */
export function summarizeYear(data: CrowYearData, timeZone: string): CrowYear {
  const count = <K>(keys: K[]) => {
    const counts = new Map<K, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0] ?? null;
  };
  const hero = count(data.stories.flatMap((story) => (story.hero ? [story.hero] : [])));
  const month = count(data.stories.map((story) => zoned(story.sentAt, timeZone).month));
  const discussed = [...data.stories].sort((a, b) => b.replies - a.replies)[0];
  const voted = [...data.votes].sort((a, b) => b.votes - a.votes)[0];
  const votedStory = voted && data.stories.find((story) => story.storyId === voted.storyId);
  const rumors = data.stories.filter((story) => story.isRumor);
  return {
    stories: data.stories.length,
    crows: data.crows,
    hero: hero && hero[1] >= MIN_HERO_STORIES ? { name: hero[0], stories: hero[1] } : null,
    busiestMonth: month && { month: month[0], stories: month[1] },
    rumors: { told: rumors.length, confirmed: rumors.filter((story) => story.confirmed).length },
    told: data.kinds.told ?? 0,
    bets: data.bets,
    streams: data.kinds.event ?? 0,
    quizzes: data.kinds.quiz ?? 0,
    newsOfTheYear:
      discussed && discussed.replies > 0 ? { name: storyName(discussed), replies: discussed.replies, tgMessageId: discussed.tgMessageId } : null,
    voted: votedStory ? { name: storyName(votedStory), votes: voted.votes } : null,
  };
}

/** Her year as the table shows it, the telling rows first, as many as a table of hers holds */
export function yearRows(year: CrowYear): [string, string][] {
  const rows: ([string, string] | null)[] = [
    ['Новин', String(year.stories)],
    ['Прокаркано 🐦‍⬛', String(year.crows)],
    year.hero && ['Мій герой', `${year.hero.name} — ${year.hero.stories}`],
    year.busiestMonth && ['Найгарячіший місяць', `${monthLabel(year.busiestMonth.month)} — ${year.busiestMonth.stories}`],
    year.rumors.told > 0 ? ['Чуток / справдилося', `${year.rumors.told} / ${year.rumors.confirmed}`] : null,
    year.told > 0 ? ['«Я ж казала»', String(year.told)] : null,
    year.bets.total > 0 ? ['Ставок / я вгадала', `${year.bets.total} / ${year.bets.crowWins}`] : null,
    year.streams > 0 ? ['Ефірів', String(year.streams)] : null,
    year.quizzes > 0 ? ['Вікторин', String(year.quizzes)] : null,
  ];
  return rows.filter((row) => row !== null).slice(0, MAX_TABLE_ROWS);
}

/** A cat's award of the year: the post's line with the cat in it, and the prompt's line without */
export interface Award {
  mention: CrowMention;
  line: (cat: string) => string;
}

export type CatNames = Map<string, { name: string; username: string | null }>;

/** The cats' awards of the year; a cat whose name Telegram no longer gives — gone from the chat — gets none */
export function yearAwards(data: CrowYearData, names: CatNames, boldness: CrowBoldness): Award[] {
  const ping = BOLDNESS[boldness].pings;
  const award = (userId: string, known: { name: string; username: string | null } | undefined, line: Award['line']) =>
    known ? [{ mention: { userId, name: known.name, username: known.username, ping }, line }] : [];
  return [
    ...(data.talker
      ? award(data.talker.userId, names.get(data.talker.userId), (cat) => {
          const n = data.talker!.count;
          return `🗣 Найбалакучіший — ${cat}: ${n} ${plural(n, ['розмова', 'розмови', 'розмов'])} зі мною.`;
        })
      : []),
    ...(data.shooer
      ? award(data.shooer.userId, names.get(data.shooer.userId), (cat) => {
          const n = data.shooer!.count;
          return `🔇 Головний по «Кш!» — ${cat}: ${n} ${plural(n, ['раз', 'рази', 'разів'])}.`;
        })
      : []),
    ...(data.target
      ? award(data.target.userId, data.target, (cat) => {
          const n = data.target!.count;
          return `🎯 Улюблена мішень — ${cat}: ${n} ${plural(n, ['підколка', 'підколки', 'підколок'])}.`;
        })
      : []),
    ...(data.bettor
      ? award(data.bettor.userId, { name: data.bettor.name, username: null }, (cat) => {
          const { wins, bets } = data.bettor!;
          return `🔮 Провидець року — ${cat}: ${wins} з ${bets} ${plural(bets, ['ставки', 'ставок', 'ставок'])}.`;
        })
      : []),
  ];
}

/** The lines under her word: the cats' awards, the news of the year and the cats' choice */
function yearLines(chatId: string, year: CrowYear, awards: Award[], anchors: NonNullable<CrowPostExtras['anchors']>): string[] {
  const lines = awards.map((award, i) => award.line(`{cat:u${i + 1}}`));
  if (year.newsOfTheYear) {
    const { name, replies, tgMessageId } = year.newsOfTheYear;
    // A link to her post works in a supergroup; a basic group gets the name alone
    const url = supergroupMessageLink(chatId, tgMessageId);
    if (url) anchors.n1 = { label: name, url };
    const shown = url ? '{link:n1}' : `**${name}**`;
    lines.push(`📰 Новина року — ${shown}: ${replies} ${plural(replies, ['відповідь', 'відповіді', 'відповідей'])} котів.`);
  }
  if (year.voted) {
    const { name, votes } = year.voted;
    lines.push(`🗳 Рекорд тижневих голосувань — **${name}**: ${votes} ${plural(votes, ['голос', 'голоси', 'голосів'])}.`);
  }
  return lines;
}

/** The birthday as a post: the heading, her word, the awards and the news of the year, and the table of her year */
export function birthdayContent(input: {
  chatId: string;
  years: number;
  year: CrowYear;
  awards: Award[];
  word: string | null;
}): { text: string; extras: CrowPostExtras } {
  const anchors: NonNullable<CrowPostExtras['anchors']> = {};
  const lines = [input.word ?? FALLBACK_WORD(input.years), ...yearLines(input.chatId, input.year, input.awards, anchors)];
  const table: CrowTable = { header: ['Мій рік', ''], rows: yearRows(input.year) };
  const mentions = Object.fromEntries(input.awards.map((award, i) => [`u${i + 1}`, award.mention]));
  return {
    text: lines.join('\n'),
    extras: { heading: `🎂 ${years(input.years)} у цьому чаті`, table, anchors, mentions },
  };
}

/** Writes her word as the other texts are written: an attempt, the checks, one rewrite with the problems listed */
export function writeBirthday(
  write: (request: BirthdayRequest) => Promise<Priced<TalkResult>>,
  request: BirthdayRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => textProblems(text, allowed, request.maxLength));
}

/** The names of cats by their ids, as Telegram gives them now; a cat gone from the chat is left out */
export type CatNamesPort = (chatId: string, userIds: string[]) => Promise<CatNames>;

/**
 * Her birthday in every chat she posts in: on the day of her first post there, a year on and every year after,
 * at 12:34 of the chat's zone, a post of her year there — the figures, the news of the year and the cats' awards.
 * A year she brought the chat no news goes without.
 */
export class Birthdays {
  constructor(
    private readonly store: Pick<CrowStore, 'birthdayChats' | 'plannedSince' | 'crowYear' | 'recentPosts' | 'planBirthday'>,
    private readonly write: (request: BirthdayRequest) => Promise<Priced<TalkResult>>,
    private readonly names: CatNamesPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return oncePerChat({
      name: 'birthday',
      intervalMs: BIRTHDAY_INTERVAL_MS,
      clock: this.clock,
      chats: () => this.store.birthdayChats(),
      moment: (chat, now) => birthdayDue(now, chat.timeZone, chat.firstPostAt),
      at: (birthday) => birthday.due,
      keepMs: BIRTHDAY_GRACE_MS,
      prepare: (chat, birthday, now) => this.prepare(chat, chat.timeZone, birthday, now),
      failed: 'Birthday in chat',
    });
  }

  private async prepare(
    chat: { chatId: string; boldness: CrowBoldness },
    timeZone: string,
    birthday: { due: Date; years: number },
    now: Date,
  ) {
    const { chatId } = chat;
    if (await this.store.plannedSince(chatId, 'birthday', new Date(birthday.due.getTime() - BIRTHDAY_GRACE_MS))) return;
    const yearAgo = zoned(birthday.due, timeZone).subtract({ years: 1 });
    const data = await this.store.crowYear(chatId, new Date(yearAgo.epochMilliseconds), birthday.due);
    if (data.stories.length === 0) return;
    const year = summarizeYear(data, timeZone);
    const asked = [data.talker?.userId, data.shooer?.userId].filter((id) => id !== undefined);
    const awards = yearAwards(data, asked.length > 0 ? await this.names(chatId, asked) : new Map(), chat.boldness);

    const recentPosts = (await this.store.recentPosts(chatId, MEMORY_POSTS)).map((post) => memoryLine(post, now));
    const request: BirthdayRequest = {
      years: birthday.years,
      year: yearRows(year).map(([what, value]) => `${what}: ${value}`),
      awards: awards.map((award) => award.line('кіт')),
      recentPosts,
      maxLength: MAX_BIRTHDAY_LENGTH,
    };
    const allowed = allowedNumbers(String(birthday.years), ...request.year, ...request.awards, ...recentPosts);
    const written = await writeBirthday(this.write, request, allowed);
    const costUsd = attemptsCost(written.attempts);
    const link = getLinkChatId(Number(chatId));
    if (written.text === null) {
      console.warn(
        `${LOG_PREFIX} The birthday word for chat ${link} failed its checks, a plain one goes:\n  ` + written.attempts.at(-1)!.problems.join('\n  '),
      );
    }
    const { text, extras } = birthdayContent({ chatId, years: birthday.years, year, awards, word: written.text });
    await this.store.planBirthday(chatId, { text, extras, notBefore: now, expiresAt: new Date(birthday.due.getTime() + BIRTHDAY_TTL_MS) });
    console.log(`${LOG_PREFIX} Birthday ${birthday.years} planned in chat ${link}: ${year.stories} stories, ${awards.length} awards ($${costUsd.toFixed(4)})`);
  }
}
