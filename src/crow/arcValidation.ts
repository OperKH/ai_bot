import type { CrowTable } from '../entity/CrowStoryMessage.entity';

/** A message of an arc as the model wrote it */
export interface DraftMessage {
  kind: string;
  crows: number;
  text: string;
  optional: boolean;
  factIds: string[];
  table: CrowTable | null;
}

const CROW = '🐦‍⬛';
/**
 * The limits of an arc's messages, which the prompt states as they are (prompts.ts): the chat hates walls of text,
 * and the opening, which tells the news in full with its picture, may run longer — the outline asks for about
 * OPENING_LENGTH of it (arcOutline.ts), and this lets a margin through
 */
export const MAX_POST_LENGTH = 1200;
export const MAX_OPENING_LENGTH = 2500;
export const TABLE_COLUMNS = { min: 2, max: 4 };
export const MAX_TABLE_ROWS = 8;
/** A count a text may use without a fact giving it: «удвічі», «у 3 рази» */
export const MAX_FREE_NUMBER = 10;
const NUMBER = /\d+(?:[.,]\d+)?/g;
/** A time of day: the reader's zone is not the crow's, so times go as `{when:…}` only */
const TIME_OF_DAY = /(?<!\d)\d{1,2}:\d{2}(?!\d)/;
/**
 * Politics, war and slurs the crow never jokes about. Whole words or stems,
 * matched against letters around, since `\b` does not see Cyrillic.
 */
const FORBIDDEN = new RegExp(
  `(?<!\\p{L})(${[
    'путін\\p{L}*',
    'путин\\p{L}*',
    'москал\\p{L}*',
    'кацап\\p{L}*',
    'хохол',
    'хохл(и|ів|ам|ами|а|у)',
    'рашист\\p{L}*',
    'підор\\p{L}*',
    'пидор\\p{L}*',
    // Whole words: «педикюр» and «трамплін» are fine
    'педик(и|ів|а|ом)?',
    'нігер\\p{L}*',
    'ниггер\\p{L}*',
    'жид(и|ів|а|ом)?',
    'зеленськ\\p{L}*',
    'зеленск\\p{L}*',
    'трамп(а|у|ом|і|ові)?',
  ].join('|')})(?!\\p{L})`,
  'iu',
);

/**
 * The crows in front of a text, which make its `crows`: the model writes the
 * prefix, and counting it is surer than asking for the number too — the two
 * disagreed in half the messages. No crow gets one; more than three are cut.
 */
export function crowPrefix(text: string): { crows: number; text: string } {
  const match = /^((?:🐦‍⬛\s*)+)/u.exec(text.trimStart());
  const body = text.trimStart().slice(match?.[1].length ?? 0).trimStart();
  const crows = Math.min(3, Math.max(1, match ? match[1].split(CROW).length - 1 : 1));
  return { crows, text: `${CROW.repeat(crows)} ${body}` };
}

/** A text without the crows in front of it, for a line where they would stand in the middle */
export function withoutCrows(text: string): string {
  return text.replace(/^(?:🐦‍⬛\s*)+/u, '');
}

/** What is wrong with a text that names `placeholder` other than once, in words the model gets back */
export function placeholderProblems(text: string, placeholder: string): string[] {
  const count = text.split(placeholder).length - 1;
  return count === 1 ? [] : [`\`${placeholder}\` має бути в тексті рівно один раз, а не ${count}`];
}

/** The numbers of a text as values: `1,3` and `1.3` are one number, `05` is `5` */
function numbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(',', '.').replace(/^0+(?=\d)/, ''));
}

/**
 * The numbers an arc may use: those of its facts and of the texts given (the
 * title, the roster of competitors), and small counts such as «двічі» written
 * as digits.
 */
export function allowedNumbers(...texts: string[]): Set<string> {
  const allowed = new Set<string>(Array.from({ length: MAX_FREE_NUMBER + 1 }, (_, i) => String(i)));
  for (const text of texts) for (const n of numbers(text)) allowed.add(n);
  return allowed;
}

/**
 * What is wrong with a message of an arc, in words the model gets back when it
 * rewrites it (so in Ukrainian). The cheap checks that catch most made-up facts:
 * every number must come from the facts.
 */
export function messageProblems(message: DraftMessage, allowed: Set<string>, factIds: Set<string>): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(message.crows) || message.crows < 1 || message.crows > 3) {
    problems.push('crows має бути 1, 2 або 3');
  } else {
    const prefix = CROW.repeat(message.crows);
    if (!message.text.startsWith(prefix) || message.text.startsWith(prefix + CROW)) {
      problems.push(`текст має починатися рівно з ${message.crows} 🐦‍⬛`);
    }
  }
  const maxLength = message.kind === 'breaking' ? MAX_OPENING_LENGTH : MAX_POST_LENGTH;
  if (message.text.length > maxLength) problems.push(`довше за ${maxLength} символів`);
  if (TIME_OF_DAY.test(message.text)) problems.push('час доби цифрами заборонений');
  if (FORBIDDEN.test(message.text)) problems.push('заборонена тема: політика, війна чи образи');

  const cells = message.table ? [...message.table.header, ...message.table.rows.flat()] : [];
  if (message.table) {
    const width = message.table.header.length;
    if (width < TABLE_COLUMNS.min || width > TABLE_COLUMNS.max) {
      problems.push(`таблиця має мати від ${TABLE_COLUMNS.min} до ${TABLE_COLUMNS.max} колонок`);
    }
    if (message.table.rows.length === 0 || message.table.rows.length > MAX_TABLE_ROWS) {
      problems.push(`таблиця має мати від 1 до ${MAX_TABLE_ROWS} рядків`);
    }
    if (message.table.rows.some((row) => row.length !== width)) problems.push('рядки таблиці не збігаються з заголовком');
    if (cells.some((cell) => FORBIDDEN.test(cell))) problems.push('заборонена тема в таблиці');
  }
  for (const n of new Set(numbers([message.text, ...cells].join(' ')))) {
    if (!allowed.has(n)) problems.push(`числа ${n} немає у фактах`);
  }
  for (const id of message.factIds) {
    if (!factIds.has(id)) problems.push(`факту ${id} немає`);
  }
  return problems;
}

/**
 * What is wrong with a text the crow says outside an arc, such as the morning
 * digest, by the rules of an arc message: no time of day in digits, no forbidden
 * topic, every number from the data it was given.
 */
export function textProblems(text: string, allowed: Set<string>, maxLength: number): string[] {
  const problems: string[] = [];
  if (text.length > maxLength) problems.push(`довше за ${maxLength} символів`);
  if (TIME_OF_DAY.test(text)) problems.push('час доби цифрами заборонений');
  if (FORBIDDEN.test(text)) problems.push('заборонена тема: політика, війна чи образи');
  for (const n of new Set(numbers(text))) {
    if (!allowed.has(n)) problems.push(`числа ${n} немає у фактах`);
  }
  return problems;
}

/** A call of the model, with what the checks found in its answer */
export interface Attempt {
  costUsd: number;
  problems: string[];
}

/**
 * The way every text of the crow is written, as the arcs are: an attempt, the checks, one rewrite with the
 * problems listed. `read` gives what is checked of an answer; the checks find nothing in an answer the model
 * declined, which is not rewritten. The last answer comes back with its problems, for the caller to keep or drop.
 */
export async function writeChecked<Request extends { corrections?: string[] }, Result, Value>(
  write: (request: Request) => Promise<{ result: Result; costUsd: number }>,
  request: Request,
  read: (result: Result) => Value,
  check: (value: Value) => string[],
): Promise<{ value: Value; problems: string[]; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const attempt = async (corrections?: string[]) => {
    const { result, costUsd } = await write(corrections ? { ...request, corrections } : request);
    const value = read(result);
    const problems = check(value);
    attempts.push({ costUsd, problems });
    return { value, problems };
  };
  let { value, problems } = await attempt();
  if (problems.length > 0) ({ value, problems } = await attempt(problems));
  return { value, problems, attempts };
}

export interface WrittenText {
  /** Null when it still failed the checks after the rewrite */
  text: string | null;
  attempts: Attempt[];
}

/** A text of hers, written that way, with her crow in front */
export async function writeText<Request extends { corrections?: string[] }>(
  write: (request: Request) => Promise<{ result: { text: string }; costUsd: number }>,
  request: Request,
  check: (text: string) => string[],
): Promise<WrittenText> {
  const read = (result: { text: string }) => crowPrefix(result.text.trim()).text;
  const { value, problems, attempts } = await writeChecked(write, request, read, check);
  return { text: problems.length === 0 ? value : null, attempts };
}

/** What the attempts of a text cost together */
export function attemptsCost(attempts: readonly Attempt[]): number {
  return attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
}

export interface ArcCheck {
  /** 1-based, as the model numbers the messages */
  number: number;
  problems: string[];
}

/** The messages of an arc that have problems */
export function arcProblems(messages: DraftMessage[], allowed: Set<string>, factIds: Set<string>): ArcCheck[] {
  return messages
    .map((message, i) => ({ number: i + 1, problems: messageProblems(message, allowed, factIds) }))
    .filter((check) => check.problems.length > 0);
}
