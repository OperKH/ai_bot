import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sortingTurn } from './pipeline';

const entries = (count: number, sortFailures: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, sortFailures }));
const ids = (batches: { id: number }[][]) => batches.map((batch) => batch.map((entry) => entry.id));

describe('sortingTurn', () => {
  it('sorts the fresh entries in one batch, and the ones a failed sorting put back after them', () => {
    const turn = sortingTurn([...entries(3, 0), ...entries(4, 1, 10)]);
    assert.deepEqual(ids(turn), [[0, 1, 2]]);
  });

  it('brings a failed batch back in fives, then one by one', () => {
    assert.deepEqual(
      sortingTurn(entries(12, 1)).map((batch) => batch.length),
      [5, 5, 2],
    );
    assert.deepEqual(ids(sortingTurn(entries(3, 2, 20))), [[20], [21], [22]]);
    assert.deepEqual(sortingTurn([]), []);
  });
});
