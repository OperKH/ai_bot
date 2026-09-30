import { gameKey } from './sources/nintendoStore';
import { normalizeUrl } from './toldYou';

/**
 * How the entries of one game news from several publishers become one story (docs/crow/pipeline.md#game-stories):
 * the same link, nearly the same headline, or the same meaning. The thresholds are the concept's (section 7.2),
 * from a synthetic measurement: its headlines of one news were 0.73 apart at most, of two news 0.56 at least.
 */

/** Headlines this alike, as pg_trgm counts them, tell one news */
export const SAME_HEADLINE = 0.6;
/** An entry this close in meaning to a story's entries is its news */
export const SAME_STORY_SIMILARITY = 0.75;
/** Closer than this but not close enough to be sure, the model says whether it is the same news */
export const MAYBE_SAME_STORY_SIMILARITY = 0.6;

/** A word's trigrams, as pg_trgm takes them: padded with two spaces before and one after */
export function wordTrigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** How alike two sets of trigrams are, pg_trgm's `similarity`: their shared trigrams of all their trigrams */
export function trigramSimilarity(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / (x.size + y.size - shared);
}

/** The trigrams of a text, as pg_trgm takes them: each word lowercase */
function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const gram of wordTrigrams(word)) grams.add(gram);
  }
  return grams;
}

/** How alike two headlines are, as pg_trgm counts it */
export function headlineSimilarity(a: string, b: string): number {
  return trigramSimilarity(trigrams(a), trigrams(b));
}

/** A game story of the last days an entry may belong to */
export interface StoryCandidate {
  storyId: number;
  /** What the story is of, as the sorting named it: «PS Plus» */
  hero?: string | null;
  /** Its entries' headlines and links */
  headlines: string[];
  urls: string[];
  /** The best similarity of its entries' embeddings to the entry's; null — no vectors to compare */
  similarity: number | null;
}

export type StoryMatch =
  | { kind: 'same'; storyId: number; by: 'link' | 'headline' | 'meaning' }
  | { kind: 'maybe'; storyId: number; similarity: number }
  | { kind: 'new' };

/**
 * The story of an entry among the candidates: the same link settles it, then a headline nearly the same, then the
 * meaning — sure from 0.75, a question for the model from 0.6; below, it is news of its own. An entry that names its
 * hero is sure by meaning only of a story of the same hero, however either is spelled: the month's releases came
 * 0.78 close to PS Plus's monthly games
 */
export function matchStory(
  entry: { url: string | null; headline: string; hero?: string },
  candidates: readonly StoryCandidate[],
): StoryMatch {
  const link = entry.url ? normalizeUrl(entry.url) : null;
  if (link) {
    const same = candidates.find((story) => story.urls.some((url) => normalizeUrl(url) === link));
    if (same) return { kind: 'same', storyId: same.storyId, by: 'link' };
  }
  const grams = trigrams(entry.headline);
  const alike = (headline: string) => trigramSimilarity(trigrams(headline), grams);
  const byHeadline = candidates
    .map((story) => ({ story, alike: Math.max(0, ...story.headlines.map(alike)) }))
    .sort((a, b) => b.alike - a.alike)[0];
  if (byHeadline && byHeadline.alike >= SAME_HEADLINE) return { kind: 'same', storyId: byHeadline.story.storyId, by: 'headline' };
  const byMeaning = candidates
    .filter((story) => story.similarity !== null)
    .sort((a, b) => b.similarity! - a.similarity!)[0];
  const sameHero = entry.hero === undefined || (!!byMeaning?.hero && gameKey(byMeaning.hero) === gameKey(entry.hero));
  if (byMeaning && byMeaning.similarity! >= SAME_STORY_SIMILARITY && sameHero) {
    return { kind: 'same', storyId: byMeaning.storyId, by: 'meaning' };
  }
  if (byMeaning && byMeaning.similarity! >= MAYBE_SAME_STORY_SIMILARITY) {
    return { kind: 'maybe', storyId: byMeaning.storyId, similarity: byMeaning.similarity! };
  }
  return { kind: 'new' };
}

