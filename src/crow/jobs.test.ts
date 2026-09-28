import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type CrowJobDefinition, jobAction } from './jobs';

const NOW = new Date('2026-09-26T12:00:00Z');
const HOUR = 3_600_000;

const job = (stillWorth?: CrowJobDefinition['stillWorth']): CrowJobDefinition => ({
  name: 'test',
  nextRun: (startedAt) => new Date(startedAt.getTime() + HOUR),
  stillWorth,
  run: async () => {},
});

describe('jobAction', () => {
  it('waits for its turn', () => {
    assert.equal(jobAction(job(), new Date(NOW.getTime() + 1), NOW), 'wait');
  });

  it('runs once when its turn has come, however many it missed', () => {
    assert.equal(jobAction(job(), NOW, NOW), 'run');
    assert.equal(jobAction(job(), new Date(NOW.getTime() - 48 * HOUR), NOW), 'run');
  });

  it('skips a turn that is no longer worth it', () => {
    // A morning digest is pointless three hours late
    const morning = job((dueAt, now) => now.getTime() - dueAt.getTime() < 3 * HOUR);
    assert.equal(jobAction(morning, new Date(NOW.getTime() - HOUR), NOW), 'run');
    assert.equal(jobAction(morning, new Date(NOW.getTime() - 4 * HOUR), NOW), 'skip');
  });
});
