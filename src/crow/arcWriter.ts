import type { CrowFact } from '../entity/CrowStory.entity';
import { arcOutline, type OutlineItem, outlineLines } from './arcOutline';
import { allowedNumbers, type ArcCheck, arcProblems, type Attempt, crowPrefix, writeChecked } from './arcValidation';
import { visitsFor } from './cadence';
import { type Category, categoryLabel, type Importance } from './categories';
import type { Priced } from './crowLlm';
import type { ArcRequest, ArcResult } from './prompts';
import type { NewArcMessage } from './store';
import { plural } from './words';

const HOUR = 3_600_000;

/** «протягом 30 годин»: the genitive, as «протягом» wants it */
export function hoursLabel(ms: number | undefined): string {
  if (!ms) return 'кількох годин';
  const hours = Math.round(ms / HOUR);
  return `${hours} ${plural(hours, ['години', 'годин', 'годин'])}`;
}

/** What an arc is written from */
export interface ArcStory {
  title: string;
  category: Category;
  importance: Importance;
  isRumor: boolean;
  facts: CrowFact[];
}

/** What the crow said before: its latest openings, not to repeat them, and its verdicts, to switch sides */
export interface ArcMemory {
  recentPosts: string[];
  previousStances: string[];
}

/**
 * The request for a story's arc and the outline it follows. The arc is written
 * once, for the boldest chat, and no longer than the facts carry.
 */
export function arcRequest(
  story: ArcStory,
  roster: string[],
  memory: ArcMemory,
  now: Date,
): { request: ArcRequest; outline: OutlineItem[] } {
  // A comparison needs someone to compare with: a game news has no roster
  const outline = arcOutline(story.facts, visitsFor(story.category.cadence, story.importance, 'pestering'), roster.length > 0);
  return {
    outline,
    request: {
      title: story.title,
      categoryName: categoryLabel(story.category, now),
      importance: story.importance,
      isRumor: story.isRumor,
      facts: story.facts,
      roster,
      recentPosts: memory.recentPosts,
      previousStances: memory.previousStances,
      outline: outlineLines(outline),
      window: hoursLabel(story.category.cadence.byImportance[story.importance].windowMs),
    },
  };
}

export interface WrittenArc {
  /** The messages that passed the checks, each with what the outline says of it */
  messages: NewArcMessage[];
  stance: ArcResult['stance'];
  /** Positions of the outline dropped after the rewrite, 1-based */
  dropped: number[];
  /** The opening failed even after the rewrite: the story cannot be posted */
  failed: boolean;
  /** Every call, with what the checks found in its answer */
  attempts: Attempt[];
}

/**
 * Writes an arc the way every story is written: an attempt, the checks, one
 * rewrite with the problems listed, and what still fails dropped. The model
 * writes only the texts; what each message is about comes from the outline.
 */
export async function writeArc(
  write: (request: ArcRequest) => Promise<Priced<ArcResult>>,
  request: ArcRequest,
  outline: OutlineItem[],
): Promise<WrittenArc> {
  // The crow's past verdicts come with how long ago she gave them, «5 днів тому», and she may say so
  const allowed = allowedNumbers(
    request.title,
    ...request.facts.map((f) => f.text),
    ...request.roster,
    ...request.previousStances,
  );
  const factIds = new Set(request.facts.map((f) => f.id));
  const drafts = (arc: ArcResult): NewArcMessage[] =>
    arc.messages.slice(0, outline.length).map((message, i) => ({ ...message, ...crowPrefix(message.text), ...outline[i] }));
  const check = (arc: ArcResult): ArcCheck[] => {
    const problems = arcProblems(
      drafts(arc).map((m) => ({ ...m, table: m.table ?? null, optional: m.optional ?? false })),
      allowed,
      factIds,
    );
    if (arc.messages.length === outline.length) return problems;
    return [{ number: 0, problems: [`повідомлень має бути рівно ${outline.length}, а не ${arc.messages.length}`] }, ...problems];
  };
  const describe = (checks: ArcCheck[]) =>
    checks.map((p) => (p.number === 0 ? p.problems.join('; ') : `Повідомлення ${p.number}: ${p.problems.join('; ')}`));

  const { value, attempts } = await writeChecked(
    write,
    request,
    (arc) => ({ arc, checks: check(arc) }),
    ({ checks }) => describe(checks),
  );
  const { arc, checks } = value;
  const bad = new Set(checks.map((p) => p.number).filter((n) => n > 0));
  return {
    messages: drafts(arc).filter((_, i) => !bad.has(i + 1)),
    stance: arc.stance,
    dropped: [...bad].sort((a, b) => a - b),
    failed: bad.has(1) || arc.messages.length === 0,
    attempts,
  };
}
