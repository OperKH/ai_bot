/**
 * The zones /timezone offers and the names it keeps, apart from the command so
 * that other features — the crow's menu — can show a zone without grammY or
 * TypeORM.
 */

/** The zone of a chat that has not set one with /timezone: the bot does not guess where a chat lives */
export const FALLBACK_TIME_ZONE = 'UTC';

/**
 * The zones offered as buttons, by region. Telegram allows 100 buttons a message
 * and America alone has some 150 zones, so this is a pick of common ones; any
 * other zone can still be typed: `/timezone Pacific/Tahiti`.
 */
export const REGIONS: { name: string; zones: [zone: string, city: string][] }[] = [
  {
    name: '🇪🇺 Європа',
    zones: [
      ['Europe/Kyiv', 'Київ'],
      ['Europe/Warsaw', 'Варшава'],
      ['Europe/Berlin', 'Берлін'],
      ['Europe/Prague', 'Прага'],
      ['Europe/Vienna', 'Відень'],
      ['Europe/Rome', 'Рим'],
      ['Europe/Paris', 'Париж'],
      ['Europe/Madrid', 'Мадрид'],
      ['Europe/Amsterdam', 'Амстердам'],
      ['Europe/London', 'Лондон'],
      ['Europe/Dublin', 'Дублін'],
      ['Europe/Lisbon', 'Лісабон'],
      ['Europe/Stockholm', 'Стокгольм'],
      ['Europe/Helsinki', 'Гельсінкі'],
      ['Europe/Riga', 'Рига'],
      ['Europe/Vilnius', 'Вільнюс'],
      ['Europe/Tallinn', 'Таллінн'],
      ['Europe/Bucharest', 'Бухарест'],
      ['Europe/Chisinau', 'Кишинів'],
      ['Europe/Athens', 'Афіни'],
      ['Europe/Istanbul', 'Стамбул'],
    ],
  },
  {
    name: '🌎 Америка',
    zones: [
      ['America/New_York', 'Нью-Йорк'],
      ['America/Toronto', 'Торонто'],
      ['America/Chicago', 'Чикаго'],
      ['America/Denver', 'Денвер'],
      ['America/Los_Angeles', 'Лос-Анджелес'],
      ['America/Vancouver', 'Ванкувер'],
      ['America/Mexico_City', 'Мехіко'],
      ['America/Sao_Paulo', 'Сан-Паулу'],
      ['America/Argentina/Buenos_Aires', 'Буенос-Айрес'],
    ],
  },
  {
    name: '🌏 Азія',
    zones: [
      ['Asia/Tbilisi', 'Тбілісі'],
      ['Asia/Yerevan', 'Єреван'],
      ['Asia/Baku', 'Баку'],
      ['Asia/Jerusalem', 'Єрусалим'],
      ['Asia/Dubai', 'Дубай'],
      ['Asia/Tashkent', 'Ташкент'],
      ['Asia/Almaty', 'Алмати'],
      ['Asia/Kolkata', 'Делі'],
      ['Asia/Bangkok', 'Бангкок'],
      ['Asia/Singapore', 'Сінгапур'],
      ['Asia/Shanghai', 'Шанхай'],
      ['Asia/Seoul', 'Сеул'],
      ['Asia/Tokyo', 'Токіо'],
    ],
  },
  {
    name: '🌍 Інші',
    zones: [
      ['Africa/Cairo', 'Каїр'],
      ['Africa/Johannesburg', 'Йоганнесбург'],
      ['Australia/Sydney', 'Сідней'],
      ['Pacific/Auckland', 'Окленд'],
      ['UTC', 'UTC'],
    ],
  },
];

/**
 * The name to store for a zone as typed, or null if there is no such zone. ICU
 * knows the current names (Europe/Kyiv) but reports the old ones (Europe/Kiev),
 * so the buttons' names come first, then ICU's list for the letter case, then
 * the name as typed if ICU accepts it.
 */
export function timeZoneName(typed: string): string | null {
  const lower = typed.toLowerCase();
  const known = [...REGIONS.flatMap((r) => r.zones.map(([zone]) => zone)), ...Intl.supportedValuesOf('timeZone')];
  const found = known.find((zone) => zone.toLowerCase() === lower);
  if (found) return found;
  try {
    new Intl.DateTimeFormat('en', { timeZone: typed });
    return typed;
  } catch {
    return null;
  }
}

/** A zone as a button shows it: its city if /timezone has a button for it, else the last part of its name */
export function zoneLabel(timeZone: string): string {
  const city = REGIONS.flatMap((region) => region.zones).find(([zone]) => zone === timeZone)?.[1];
  return city ?? timeZone.split('/').at(-1)!.replaceAll('_', ' ');
}
