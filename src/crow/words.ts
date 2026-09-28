import { localDate } from './chatClock';

/** The form of a Ukrainian noun after a count: «1 день», «2 дні», «5 днів», «11 днів», «21 день» */
export function plural(count: number, forms: readonly [one: string, few: string, many: string]): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return forms[0];
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return forms[1];
  return forms[2];
}

/** «52 дні», «1 день» */
export const daysLabel = (days: number) => `${days} ${plural(days, ['день', 'дні', 'днів'])}`;

/**
 * How long ago something was, as the crow would say it: «щойно», «20 хв тому», «3 год тому», «вчора»,
 * «5 днів тому». The models get the crow's past in these words: a date means nothing to them, since they
 * are not told what day it is.
 */
export function agoLabel(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'щойно';
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'вчора' : `${daysLabel(days)} тому`;
}

/** How the crow names a cat: by its first name, else its username, else its id */
export function catName(
  firstName: string | null | undefined,
  username: string | null | undefined,
  id: string | number,
): string {
  return firstName?.trim() || username || `кіт ${id}`;
}

/** A post of hers as the models get her memory: «(5 днів тому) the text» */
export function memoryLine(post: { sentAt: Date; text: string }, now: Date): string {
  return `(${agoLabel(now.getTime() - post.sentAt.getTime())}) ${post.text}`;
}

/** How long until something, as the crow would say it: «через 20 хв», «через 23 год», «через 3 дні» */
export function inLabel(leftMs: number): string {
  const minutes = Math.max(1, Math.round(leftMs / 60_000));
  if (minutes < 60) return `через ${minutes} хв`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `через ${hours} год`;
  const days = Math.round(hours / 24);
  return `через ${daysLabel(days)}`;
}

const ON_WEEKDAY = ['у понеділок', 'у вівторок', 'у середу', 'у четвер', "у п'ятницю", 'у суботу', 'у неділю'] as const;
const MONTHS_OF = [
  'січня',
  'лютого',
  'березня',
  'квітня',
  'травня',
  'червня',
  'липня',
  'серпня',
  'вересня',
  'жовтня',
  'листопада',
  'грудня',
] as const;

/**
 * The day of `at` as the crow would name it on `now`, in the chat's zone: «сьогодні», «учора», «у вівторок».
 * A past day goes in words rather than as a `date_time`: to a day the reader's zone hardly matters, and a
 * `date_time` offers to add itself to the calendar with the whole message in it.
 */
export function dayLabel(at: Date, now: Date, timeZone: string): string {
  const then = localDate(at, timeZone);
  const days = then.until(localDate(now, timeZone)).days;
  if (days === 0) return 'сьогодні';
  if (days === 1) return 'учора';
  return ON_WEEKDAY[then.dayOfWeek - 1];
}

/** The month a date falls in, as Ukrainian says it after a day: «жовтня» */
export const monthOfLabel = (month: number) => MONTHS_OF[month - 1];

const MONTHS = [
  'січень',
  'лютий',
  'березень',
  'квітень',
  'травень',
  'червень',
  'липень',
  'серпень',
  'вересень',
  'жовтень',
  'листопад',
  'грудень',
] as const;

/** A month by its name: «жовтень» */
export const monthLabel = (month: number) => MONTHS[month - 1];

/** A date as Ukrainian says it: «19 листопада» */
export function dateLabel(date: Temporal.PlainDate): string {
  return `${date.day} ${MONTHS_OF[date.month - 1]}`;
}

/** A date with its year, as a request tells the model today: «28 вересня 2026» */
export function yearDateLabel(date: Temporal.PlainDate): string {
  return `${dateLabel(date)} ${date.year}`;
}

const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'] as const;

/** A date with its weekday, as a table of days shows it: «вт, 29 вересня» */
export function weekdayDateLabel(date: Temporal.PlainDate): string {
  return `${WEEKDAY_SHORT[date.dayOfWeek - 1]}, ${dateLabel(date)}`;
}
