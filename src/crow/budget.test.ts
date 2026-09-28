import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { budgetDay, nextBudgetDay, spend, withinBudget } from './budget';

describe('budget', () => {
  it('counts the day in UTC, whatever zone the chats live in', () => {
    assert.equal(budgetDay(new Date('2026-09-26T23:59:00Z')), '2026-09-26');
    assert.equal(budgetDay(new Date('2026-09-27T00:00:00Z')), '2026-09-27');
    assert.equal(nextBudgetDay(new Date('2026-09-26T21:30:00Z')).toISOString(), '2026-09-27T00:00:00.000Z');
    assert.equal(nextBudgetDay(new Date('2026-09-30T12:00:00Z')).toISOString(), '2026-10-01T00:00:00.000Z');
  });

  it('adds up the spending of a day and stops at the limit', () => {
    const now = new Date('2026-09-26T10:00:00Z');
    let state = spend(undefined, now, 0.3);
    assert.equal(withinBudget(state, now, 0.5), true);
    state = spend(state, now, 0.25);
    assert.deepEqual(state, { day: '2026-09-26', spentUsd: 0.55 });
    assert.equal(withinBudget(state, now, 0.5), false);
  });

  it('starts over on a new day', () => {
    const state = { day: '2026-09-25', spentUsd: 9 };
    const now = new Date('2026-09-26T10:00:00Z');
    assert.equal(withinBudget(state, now, 0.5), true);
    assert.deepEqual(spend(state, now, 0.1), { day: '2026-09-26', spentUsd: 0.1 });
  });
});
