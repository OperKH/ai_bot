import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { reminderPost, reminderProblems, reminderWindow, writeReminder } from './deadlines';
import type { ReminderRequest } from './prompts';

const NOW = new Date('2026-09-27T12:00:00Z');
const ends = { kind: 'ends' as const, at: '2026-10-01T15:00:00.000Z', remindAt: '2026-09-30T15:00:00.000Z' };
const available = { kind: 'available' as const, at: '2026-10-06T08:00:00.000Z', remindAt: '2026-10-06T10:00:00.000Z' };
const allowed = allowedNumbers('Epic Games Store gives away Mechabellum');

describe('reminderProblems', () => {
  it('wants the moment once in a reminder of games that go, and none in one of games that came', () => {
    assert.deepEqual(reminderProblems('🐦‍⬛🐦‍⬛ Mechabellum піде {when}, забирайте.', 'ends', allowed), []);
    assert.deepEqual(reminderProblems('🐦‍⬛🐦‍⬛ Забирайте Mechabellum.', 'ends', allowed), ['`{when}` має бути в тексті рівно один раз, а не 0']);
    assert.deepEqual(reminderProblems('🐦‍⬛🐦‍⬛ Уже можна забирати.', 'available', allowed), []);
    assert.deepEqual(reminderProblems('🐦‍⬛🐦‍⬛ Уже {when}.', 'available', allowed), ['без `{when}`: ігри вже прийшли, момент — зараз']);
    assert.ok(reminderProblems('🐦‍⬛🐦‍⬛ До 18:00 {when}.', 'ends', allowed).includes('час доби цифрами заборонений'));
  });
});

describe('writeReminder', () => {
  it('rewrites a failing reminder once, then gives up', async () => {
    const requests: ReminderRequest[] = [];
    const answers = ['🐦‍⬛🐦‍⬛ Забирайте.', '🐦‍⬛🐦‍⬛ Mechabellum піде {when}.'];
    const write = async (request: ReminderRequest) => {
      requests.push(request);
      return { result: { text: answers[requests.length - 1] }, costUsd: 0.0002 };
    };
    const request: ReminderRequest = { title: 'Mechabellum', categoryName: '🆓 Халява', facts: [], kind: 'ends', maxLength: 300 };
    const written = await writeReminder(write, request, allowed);
    assert.equal(written.text, '🐦‍⬛🐦‍⬛ Mechabellum піде {when}.');
    assert.deepEqual(requests[1].corrections, ['`{when}` має бути в тексті рівно один раз, а не 0']);
  });
});

describe('reminderWindow', () => {
  it('reminds of games that go from its time until they are gone, but not when the arc going out now is near it', () => {
    assert.deepEqual(reminderWindow(ends, NOW), { notBefore: new Date(ends.remindAt), expiresAt: new Date(ends.at) });
    assert.equal(reminderWindow(ends, new Date('2026-09-30T14:00:00Z')), null, 'an hour before its time');
    assert.equal(reminderWindow(ends, new Date('2026-10-01T10:00:00Z')), null);
  });

  it('reminds of games that came at their moment, for twelve hours, and not when it is past', () => {
    assert.deepEqual(reminderWindow(available, NOW), {
      notBefore: new Date(available.remindAt),
      expiresAt: new Date('2026-10-06T22:00:00Z'),
    });
    assert.equal(reminderWindow(available, new Date('2026-10-06T11:00:00Z')), null);
  });
});

describe('reminderPost', () => {
  it('makes the moment a `date_time` of how long is left, with the words for a client that cannot show it', () => {
    assert.deepEqual(reminderPost('🐦‍⬛🐦‍⬛ Піде {when}.', ends), {
      text: '🐦‍⬛🐦‍⬛ Піде {when:deadline}.',
      extras: { moments: { deadline: { unixTime: Date.parse(ends.at) / 1000, format: 'r', fallback: 'через 24 год' } } },
    });
    assert.deepEqual(reminderPost('🐦‍⬛🐦‍⬛ Уже можна.', available), { text: '🐦‍⬛🐦‍⬛ Уже можна.', extras: null });
  });
});
