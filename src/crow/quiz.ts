import type { CrowFact } from '../entity/CrowStory.entity';
import type { CrowQuiz } from '../entity/CrowStory.entity';
import { type Attempt, crowPrefix, textProblems, writeChecked } from './arcValidation';
import type { Random } from './cadence';
import type { Priced } from './crowLlm';
import { withoutMarkup } from './crowMessage';
import { chainPost, insertPost, type PlannedPost } from './planning';
import type { QuizRequest, QuizResult } from './prompts';

const MINUTE = 60_000;

/** Telegram's limits of a quiz: the question, an option, the explanation shown after an answer */
export const QUIZ_QUESTION_MAX = 300;
export const QUIZ_OPTION_MAX = 100;
export const QUIZ_EXPLANATION_MAX = 200;
const QUIZ_OPTIONS = { min: 2, max: 4 };
/** What the prompt asks for (prompts.ts), short of the limits above so a longer answer still passes */
export const QUIZ_ASKED = { question: 250, option: 80, explanation: 180, options: { min: 3, max: QUIZ_OPTIONS.max } };
/** A chain this short has no room for a quiz: it would come last, after the story is told out */
export const QUIZ_MIN_POSTS = 5;
/** A quiz comes this long after the post before it, at random */
const QUIZ_GAP = { minMs: 20 * MINUTE, maxMs: 60 * MINUTE };

/** The question as the poll asks it: after her crow, as every message of hers begins, and with no markup a poll shows as is */
function quizQuestion(question: string): string {
  return crowPrefix(withoutMarkup(question.trim())).text;
}

/** A story's quiz, with the fact its answer comes from */
export type StoryQuiz = CrowQuiz & { factId: string };

/**
 * What is wrong with a quiz, in words the model gets back when it rewrites it. The wrong answers may make up
 * their numbers — that is what makes them wrong — so only the question, the right answer and the explanation are
 * held to the facts
 */
export function quizProblems(quiz: NonNullable<QuizResult['quiz']>, facts: readonly CrowFact[], allowed: Set<string>): string[] {
  const problems: string[] = [];
  const options = quiz.options.map((option) => option.trim());
  if (options.length < QUIZ_OPTIONS.min || options.length > QUIZ_OPTIONS.max) {
    problems.push(`варіантів має бути ${QUIZ_OPTIONS.min}–${QUIZ_OPTIONS.max}, а не ${options.length}`);
  }
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) problems.push('варіанти повторюються');
  const long = options.filter((option) => option.length === 0 || option.length > QUIZ_OPTION_MAX);
  if (long.length > 0) problems.push(`варіант має бути від 1 до ${QUIZ_OPTION_MAX} символів: ${long.join('; ')}`);
  const right = options[quiz.correctIndex];
  if (right === undefined) problems.push(`correctIndex ${quiz.correctIndex} поза варіантами`);
  if (!facts.some((fact) => fact.id === quiz.factId)) problems.push(`факту ${quiz.factId} немає серед наведених`);
  problems.push(...textProblems(quizQuestion(quiz.question), allowed, QUIZ_QUESTION_MAX).map((p) => `питання: ${p}`));
  if (right !== undefined) problems.push(...textProblems(right, allowed, QUIZ_OPTION_MAX).map((p) => `правильна відповідь: ${p}`));
  const explanation = quiz.explanation.trim();
  if (!explanation.startsWith('🐦‍⬛')) problems.push('explanation має починатися з 🐦‍⬛');
  if ((explanation.match(/\n/g) ?? []).length > 2) problems.push('explanation — не більше трьох рядків');
  problems.push(...textProblems(explanation, allowed, QUIZ_EXPLANATION_MAX).map((p) => `explanation: ${p}`));
  return problems;
}

/**
 * Writes a story's quiz as the arcs are written: an attempt, the checks, one rewrite with the problems listed.
 * None when the model finds no good question in the facts, or the quiz still fails.
 */
export async function writeQuiz(
  write: (request: QuizRequest) => Promise<Priced<QuizResult>>,
  request: QuizRequest,
  allowed: Set<string>,
): Promise<{ quiz: StoryQuiz | null; attempts: Attempt[] }> {
  const { value: quiz, problems, attempts } = await writeChecked(
    write,
    request,
    (result) => result.quiz,
    (quiz) => (quiz ? quizProblems(quiz, request.facts, allowed) : []),
  );
  if (!quiz || problems.length > 0) return { quiz: null, attempts };
  return {
    quiz: {
      question: quizQuestion(quiz.question),
      options: quiz.options.map((option) => withoutMarkup(option.trim())),
      correctIndex: quiz.correctIndex,
      explanation: withoutMarkup(quiz.explanation.trim()),
      factId: quiz.factId,
    },
    attempts,
  };
}

/**
 * Puts a quiz into a chat's chain of an arc, in its second half — after four posts at least, never last: the
 * chat has heard the facts of its opening by then. A quiz is optional, so a chat over its daily limit loses it.
 */
export function withQuiz(planned: PlannedPost[], question: string, random: Random): PlannedPost[] {
  if (planned.length < QUIZ_MIN_POSTS) return planned;
  const at = Math.min(Math.max(4, Math.ceil(planned.length / 2)), planned.length - 1);
  const post = chainPost(planned, { kind: 'quiz', text: question, mention: null, optional: true }, QUIZ_GAP, random);
  return insertPost(planned, at, post);
}
