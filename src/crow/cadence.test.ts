import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_GAP_MS, nextPostGap, pickMessages, planGaps, visitsFor } from './cadence';
import { CATEGORIES } from './categories';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A seeded generator, so the jittered gaps are the same on every run */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const aiEnterprise = CATEGORIES.find((c) => c.id === 'ai-enterprise')!.cadence;

describe('visitsFor', () => {
  it('scales the posts of a story by the boldness of the chat', () => {
    assert.equal(visitsFor(aiEnterprise, 3, 'restrained'), 6);
    assert.equal(visitsFor(aiEnterprise, 3, 'bold'), 12);
    assert.equal(visitsFor(aiEnterprise, 3, 'pestering'), 16); // 18, capped by hardMax
  });

  it('gives every story at least one post', () => {
    assert.equal(visitsFor(aiEnterprise, 1, 'restrained'), 1);
  });
});

describe('planGaps', () => {
  const profile = { visits: 8, windowMs: 12 * HOUR, burst: { visits: 3, withinMs: 20 * MINUTE } };

  it('has one gap fewer than posts, and none for a single post', () => {
    assert.equal(planGaps(profile, 8, seeded(1)).length, 7);
    assert.deepEqual(planGaps(profile, 1, seeded(1)), []);
  });

  it('opens with a burst within its window, then the gaps grow', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const gaps = planGaps(profile, 8, seeded(seed));
      assert.ok(gaps[0] + gaps[1] <= 20 * MINUTE, `burst of seed ${seed}: ${gaps.slice(0, 2)}`);
      // Jitter can swap two neighbours, but the tail grows about twofold each step
      assert.ok(gaps[6] > 4 * gaps[2], `tail of seed ${seed}: ${gaps}`);
    }
  });

  it('fills about the window of the arc', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const total = planGaps(profile, 8, seeded(seed)).reduce((a, b) => a + b, 0);
      assert.ok(total > 8 * HOUR && total < 17 * HOUR, `seed ${seed}: ${total / HOUR} h`);
    }
  });

  it('never goes below the minimal gap, even when many posts share a short window', () => {
    const gaps = planGaps({ visits: 6, windowMs: 20 * MINUTE }, 6, seeded(7));
    assert.ok(gaps.every((gap) => gap >= MIN_GAP_MS), String(gaps));
  });

  it('gives each chat its own rhythm', () => {
    assert.notDeepEqual(planGaps(profile, 8, seeded(1)), planGaps(profile, 8, seeded(2)));
  });
});

describe('nextPostGap', () => {
  it('is the minimal gap plus up to three minutes', () => {
    assert.equal(nextPostGap(() => 0), 5 * MINUTE);
    assert.equal(nextPostGap(() => 0.999999), 8 * MINUTE);
  });
});

describe('pickMessages', () => {
  const arc = [
    { seq: 1, optional: false },
    { seq: 2, optional: true },
    { seq: 3, optional: false },
    { seq: 4, optional: true },
    { seq: 5, optional: false },
    { seq: 6, optional: false },
  ];
  const seqs = (messages: { seq: number }[]) => messages.map((m) => m.seq);

  it('keeps the whole arc when the chat gets as many posts', () => {
    assert.deepEqual(seqs(pickMessages(arc, 6)), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(seqs(pickMessages(arc, 10)), [1, 2, 3, 4, 5, 6]);
  });

  it('drops optional messages first, keeping the order', () => {
    assert.deepEqual(seqs(pickMessages(arc, 5)), [1, 2, 3, 5, 6]);
    assert.deepEqual(seqs(pickMessages(arc, 4)), [1, 3, 5, 6]);
  });

  it('keeps the opening, then the core messages in their order', () => {
    assert.deepEqual(seqs(pickMessages(arc, 3)), [1, 3, 5]);
    assert.deepEqual(seqs(pickMessages(arc, 2)), [1, 3]);
  });

  it('keeps only the news itself for a single post', () => {
    assert.deepEqual(seqs(pickMessages(arc, 1)), [1]);
  });


});
