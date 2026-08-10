/**
 * Objective checks over one summarisation result.
 *
 * Swapping the model behind the trends summary risks a failure that no
 * capability table can predict: the model stops keeping topics apart and the
 * same material — the same message ids, the same wording — turns up under
 * several headings. The summarisation prompt states that as a hard constraint
 * ("Один і той самий факт ... MUST NOT з'являтися більш ніж в одній секції"),
 * which makes it checkable rather than a matter of taste.
 *
 * Everything here is mechanical: no model judges another model. A check either
 * counts something in the output or compares it against the input that produced
 * it.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

import { extractTemplateAfter } from './image-checks.ts';

/** The shape `SummarizationResultSchema` produces, kept structural on purpose. */
export type SummaryResult = {
  topParticipants?: { name?: string; nickName?: string; messageCount?: number; summary?: string }[];
  topics?: { topic?: string; messageIds?: string[] }[];
  trends?: { trend?: string; messageIds?: string[] }[];
  gaming?: { summary?: string; messageIds?: string[] } | null;
  memes?: { summary?: string; messageIds?: string[] } | null;
  events?: { event?: string; messageIds?: string[] }[];
  fullSummary?: string;
};

export type SummarySection = {
  /** where in the result this came from, e.g. `topics[0]` */
  path: string;
  text: string;
  messageIds: string[];
};

/** Flattens the result into the units the no-duplication rule applies to. */
export function sections(result: SummaryResult): SummarySection[] {
  const found: SummarySection[] = [];
  const push = (path: string, text: string | undefined, ids: string[] | undefined): void => {
    found.push({ path, text: text ?? '', messageIds: (ids ?? []).map(String) });
  };

  (result.topics ?? []).forEach((topic, index) => push(`topics[${index}]`, topic.topic, topic.messageIds));
  (result.trends ?? []).forEach((trend, index) => push(`trends[${index}]`, trend.trend, trend.messageIds));
  (result.events ?? []).forEach((event, index) => push(`events[${index}]`, event.event, event.messageIds));
  if (result.gaming) push('gaming', result.gaming.summary, result.gaming.messageIds);
  if (result.memes) push('memes', result.memes.summary, result.memes.messageIds);
  return found;
}

const TRIGRAMS = (text: string): Set<string> => {
  const normalised = text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= normalised.length; i++) grams.add(normalised.slice(i, i + 3));
  return grams;
};

/**
 * Jaccard overlap of character trigrams: language-agnostic, needs no model, and
 * catches the rephrased near-duplicate that an exact comparison would miss.
 * Returns 0 for anything too short to compare.
 */
export function similarity(left: string, right: string): number {
  return jaccard(TRIGRAMS(left), TRIGRAMS(right));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

export type SummaryReport = {
  /** ids cited that were never in the input — the model invented them */
  unknownIds: string[];
  /** ids cited from more than one section, with the sections that share them */
  bleedingIds: { id: string; paths: string[] }[];
  /** section pairs whose text says the same thing twice */
  duplicateSections: { paths: [string, string]; similarity: number }[];
  /** events are required to state a date, even if only "дата не вказана" */
  eventsWithoutDate: string[];
  /** the fullSummary must not cite ids, explicitly or in passing */
  idsLeakedIntoFullSummary: string[];
  /** share of input messages the summary cites at all, 0–1 */
  coverage: number;
};

const DATE_HINT =
  /\d{1,2}[.\-/]\d{1,2}|\d{4}|понеділ|вівтор|серед|четвер|п'ятниц|субот|неділ|сьогодні|завтра|післязавтра|не вказан|не указан/i;

/** Similarity at or above which two sections count as saying the same thing. */
const NEAR_DUPLICATE = 0.6;

/**
 * @param result   what the model returned
 * @param inputIds every message id the model was shown
 */
export function checkSummary(result: SummaryResult, inputIds: readonly string[]): SummaryReport {
  const known = new Set(inputIds.map(String));
  const found = sections(result);

  const owners = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const section of found) {
    for (const id of section.messageIds) {
      if (!known.has(id)) unknown.add(id);
      owners.set(id, [...(owners.get(id) ?? []), section.path]);
    }
  }

  // trigram sets once per section, not once per pair — the pair loop is quadratic
  const grams = found.map((section) => TRIGRAMS(section.text));
  const duplicates: SummaryReport['duplicateSections'] = [];
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const score = jaccard(grams[i], grams[j]);
      if (score >= NEAR_DUPLICATE) duplicates.push({ paths: [found[i].path, found[j].path], similarity: score });
    }
  }

  const cited = new Set([...owners.keys()].filter((id) => known.has(id)));
  // one tokenisation instead of one \b-regex scan per input id; ids are numeric,
  // and \b splits words on the same ASCII rule \W does, so the answers agree
  const fullSummaryTokens = new Set((result.fullSummary ?? '').split(/\W+/));

  return {
    unknownIds: [...unknown].sort(),
    bleedingIds: [...owners]
      .filter(([, paths]) => paths.length > 1)
      .map(([id, paths]) => ({ id, paths }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    duplicateSections: duplicates.sort((a, b) => b.similarity - a.similarity),
    eventsWithoutDate: (result.events ?? [])
      .map((event) => event.event ?? '')
      .filter((event) => event !== '' && !DATE_HINT.test(event)),
    idsLeakedIntoFullSummary: [...known].filter((id) => fullSummaryTokens.has(id)).sort(),
    coverage: known.size === 0 ? 0 : cited.size / known.size,
  };
}

/** A run is clean when it broke none of the prompt's hard constraints. */
export const isClean = (report: SummaryReport): boolean =>
  report.unknownIds.length === 0 &&
  report.bleedingIds.length === 0 &&
  report.duplicateSections.length === 0 &&
  report.eventsWithoutDate.length === 0 &&
  report.idsLeakedIntoFullSummary.length === 0;

/**
 * Pulls a template-literal constant out of the app source.
 *
 * The evaluation has to use the prompt the bot actually ships, and the app's
 * modules cannot be imported from here: they resolve their relative imports
 * with a `.js` extension that only exists after a build. Reading the text keeps
 * the two in step without a build step. The named-constant case is just the
 * anchored case with the declaration as the anchor.
 */
export function extractTemplateConst(source: string, name: string): string {
  return extractTemplateAfter(source, `const ${name}`);
}
