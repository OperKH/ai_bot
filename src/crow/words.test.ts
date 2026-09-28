import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agoLabel, dateLabel, dayLabel, plural } from './words';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const days = ['день', 'дні', 'днів'] as const;

describe('plural', () => {
  it('picks the form Ukrainian wants after a count', () => {
    assert.deepEqual(
      [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => `${n} ${plural(n, days)}`),
      [
        '1 день',
        '2 дні',
        '4 дні',
        '5 днів',
        '11 днів',
        '12 днів',
        '14 днів',
        '21 день',
        '22 дні',
        '25 днів',
        '101 день',
        '111 днів',
      ],
    );
  });
});

describe('agoLabel', () => {
  it('says how long ago in the words the crow would use', () => {
    assert.equal(agoLabel(20_000), 'щойно');
    assert.equal(agoLabel(20 * MINUTE), '20 хв тому');
    assert.equal(agoLabel(3 * HOUR + 40 * MINUTE), '3 год тому');
    assert.equal(agoLabel(30 * HOUR), 'вчора');
    assert.equal(agoLabel(2 * DAY), '2 дні тому');
    assert.equal(agoLabel(5 * DAY + HOUR), '5 днів тому');
  });
});

describe('dayLabel', () => {
  const now = new Date('2026-10-02T15:00:00Z'); // Friday, 18:00 in Kyiv

  it("names the days of the week the chat lives in: today, yesterday, then the weekday", () => {
    assert.equal(dayLabel(new Date('2026-10-02T06:00:00Z'), now, 'Europe/Kyiv'), 'сьогодні');
    assert.equal(dayLabel(new Date('2026-10-01T20:59:00Z'), now, 'Europe/Kyiv'), 'учора');
    assert.equal(dayLabel(new Date('2026-10-01T21:30:00Z'), now, 'Europe/Kyiv'), 'сьогодні', 'after midnight in Kyiv');
    assert.equal(dayLabel(new Date('2026-09-29T10:00:00Z'), now, 'Europe/Kyiv'), 'у вівторок');
    assert.equal(dayLabel(new Date('2026-09-26T10:00:00Z'), now, 'Europe/Kyiv'), 'у суботу');
  });
});

describe('dateLabel', () => {
  it('says a date with the month in the genitive', () => {
    assert.equal(dateLabel(Temporal.PlainDate.from('2026-11-19')), '19 листопада');
    assert.equal(dateLabel(Temporal.PlainDate.from('2027-01-01')), '1 січня');
  });
});
