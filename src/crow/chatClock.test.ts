import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinutes, isQuiet, minutesOfDay, startOfDay } from './chatClock';

const KYIV = 'Europe/Kyiv';

describe('isQuiet', () => {
  // 23:30–09:00, across midnight
  const quiet = (iso: string) => isQuiet(new Date(iso), KYIV, 1410, 540);

  it('covers the night across midnight', () => {
    assert.equal(quiet('2026-09-26T20:29:00Z'), false); // 23:29 in Kyiv (UTC+3)
    assert.equal(quiet('2026-09-26T20:30:00Z'), true); // 23:30
    assert.equal(quiet('2026-09-27T02:00:00Z'), true); // 05:00
    assert.equal(quiet('2026-09-27T05:59:00Z'), true); // 08:59
    assert.equal(quiet('2026-09-27T06:00:00Z'), false); // 09:00
  });

  it('follows the change to winter time', () => {
    // 25.10.2026 Kyiv goes from UTC+3 to UTC+2: 06:30Z is 08:30 there, still quiet
    assert.equal(quiet('2026-10-25T06:30:00Z'), true);
    assert.equal(quiet('2026-10-25T07:00:00Z'), false);
    // The day before, 06:00Z was already 09:00
    assert.equal(quiet('2026-10-24T06:00:00Z'), false);
  });

  it('handles a range within one day', () => {
    assert.equal(isQuiet(new Date('2026-09-27T01:00:00Z'), KYIV, 0, 540), true); // 04:00
    assert.equal(isQuiet(new Date('2026-09-26T20:00:00Z'), KYIV, 0, 540), false); // 23:00
  });

  it('is never quiet without quiet hours', () => {
    assert.equal(isQuiet(new Date('2026-09-27T01:00:00Z'), KYIV, null, null), false);
  });
});

describe('startOfDay', () => {
  it('is the local midnight', () => {
    assert.equal(startOfDay(new Date('2026-09-27T10:00:00Z'), KYIV).toISOString(), '2026-09-26T21:00:00.000Z');
  });

  it('moves with the change to winter time', () => {
    assert.equal(startOfDay(new Date('2026-10-26T10:00:00Z'), KYIV).toISOString(), '2026-10-25T22:00:00.000Z');
  });
});

describe('minutesOfDay and formatMinutes', () => {
  it('reads and writes the local time of day', () => {
    assert.equal(minutesOfDay(new Date('2026-09-26T20:30:00Z'), KYIV), 1410);
    assert.equal(formatMinutes(1410), '23:30');
    assert.equal(formatMinutes(540), '09:00');
    assert.equal(formatMinutes(0), '00:00');
  });
});
