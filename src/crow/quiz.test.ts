import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import type { PlannedPost } from './planning';
import type { QuizRequest, QuizResult } from './prompts';
import { quizProblems, withQuiz, writeQuiz } from './quiz';

const facts = [
  { id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' },
  { id: 'F2', text: 'Генерація в середньому на 30% швидша' },
];
const allowed = allowedNumbers('Claude Opus 5.5', ...facts.map((fact) => fact.text));
const request: QuizRequest = { title: 'Claude Opus 5.5', categoryName: '🤖 AI Enterprise', facts };

const quiz = (patch: Partial<NonNullable<QuizResult['quiz']>> = {}): NonNullable<QuizResult['quiz']> => ({
  question: 'На скільки Opus 5.5 дешевший за Opus 5?',
  options: ['10%', '20%', '50%', 'Мені пофіг, я на безкоштовному'],
  correctIndex: 1,
  explanation: '🐦‍⬛ 20%, котику. Я казала це двічі. Двічі!',
  factId: 'F1',
  ...patch,
});

/** A model that answers from a list, one answer per call */
function fakeModel(...answers: QuizResult[]) {
  const requests: QuizRequest[] = [];
  const write = async (sent: QuizRequest) => {
    requests.push(sent);
    return { result: answers[Math.min(requests.length, answers.length) - 1], costUsd: 0.0002 };
  };
  return { write, requests };
}

const planned = (count: number): PlannedPost[] =>
  Array.from({ length: count }, (_, i) => ({
    kind: 'arc',
    storyMessageId: 100 + i,
    text: null,
    mention: null,
    seq: i + 1,
    optional: false,
    importance: 3,
    gapMs: i === 0 ? 0 : 60_000,
    notBefore: i === 0 ? new Date() : null,
    expiresAt: null,
  }));

describe('quizProblems', () => {
  it('lets the wrong answers make up their numbers, but not the question, the right answer or the explanation', () => {
    assert.deepEqual(quizProblems(quiz(), facts, allowed), []);
    assert.deepEqual(quizProblems(quiz({ correctIndex: 2 }), facts, allowed), ['правильна відповідь: числа 50 немає у фактах']);
    assert.ok(quizProblems(quiz({ explanation: '🐦‍⬛ 25%, котику.' }), facts, allowed).includes('explanation: числа 25 немає у фактах'));
  });

  it('holds a quiz to Telegram’s limits and to the facts it names', () => {
    const problems = quizProblems(
      quiz({ options: ['20%'], correctIndex: 3, factId: 'F9', explanation: 'Без ворони.' }),
      facts,
      allowed,
    );
    assert.deepEqual(problems, [
      'варіантів має бути 2–4, а не 1',
      'correctIndex 3 поза варіантами',
      'факту F9 немає серед наведених',
      'explanation має починатися з 🐦‍⬛',
    ]);
    assert.deepEqual(quizProblems(quiz({ options: ['20%', '20%', '10%'] }), facts, allowed), ['варіанти повторюються']);
    assert.ok(quizProblems(quiz({ explanation: `🐦‍⬛ ${'а'.repeat(200)}` }), facts, allowed).some((p) => p.startsWith('explanation: довше')));
  });
});

describe('writeQuiz', () => {
  it('rewrites a failing quiz once with its problems, and keeps none that still fails or that the model declined', async () => {
    const model = fakeModel({ quiz: quiz({ correctIndex: 2 }) }, { quiz: quiz() });
    const written = await writeQuiz(model.write, request, allowed);
    assert.equal(written.quiz?.correctIndex, 1);
    assert.deepEqual(model.requests[1].corrections, ['правильна відповідь: числа 50 немає у фактах']);

    const stubborn = await writeQuiz(fakeModel({ quiz: quiz({ correctIndex: 2 }) }).write, request, allowed);
    assert.equal(stubborn.quiz, null);
    assert.equal(stubborn.attempts.length, 2);
    const declined = await writeQuiz(fakeModel({ quiz: null }).write, request, allowed);
    assert.equal(declined.quiz, null);
    assert.equal(declined.attempts.length, 1);
  });

  it('asks the question after her crow, as every message of hers begins, without markup', async () => {
    const written = await writeQuiz(fakeModel({ quiz: quiz() }).write, request, allowed);
    assert.equal(written.quiz?.question, '🐦‍⬛ На скільки Opus 5.5 дешевший за Opus 5?');
    const crowed = await writeQuiz(fakeModel({ quiz: quiz({ question: '🐦‍⬛🐦‍⬛ На скільки дешевший?' }) }).write, request, allowed);
    assert.equal(crowed.quiz?.question, '🐦‍⬛🐦‍⬛ На скільки дешевший?');
    const marked = await writeQuiz(fakeModel({ quiz: quiz({ question: 'На скільки **Opus 5.5** дешевший?' }) }).write, request, allowed);
    assert.equal(marked.quiz?.question, '🐦‍⬛ На скільки Opus 5.5 дешевший?', 'a poll shows no markup');
  });
});

describe('withQuiz', () => {
  it('puts the quiz in the second half of a long chain, never last, optional; a short chain gets none', () => {
    const chain = withQuiz(planned(8), 'На скільки?', () => 0.5);
    assert.equal(chain.length, 9);
    assert.equal(chain[4].kind, 'quiz');
    assert.equal(chain[4].optional, true);
    assert.equal(chain[4].gapMs, 40 * 60_000);
    assert.deepEqual(
      chain.map((post) => post.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.equal(withQuiz(planned(5), 'На скільки?', () => 0.5)[4].kind, 'quiz', 'after four, before the last');
    assert.equal(withQuiz(planned(4), 'На скільки?', () => 0.5).length, 4);
  });
});
