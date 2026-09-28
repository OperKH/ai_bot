import type { CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowDeadline } from '../entity/CrowStory.entity';
import { placeholderProblems, textProblems, writeText, type WrittenText } from './arcValidation';
import type { Priced } from './crowLlm';
import type { ReminderRequest, TalkResult } from './prompts';
import { inLabel } from './words';

const HOUR = 3_600_000;

export const MAX_REMINDER_LENGTH = 300;
/** A reminder of games that came waits this long for a chat that keeps the crow quiet */
const AVAILABLE_TTL_MS = 12 * HOUR;
/** A reminder of games that go is not worth planning this close to its time: the arc told of it minutes ago */
const MIN_LEAD_MS = 2 * HOUR;

/**
 * What is wrong with a reminder, in words the model gets back when it rewrites it: a reminder of games that go
 * says once how long is left (`{when}`); one of games that came has no moment — it is now
 */
export function reminderProblems(text: string, kind: CrowDeadline['kind'], allowed: Set<string>): string[] {
  const moment =
    kind === 'ends'
      ? placeholderProblems(text, '{when}')
      : text.includes('{when}')
        ? ['без `{when}`: ігри вже прийшли, момент — зараз']
        : [];
  return [...moment, ...textProblems(text, allowed, MAX_REMINDER_LENGTH)];
}

/** Writes a story's reminder as the arcs are written: an attempt, the checks, one rewrite; none if it still fails */
export function writeReminder(
  write: (request: ReminderRequest) => Promise<Priced<TalkResult>>,
  request: ReminderRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => reminderProblems(text, request.kind, allowed));
}

/**
 * When the chats hear a story's reminder, and until when they may: games that came, from their moment for
 * twelve hours; games that go, from the reminder's time until they are gone. None when its time is past — the
 * arc going out now tells of it — or too near to be worth a post of its own.
 */
export function reminderWindow(deadline: CrowDeadline, now: Date): { notBefore: Date; expiresAt: Date } | null {
  const remindAt = new Date(deadline.remindAt);
  if (deadline.kind === 'available') {
    return remindAt > now ? { notBefore: remindAt, expiresAt: new Date(remindAt.getTime() + AVAILABLE_TTL_MS) } : null;
  }
  const at = new Date(deadline.at);
  return remindAt.getTime() - now.getTime() >= MIN_LEAD_MS && at > remindAt ? { notBefore: remindAt, expiresAt: at } : null;
}

/**
 * A reminder as its post keeps it: `{when}` becomes the story's moment, shown to every reader in their time as
 * how long is left, with «how long» in words for a client that cannot show it
 */
export function reminderPost(text: string, deadline: CrowDeadline): { text: string; extras: CrowPostExtras | null } {
  if (deadline.kind === 'available') return { text, extras: null };
  const at = new Date(deadline.at);
  const left = at.getTime() - new Date(deadline.remindAt).getTime();
  return {
    text: text.replace('{when}', '{when:deadline}'),
    extras: {
      moments: {
        deadline: { unixTime: Math.floor(at.getTime() / 1000), format: 'r', fallback: inLabel(left) },
      },
    },
  };
}
