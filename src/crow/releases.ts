import { getLinkChatId } from '../bot/telegramLinks';
import type { CrowPostExtras } from '../entity/CrowPost.entity';
import { allowedNumbers, type Attempt, MAX_TABLE_ROWS, textProblems, writeText } from './arcValidation';
import { endOfDay, isQuiet, zoned } from './chatClock';
import type { Priced } from './crowLlm';
import type { CrowJobDefinition } from './jobs';
import { gameKey, type NintendoRelease } from './sources/nintendoStore';
import type { RadarRequest, ReleasesResult, TalkResult } from './prompts';
import type { CrowStore } from './store';
import { dateLabel, weekdayDateLabel } from './words';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LOG_PREFIX = '[Crow]';
const RADAR_INTERVAL_MS = 30 * MINUTE;
/** The radar comes on Monday, from this hour of the chat's zone */
export const RADAR_HOUR = 11;
/** The roundups of the week come out on the days before it: those of this long before its Monday are read */
const ROUNDUPS_BEFORE_MS = 5 * DAY;
const MATERIALS_MAX = 12_000;
const MATERIALS_SEPARATOR = '\n\n---\n\n';
/** A table of the crow's rows at most, as an arc's */
export const RADAR_ROWS = MAX_TABLE_ROWS;
/** The store's games of the week the model reads at most, the most downloaded and pre-ordered first */
const NINTENDO_READ = 40;
/** The releases the prompt asks for (prompts.ts): more than the rows, since some fall outside the week */
export const RELEASES_ASKED = 10;
export const MAX_RADAR_LENGTH = 300;
const FALLBACK_INTRO = '🐦‍⬛🐦‍⬛ Що виходить цього тижня:';

/**
 * The roundups of the next week's releases, by source, and the platforms each is about — the model cannot tell
 * that a game of Push Square's guide comes to the PlayStation: Push Square's and Pure Xbox's weekly guides give the
 * biggest games of the week in their lead, Xbox Wire's «Next Week on XBOX» all its games with their days, for the
 * Xbox and its PC store alike, with no platforms of their own
 */
/** The platforms a release may name, in the order the table shows them */
export const PLATFORMS = ['PS5', 'PS4', 'Xbox Series X|S', 'Switch 2', 'Switch', 'PC'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ROUNDUPS: Readonly<Record<string, { title: RegExp; platforms: readonly Platform[] }>> = {
  'push-square': { title: /coming out next week/i, platforms: ['PS5'] },
  'pure-xbox': { title: /coming to xbox next week/i, platforms: ['Xbox Series X|S'] },
  'xbox-wire': { title: /^next week on xbox/i, platforms: ['Xbox Series X|S', 'PC'] },
};

/** A day the model gave, `YYYY-MM-DD`, or null for anything else: «TBA» is no day */
function plainDate(value: string): Temporal.PlainDate | null {
  try {
    return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? Temporal.PlainDate.from(value.trim(), { overflow: 'reject' }) : null;
  } catch {
    return null;
  }
}

/** A release of the week as the radar's table shows it */
export interface RadarRow {
  game: string;
  platforms: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** «вт, 29 вересня» */
  day: string;
}

/** The Monday of the chat's week, if today is its Monday from the radar's hour on, in the chat's zone */
export function radarMonday(now: Date, timeZone: string): Temporal.PlainDate | null {
  const local = zoned(now, timeZone);
  return local.dayOfWeek === 1 && local.hour >= RADAR_HOUR ? local.toPlainDate() : null;
}

/**
 * The week's releases as the table shows them: those of its seven days only, each game once, the biggest the
 * model named first kept when there are too many, then in the order of their days
 */
export function radarRows(releases: ReleasesResult['releases'], monday: Temporal.PlainDate): RadarRow[] {
  const sunday = monday.add({ days: 6 });
  const seen = new Set<string>();
  const rows: RadarRow[] = [];
  for (const release of releases) {
    const date = plainDate(release.date);
    const name = release.game.trim().toLowerCase();
    if (!date || Temporal.PlainDate.compare(date, monday) < 0 || Temporal.PlainDate.compare(date, sunday) > 0 || seen.has(name)) continue;
    seen.add(name);
    const platforms = PLATFORMS.filter((platform) => release.platforms.includes(platform)).join(', ');
    rows.push({ game: release.game.trim(), platforms, date: date.toString(), day: weekdayDateLabel(date) });
    if (rows.length === RADAR_ROWS) break;
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

type Roundup = { sourceId: string; title: string; summary: string };

/** The roundups as the model reads them, each labelled — `[R1]`… — and with the platforms it is about */
export function roundupMaterials(roundups: readonly Roundup[]): string {
  return roundups
    .map((item, i) => `[R${i + 1}] Джерело: добірка ігор для ${ROUNDUPS[item.sourceId]?.platforms.join(' і ') ?? 'різних платформ'}\nЗаголовок: ${item.title}\n${item.summary}`)
    .join(MATERIALS_SEPARATOR)
    .slice(0, MATERIALS_MAX);
}

/**
 * A release with the platforms of every roundup it says names the game (`sources`) and of the game of its name in
 * Nintendo's store, besides its own. Told that a game of several roundups is on all their platforms, the model drops
 * one now and then — the more roundups a game is in, the likelier — so the code, which knows each roundup's
 * platforms, adds them.
 */
export function withRoundupPlatforms(
  release: ReleasesResult['releases'][number],
  roundups: readonly Roundup[],
  nintendo: ReadonlyMap<string, readonly string[]>,
): ReleasesResult['releases'][number] {
  const cited = release.sources.flatMap((label) => {
    const roundup = roundups[Number(/^R(\d+)$/.exec(label.trim())?.[1] ?? 0) - 1];
    return roundup ? (ROUNDUPS[roundup.sourceId]?.platforms ?? []) : [];
  });
  const all = new Set<string>([...release.platforms, ...cited, ...(nintendo.get(gameKey(release.game)) ?? [])]);
  return { ...release, platforms: PLATFORMS.filter((platform) => all.has(platform)) };
}

/**
 * Nintendo's store's week as one more roundup: the press has none for the Switch, and the store lists every game of
 * the week, the smallest too — those the most downloaded and pre-ordered are read, in the order of their days
 */
export function nintendoMaterials(releases: readonly NintendoRelease[]): string {
  if (releases.length === 0) return '';
  const read = [...releases]
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
    .slice(0, NINTENDO_READ)
    .sort((a, b) => a.date.localeCompare(b.date));
  const lines = read.map((game) => {
    const systems = PLATFORMS.filter((platform) => game.systems.includes(platform)).join(', ');
    return `- ${game.title} (${systems}) — ${game.date}${game.publisher ? ` — ${game.publisher}` : ''}`;
  });
  return `Джерело: магазин Nintendo — усі ігри тижня для Switch 2 і Switch, дрібні теж\nЗаголовок: Нові ігри в Nintendo eShop цього тижня\n${lines.join('\n')}`;
}

/** The radar's post: her word under the heading, and the table of the week's releases */
export function radarContent(intro: string, rows: readonly RadarRow[]): { text: string; extras: CrowPostExtras } {
  return {
    text: intro,
    extras: {
      heading: '📅 Реліз-радар тижня',
      table: { header: ['Гра', 'Де', 'Коли'], rows: rows.map((row) => [row.game, row.platforms, row.day]) },
    },
  };
}

/** The radar's word checked as an arc message is: every number from its table */
export async function writeRadarIntro(
  write: (request: RadarRequest) => Promise<Priced<TalkResult>>,
  rows: readonly RadarRow[],
): Promise<{ text: string; attempts: Attempt[] }> {
  const request: RadarRequest = { releases: rows.map(({ game, platforms, day }) => ({ game, platforms, day })), maxLength: MAX_RADAR_LENGTH };
  const allowed = allowedNumbers(...rows.flatMap((row) => [row.game, row.platforms, row.day]));
  const { text, attempts } = await writeText(write, request, (intro) => textProblems(intro, allowed, MAX_RADAR_LENGTH));
  return { text: text ?? FALLBACK_INTRO, attempts };
}

type RadarStore = Pick<CrowStore, 'eventChats' | 'roundups' | 'planRadar'>;

/** The model's calls of the radar: the week's releases from the roundups, and her word over them */
export interface RadarWriters {
  releases: (week: string, materials: string) => Promise<Priced<ReleasesResult['releases']>>;
  radar: (request: RadarRequest) => Promise<Priced<TalkResult>>;
}

/**
 * The release radar (docs/crow/behavior.md#the-release-radar): on Monday, in each chat that hears 📅 Реліз-радар,
 * a post of the week's notable releases, from the roundups the press and the platforms published before it. One
 * post a week for every chat, prepared once; a week without roundups or releases goes without.
 */
export class ReleaseRadar {
  constructor(
    private readonly store: RadarStore,
    private readonly write: RadarWriters,
    /** Nintendo's store's games of the days, both included (sources/nintendoStore.ts) */
    private readonly nintendo: (from: Temporal.PlainDate, to: Temporal.PlainDate) => Promise<NintendoRelease[]>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return {
      name: 'releases',
      nextRun: (startedAt) => new Date(startedAt.getTime() + RADAR_INTERVAL_MS),
      run: async (state) => {
        const now = this.clock();
        const weeks: Record<string, { text: string; extras: CrowPostExtras } | null> = { ...(state.weeks as object | undefined) };
        const told: Record<string, string> = { ...(state.told as Record<string, string> | undefined) };
        for (const chat of await this.store.eventChats(['releases'])) {
          const { timeZone } = chat;
          const monday = radarMonday(now, timeZone);
          const week = monday?.toString();
          if (!monday || !week || told[chat.chatId] === week || isQuiet(now, timeZone, chat.quietFrom, chat.quietTo)) continue;
          if (!(week in weeks)) weeks[week] = await this.prepare(monday);
          told[chat.chatId] = week;
          const content = weeks[week];
          if (!content) continue;
          await this.store.planRadar(chat.chatId, { ...content, notBefore: now, expiresAt: endOfDay(now, timeZone) });
          console.log(`${LOG_PREFIX} Release radar of ${week} planned in chat ${getLinkChatId(Number(chat.chatId))}`);
        }
        // A week is remembered until the next one
        for (const week of Object.keys(weeks)) {
          if (Date.parse(week) < now.getTime() - 8 * DAY) delete weeks[week];
        }
        return { ...state, weeks, told };
      },
    };
  }

  /** The week's post, or null when the roundups gave no release of it */
  private async prepare(monday: Temporal.PlainDate) {
    const since = new Date(Date.parse(`${monday.toString()}T00:00:00Z`) - ROUNDUPS_BEFORE_MS);
    const sunday = monday.add({ days: 6 });
    const [found, nintendo] = await Promise.all([
      this.store.roundups(Object.keys(ROUNDUPS), since),
      // The week goes without the Switch rather than without its radar
      this.nintendo(monday, sunday).catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} Release radar of ${monday}: no games from Nintendo's store:`, error);
        return [];
      }),
    ]);
    const roundups = found.filter((item) => ROUNDUPS[item.sourceId]?.title.test(item.title));
    if (roundups.length === 0 && nintendo.length === 0) {
      console.log(`${LOG_PREFIX} Release radar of ${monday}: no roundups of the week`);
      return null;
    }
    const materials = [roundupMaterials(roundups), nintendoMaterials(nintendo)].filter(Boolean).join(MATERIALS_SEPARATOR);
    const { result } = await this.write.releases(`${dateLabel(monday)} – ${dateLabel(sunday)} ${sunday.year}`, materials);
    const systems = new Map(nintendo.map((game): [string, string[]] => [gameKey(game.title), game.systems]));
    const rows = radarRows(
      result.map((release) => withRoundupPlatforms(release, roundups, systems)),
      monday,
    );
    if (rows.length === 0) {
      console.log(`${LOG_PREFIX} Release radar of ${monday}: the roundups named no release of the week`);
      return null;
    }
    const intro = await writeRadarIntro(this.write.radar, rows);
    return radarContent(intro.text, rows);
  }
}
