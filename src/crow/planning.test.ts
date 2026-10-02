import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from './categories';
import { activation, cadenceCategory, FIRST_POST_TTL_MS, planArc } from './planning';

const NOW = new Date('2026-09-26T12:00:00Z');
const HOUR = 3_600_000;

const arc = Array.from({ length: 16 }, (_, i) => ({ id: 100 + i, seq: i + 1, optional: i % 3 === 1 }));
const aiEnterprise = CATEGORIES.find((c) => c.id === 'ai-enterprise')!.cadence;

describe('cadenceCategory', () => {
  it('takes the subscribed category that allows the most posts', () => {
    const subscriptions = new Set(['playstation', 'ai-enterprise']);
    assert.equal(cadenceCategory(['playstation', 'ai-enterprise'], subscriptions)?.id, 'ai-enterprise');
  });

  it('ignores categories the chat is not subscribed to', () => {
    assert.equal(cadenceCategory(['ai-enterprise'], new Set(['playstation'])), undefined);
    assert.equal(cadenceCategory(['nintendo', 'unknown'], new Set(['nintendo', 'unknown']))?.id, 'nintendo');
  });
});

describe('planArc', () => {
  it('gives the chat as many posts as its boldness allows', () => {
    assert.equal(planArc(arc, aiEnterprise, 3, 'restrained', NOW, Math.random).length, 3);
    assert.equal(planArc(arc, aiEnterprise, 3, 'bold', NOW, Math.random).length, 6);
  });

  it('lets the first post go at once and makes the rest wait for their turn', () => {
    const [first, ...rest] = planArc(arc, aiEnterprise, 2, 'bold', NOW, Math.random);
    assert.deepEqual(first.notBefore, NOW);
    assert.deepEqual(first.expiresAt, new Date(NOW.getTime() + FIRST_POST_TTL_MS));
    assert.equal(first.gapMs, 0);
    assert.ok(rest.every((post) => post.notBefore === null && post.expiresAt === null && post.gapMs > 0));
  });

  it('keeps the order of the arc, numbers the chain and copies what the dispatcher needs', () => {
    const planned = planArc(arc, aiEnterprise, 3, 'bold', NOW, Math.random);
    assert.deepEqual(
      planned.map((post) => post.seq),
      planned.map((_, i) => i + 1),
    );
    const messageSeqs = planned.map((post) => arc.find((m) => m.id === post.storyMessageId)!.seq);
    assert.deepEqual(messageSeqs, [...messageSeqs].sort((a, b) => a - b));
    assert.ok(planned.every((post) => post.importance === 3 && post.kind === 'arc'));
  });
});

describe('activation', () => {
  const doneAt = new Date('2026-09-26T12:00:00Z');

  it('follows the previous post by the gap', () => {
    assert.deepEqual(activation({ gapMs: HOUR, optional: false }, doneAt), {
      notBefore: new Date(doneAt.getTime() + HOUR),
      expiresAt: null,
    });
  });

  it('lets optional posts go stale: two hours, or the gap when it is longer', () => {
    assert.deepEqual(activation({ gapMs: HOUR, optional: true }, doneAt).expiresAt, new Date(doneAt.getTime() + 3 * HOUR));
    assert.deepEqual(
      activation({ gapMs: 5 * HOUR, optional: true }, doneAt).expiresAt,
      new Date(doneAt.getTime() + 10 * HOUR),
    );
  });
});
