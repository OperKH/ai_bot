/**
 * The chat's own clock: quiet hours and days are counted in its time zone, with
 * Temporal, so a change to winter time moves nothing by an hour.
 */

/** `at` on the chat's clock */
export function zoned(at: Date, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timeZone);
}

/** The chat's date at `at` */
export function localDate(at: Date, timeZone: string): Temporal.PlainDate {
  return zoned(at, timeZone).toPlainDate();
}

/** The moment `minutes` after midnight of a date in the chat's zone, in milliseconds */
export function localMoment(date: Temporal.PlainDate, minutes: number, timeZone: string): number {
  const plainTime = new Temporal.PlainTime(Math.floor(minutes / 60), minutes % 60);
  return date.toZonedDateTime({ timeZone, plainTime }).epochMilliseconds;
}

/** Minutes after midnight in the zone */
export function minutesOfDay(at: Date, timeZone: string): number {
  const time = zoned(at, timeZone);
  return time.hour * 60 + time.minute;
}

/**
 * Whether `at` falls into the quiet hours `from`–`to` (minutes after midnight).
 * The range may cross midnight, as 23:00–10:00 does; null means no quiet hours.
 */
export function isQuiet(at: Date, timeZone: string, from: number | null, to: number | null): boolean {
  if (from === null || to === null || from === to) return false;
  const minutes = minutesOfDay(at, timeZone);
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The local midnight the day of `at` began with */
export function startOfDay(at: Date, timeZone: string): Date {
  return new Date(zoned(at, timeZone).startOfDay().epochMilliseconds);
}

/** The local midnight the day of `at` ends with */
export function endOfDay(at: Date, timeZone: string): Date {
  return new Date(zoned(at, timeZone).startOfDay().add({ days: 1 }).epochMilliseconds);
}

/** `HH:MM` of minutes after midnight */
export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
