import type { CrowFact } from '../entity/CrowStory.entity';
import type { CrowMessageKind } from '../entity/CrowStoryMessage.entity';

/** One place in an arc, given to the model before it writes */
export interface OutlineItem {
  kind: CrowMessageKind;
  /** The facts the message tells of; none for the comparison */
  factIds: string[];
  /** Chats with less boldness may skip it */
  optional: boolean;
}

/** A fact about a price, a date or where to get it: the chat's practical questions */
const PRACTICAL = /[$€₴]|грн|ціна|ціни|коштує|коштують|безкоштовн|доступн|вийде|виходить|з \d+ /i;
/**
 * The facts of the opening post, which comes with the picture: the news in full — its main facts in
 * OPENING_POINTS lines of about OPENING_LENGTH characters — rather than a teaser of three. The check holds the
 * opening to MAX_OPENING_LENGTH (arcValidation.ts).
 */
export const HEADLINE_FACTS = 6;
export const OPENING_POINTS = { min: 3, max: 8 };
export const OPENING_LENGTH = 1500;
/** The facts a story keeps of its materials: the opening's and a message each for the rest */
export const MAX_FACTS = 16;
/** The messages with no fact of their own: the opening and the comparison */
const FRAME_MESSAGES = 2;
/**
 * An arc this short has no room for a comparison: the small categories — an open
 * model, a release of a coding tool — get two or three posts, and it would take
 * the place of a fact
 */
const SHORT_ARC = 3;

/**
 * The shape of an arc, decided before the model writes it: the news with the
 * main facts, then a message for each of the other facts in the order of
 * importance, and a comparison with the competitors after the first two — or,
 * in an arc of three posts at most, only the news and the next facts. No
 * farewell: the crow says goodbye once a day, before a chat's quiet hours
 * (evening.ts), not whenever an arc's last gap runs out. Every fact is told once, so the arc cannot
 * circle back to it — left to itself, the model did, three times in a row, and
 * a message on a fact of the opening only retold the opening — and the model
 * is left the voice and the jokes. The arc is no longer than `maxMessages` and
 * than its facts carry. The later third of the facts is optional: chats with
 * less boldness hear only the stronger ones. With no competitors to compare
 * the hero with (`versus` false) — a game news has none among the labs'
 * models — there is no comparison, and a fact takes its place.
 */
export function arcOutline(facts: CrowFact[], maxMessages: number, versus = true): OutlineItem[] {
  const breaking: OutlineItem = {
    kind: 'breaking',
    factIds: facts.slice(0, HEADLINE_FACTS).map((f) => f.id),
    optional: false,
  };
  const factItem = (fact: CrowFact, optional: boolean): OutlineItem => ({
    kind: PRACTICAL.test(fact.text) ? 'practical' : 'fact',
    factIds: [fact.id],
    optional,
  });
  if (maxMessages <= SHORT_ARC) {
    return [breaking, ...facts.slice(HEADLINE_FACTS, HEADLINE_FACTS + maxMessages - 1).map((f) => factItem(f, false))];
  }

  // Longer: the opening, the comparison and a message for each fact that fits
  const frame = versus ? FRAME_MESSAGES : 1;
  const count = Math.min(maxMessages, frame + Math.max(0, facts.length - HEADLINE_FACTS));
  const told = facts.slice(HEADLINE_FACTS, HEADLINE_FACTS + count - frame);
  const firstOptional = Math.ceil((told.length * 2) / 3);
  const middle: OutlineItem[] = told.map((fact, i) => factItem(fact, i >= firstOptional));
  if (versus) middle.splice(Math.min(2, middle.length), 0, { kind: 'versus', factIds: [], optional: false });
  return [breaking, ...middle];
}

/** The outline as the model reads it: a numbered line per message, with its kind in brackets */
export function outlineLines(outline: OutlineItem[]): string[] {
  return outline.map((item, i) => {
    const facts = item.factIds.join(', ');
    const line = (text: string) => `${i + 1}. [${item.kind}] ${text}`;
    switch (item.kind) {
      case 'breaking':
        return line(
          `Прильот: головне з ${facts} у ${OPENING_POINTS.min}–${OPENING_POINTS.max} пунктах, до ~${OPENING_LENGTH} символів; піде разом із фото.`,
        );
      case 'versus':
        return line('Порівняння героя з одним конкурентом зі списку за однією віссю, що випливає з фактів.');
      case 'practical':
        return line(`Лише ${facts}: що з цього практично для котів.`);
      default:
        return line(`Лише ${facts}.`);
    }
  });
}
