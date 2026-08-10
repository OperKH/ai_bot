/**
 * Objective checks over one image description.
 *
 * `describeImage` asks for a Ukrainian description of one to three sentences,
 * for memes to be named as memes, and for any text in the picture to be carried
 * over "точно та без змін". Each of those is a rule the output either follows or
 * does not, so a weaker vision model shows up as a rule it stopped following
 * rather than as a vaguer sentence.
 *
 * What cannot be checked mechanically is whether the description is *good*. The
 * report says which rules held; judging the wording is left to a person.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

export type ImageExpectation = {
  /** the picture is a meme, so the description has to say so */
  meme?: boolean;
  /**
   * Groups of alternatives. Every group must be represented by at least one of
   * its spellings, which is how the same fact survives being translated:
   * `["троих", "трьох", "три"]` all count as carrying the number over.
   */
  mentions?: string[][];
  maxSentences?: number;
  /** the prompt demands Ukrainian, which Ukrainian-only letters give away */
  ukrainian?: boolean;
};

export type ImageReport = {
  empty: boolean;
  refused: boolean;
  saidMeme: boolean;
  /** the picture was declared a meme and the description failed to say so */
  memeMissed: boolean;
  /** groups from `mentions` that no spelling satisfied */
  missing: string[][];
  sentences: number;
  tooLong: boolean;
  ukrainian: boolean;
  /** Ukrainian was demanded and the description is in something else */
  notUkrainian: boolean;
};

// No \b around the Cyrillic alternatives: JavaScript word boundaries are defined
// on ASCII word characters, so \bмем never matches at all.
const REFUSAL = /не можу|вибачте|перепрошую|\bsorry\b|\bi can'?t\b|\bi cannot\b|\bunable to\b/i;
const MEME = /мем/i;
/** і, ї, є and ґ exist in Ukrainian but not in Russian, so their presence settles the language */
const UKRAINIAN_ONLY = /[іїєґІЇЄҐ]/;

const countSentences = (text: string): number =>
  text
    .split(/[.!?…]+(?:\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;

/**
 * The expectation is folded into the report — `memeMissed` and `notUkrainian`
 * are false when the expectation makes no such demand — so the report alone
 * answers every question and nobody downstream needs the expectation again.
 */
export function checkDescription(description: string, expectation: ImageExpectation = {}): ImageReport {
  const text = description.trim();
  const missing = (expectation.mentions ?? []).filter(
    (group) => !group.some((spelling) => text.toLowerCase().includes(spelling.toLowerCase())),
  );
  const sentences = countSentences(text);
  const saidMeme = MEME.test(text);
  const ukrainian = UKRAINIAN_ONLY.test(text);

  return {
    empty: text.length === 0,
    refused: REFUSAL.test(text),
    saidMeme,
    memeMissed: expectation.meme === true && !saidMeme,
    missing,
    sentences,
    tooLong: expectation.maxSentences !== undefined && sentences > expectation.maxSentences,
    ukrainian,
    notUkrainian: expectation.ukrainian === true && !ukrainian,
  };
}

/** A description is clean when it broke none of the rules the prompt states. */
export const isDescriptionClean = (report: ImageReport): boolean =>
  !report.empty &&
  !report.refused &&
  !report.tooLong &&
  !report.memeMissed &&
  !report.notUkrainian &&
  report.missing.length === 0;

/**
 * Pulls the first template literal after an anchor.
 *
 * The image prompt is written inline inside `describeImage` rather than hoisted
 * into a named constant, so it cannot be found the way `SUMMARIZATION_PROMPT`
 * is; anchoring on the surrounding code keeps the evaluation using the prompt
 * the bot actually sends.
 */
export function extractTemplateAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`Could not find ${JSON.stringify(anchor)} in the source.`);
  const start = source.indexOf('`', at);
  if (start === -1) throw new Error(`No template literal follows ${JSON.stringify(anchor)}.`);
  const end = source.indexOf('`', start + 1);
  if (end === -1) throw new Error(`The template literal after ${JSON.stringify(anchor)} is not terminated.`);
  return source.slice(start + 1, end);
}
