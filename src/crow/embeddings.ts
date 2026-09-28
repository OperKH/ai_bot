import type { TextEmbeddingTask } from '../services/ai.service';

/**
 * The crow's embeddings (docs/crow/behavior.md#talking-in-the-chat): EmbeddingGemma's vectors of what she can
 * say in a talk and of the entries her stories come from, so a talk or a forward about a story is heard
 * without naming it, and one news of several publishers is one story. The thresholds come from a synthetic
 * measurement (concept, section 12.5) and are logged against what the model decided, to calibrate them on
 * the chat's own messages.
 */
export type Embedder = (texts: string[], task: TextEmbeddingTask) => Promise<number[][]>;

/**
 * How a chat is heard by meaning: the model, and the similarities from which a message goes to the gate
 * (`CROW_TALK_THRESHOLD`) and a forward brings back a story she told (`CROW_FORWARD_THRESHOLD`) — the model still
 * decides either way
 */
export interface Meaning {
  embed: Embedder;
  talkThreshold: number;
  forwardThreshold: number;
}
/** A message of fewer words resembles everything — «шо на обід» scored 0.28 — so it is not looked for by meaning */
export const TALK_MIN_WORDS = 4;

/** Whether a message says enough to be looked for by its meaning */
export function enoughWords(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length >= TALK_MIN_WORDS;
}

/** What is embedded of a message in a talk: with the message it replies to, since «а скільки коштує?» alone is about nothing */
export function talkText(text: string, repliedTo: string | null): string {
  return repliedTo ? `${repliedTo}\n${text}` : text;
}

/**
 * What is embedded of a post of an arc: the facts it tells, dry, rather than its text. Her posts speak the chat's
 * slang, and on the chat's real messages their vectors were close to any chatter: 71% of the messages came within
 * 0.25 of them, 30% of the facts (data/crow_embeddings/prod_threshold_check.mts). Empty for a post of no fact.
 */
export function postFacts(factIds: readonly string[], facts: readonly { id: string; text: string }[]): string {
  return facts
    .filter((fact) => factIds.includes(fact.id))
    .map((fact) => fact.text)
    .join('\n');
}

/** A story's vectors that no chat asked for this long go: a forward of it is too late for «я ж казала» anywhere */
const UNUSED_MS = 31 * 24 * 3_600_000;

/**
 * The vectors of the facts of the stories a forward is compared with, kept by story in memory: a forward is rare,
 * the stories of a month are a few dozen, and a story's facts change only when its rumor comes true
 */
export class FactVectors {
  private readonly kept = new Map<number, { key: string; vectors: number[][]; usedAt: number }>();

  constructor(
    private readonly embed: Embedder,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Each story's best similarity of its facts to a forward's vector, the closest first */
  async scores(
    stories: readonly { storyId: number; facts: readonly { text: string }[] }[],
    vector: number[],
  ): Promise<{ storyId: number; similarity: number }[]> {
    const missing = stories.filter((story) => this.kept.get(story.storyId)?.key !== factsKey(story.facts));
    const texts = missing.flatMap((story) => story.facts.map((fact) => fact.text));
    const vectors = texts.length > 0 ? await this.embed(texts, 'similarity') : [];
    const now = this.clock();
    let next = 0;
    for (const story of missing) {
      const own = vectors.slice(next, next + story.facts.length);
      this.kept.set(story.storyId, { key: factsKey(story.facts), vectors: own, usedAt: now });
      next += story.facts.length;
    }
    // Kept while a chat still tells them: every chat asks for its own stories, which another chat's forward keeps
    for (const story of stories) {
      const kept = this.kept.get(story.storyId);
      if (kept) kept.usedAt = now;
    }
    for (const [id, kept] of this.kept) if (now - kept.usedAt > UNUSED_MS) this.kept.delete(id);
    return stories
      .map((story) => ({
        storyId: story.storyId,
        similarity: Math.max(-1, ...(this.kept.get(story.storyId)?.vectors ?? []).map((v) => dot(v, vector))),
      }))
      .filter((score) => score.similarity > -1)
      .sort((a, b) => b.similarity - a.similarity);
  }
}

const factsKey = (facts: readonly { text: string }[]) => facts.map((fact) => fact.text).join('\u0000');
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);

/**
 * What is embedded of a source's entry: its headline and the sorting model's title of the news, which reads the
 * same whoever wrote it («Sony raises PS5 prices in Europe»), so the entries of one news are close
 */
export function entryText(headline: string, sortedTitle: string): string {
  return headline.trim().toLowerCase() === sortedTitle.trim().toLowerCase() ? headline : `${sortedTitle}\n${headline}`;
}

/** The embeddings of the texts, or none when the model fails: a story or a talk goes on without them */
export async function embedOrNone(embed: Embedder | null, texts: string[], task: TextEmbeddingTask): Promise<(number[] | null)[]> {
  if (!embed || texts.length === 0) return texts.map(() => null);
  try {
    return await embed(texts, task);
  } catch (e) {
    console.warn('[Crow] No embeddings:', e instanceof Error ? e.message : e);
    return texts.map(() => null);
  }
}
