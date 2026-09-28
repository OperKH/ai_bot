import { getLinkChatId } from '../bot/telegramLinks';
import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowProfile, CrowProfileMember } from '../entity/CrowChatProfile.entity';
import type { CrowMention } from '../entity/CrowPost.entity';
import {
  allowedNumbers,
  type Attempt,
  attemptsCost,
  crowPrefix,
  placeholderProblems,
  textProblems,
  writeChecked,
} from './arcValidation';
import { BOLDNESS } from './cadence';
import type { Priced } from './crowLlm';
import type { CrowJobDefinition } from './jobs';
import type { PlannedJab } from './planning';
import type { JabRequest, JabResult, ProfileResult } from './prompts';
import type { CrowStore } from './store';
import { catName, memoryLine } from './words';

const LOG_PREFIX = '[Crow]';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How far back a profile reads the chat, of the 90 days `chat_message` keeps: a month says what a cat plays
 * now, and lets a joke the chat has forgotten go
 */
export const PROFILE_WINDOW_DAYS = 30;
export const PROFILE_WINDOW_MS = PROFILE_WINDOW_DAYS * DAY;
/** A profile is rebuilt after this */
export const PROFILE_TTL_MS = 7 * DAY;
/** Fewer messages than this say nothing of anyone */
export const MIN_PROFILE_MESSAGES = 50;
const PROFILE_INTERVAL_MS = HOUR;
/** One message as the model reads it, and all of them: the newest are kept */
const MESSAGE_MAX = 300;
const MESSAGES_MAX_CHARS = 150_000;
/** What the profile keeps, and the prompt asks for (prompts.ts) */
export const MAX_INTERESTS = 10;
export const MAX_MEMES = 8;
const MAX_MEMBERS = 30;
export const MAX_TOPICS = 5;
const TOPIC_MAX = 120;
/** A jab the prompt asks for, and the longest the check lets through */
export const JAB_LENGTH = 200;
const JAB_MAX_LENGTH = 400;
/** The crow's latest posts in the chat that the jabs' prompt gets, not to repeat itself */
const MEMORY_POSTS = 10;

/** Before her first jab the crow tells the chat that she reads it: the members must know (concept, section 14) */
export const INTRO_TEXT =
  "🐦‍⬛ Кара на зв'язку, коти. Щоб ви знали: я читаю ваш чат — так, усе — і запам'ятовую, хто на чому сидить: " +
  'ігри, платформи, моделі. Для підколок, звісно. Не хочеш, щоб я тебе чіпала, — /crow і «🙅 Не чіпай мене»; ' +
  'вимкнути підколки для всього чату — там само, «🎯 Підколки».';

/** A message of the chat, as the profile reads it */
export interface ProfileMessage {
  userId: string;
  firstName: string | null;
  username: string | null;
  text: string;
  at: Date;
}

/** «— 16.09 —»: the line that opens a day of messages, so the model sees what comes back day after day */
const dayLine = (at: Date) =>
  `— ${String(at.getUTCDate()).padStart(2, '0')}.${String(at.getUTCMonth() + 1).padStart(2, '0')} —`;

/** How the chat knows a cat, and how to mention them */
export interface ProfilePerson {
  name: string;
  username: string | null;
}

/**
 * The chat's messages as the profile's model reads them — by days, `[id] name:
 * text` a line each, long ones cut, the newest kept when there are too many — and
 * who wrote them. The days let the model tell a joke that keeps coming back from
 * a word said once. The cats who opted out are not read at all.
 */
export function profileInput(
  messages: ProfileMessage[],
  optedOut: ReadonlySet<string>,
): { text: string; count: number; people: Map<string, ProfilePerson> } {
  const people = new Map<string, ProfilePerson>();
  const kept: { line: string; day: string }[] = [];
  let chars = 0;
  for (const message of [...messages].reverse()) {
    const text = message.text.replace(/\s+/g, ' ').trim();
    if (!text || optedOut.has(message.userId)) continue;
    const name = catName(message.firstName, message.username, message.userId);
    const line = `[${message.userId}] ${name}: ${text.slice(0, MESSAGE_MAX)}`;
    if (chars + line.length > MESSAGES_MAX_CHARS) break;
    chars += line.length + 1;
    kept.push({ line, day: dayLine(message.at) });
    // The newest name wins: the loop reads the latest messages first
    if (!people.has(message.userId)) people.set(message.userId, { name, username: message.username });
  }
  const lines: string[] = [];
  let current: string | undefined;
  for (const { line, day } of kept.reverse()) {
    if (day !== current) lines.push((current = day));
    lines.push(line);
  }
  return { text: lines.join('\n'), count: kept.length, people };
}

const clean = (items: string[], max: number) =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))].map((item) => item.slice(0, TOPIC_MAX)).slice(0, max);

/** The model's profile, kept to the cats it was built from and to its limits */
export function cleanProfile(result: ProfileResult, people: ReadonlyMap<string, ProfilePerson>): CrowProfile {
  const members: CrowProfileMember[] = [];
  for (const member of result.members) {
    const person = people.get(member.id);
    const topics = clean(member.topics, MAX_TOPICS);
    if (!person || topics.length === 0 || members.some((m) => m.userId === member.id)) continue;
    members.push({ userId: member.id, name: person.name, username: person.username, topics });
  }
  return {
    interests: clean(result.interests, MAX_INTERESTS),
    memes: clean(result.memes, MAX_MEMES),
    members: members.slice(0, MAX_MEMBERS),
  };
}

/**
 * How many jabs an arc of a chat gets, and whether they ping: a restrained crow
 * names one cat without a notification, a bold one mentions one, a pestering one
 * two (concept, section 14).
 */
export function jabsFor(boldness: CrowBoldness): { count: number; ping: boolean } {
  return { count: boldness === 'pestering' ? 2 : 1, ping: BOLDNESS[boldness].pings };
}

/** What is wrong with a jab, in words the model gets back when it rewrites it */
export function jabProblems(text: string, allowed: Set<string>): string[] {
  return [...placeholderProblems(text, '{cat}'), ...textProblems(text, allowed, JAB_MAX_LENGTH)];
}

export interface WrittenJabs {
  /** The jabs that passed the checks, at different cats, as many as asked at most */
  jabs: { userId: string; text: string }[];
  attempts: Attempt[];
}

/**
 * Writes the jabs as the arcs are written: an attempt, the checks, one rewrite
 * with the problems listed, and what still fails dropped. A jab at a cat the
 * request did not name is a problem too.
 */
export async function writeJabs(
  write: (request: JabRequest) => Promise<Priced<JabResult>>,
  request: JabRequest,
  allowed: Set<string>,
): Promise<WrittenJabs> {
  const targets = new Set(request.targets.map((target) => target.userId));
  const { value: checked, attempts } = await writeChecked(
    write,
    request,
    (result) =>
      result.jabs.map((jab) => {
        const text = crowPrefix(jab.text.trim()).text;
        const problems = targets.has(jab.userId) ? jabProblems(text, allowed) : [`кота ${jab.userId} немає серед котів чату`];
        return { userId: jab.userId, text, problems };
      }),
    (checked) => checked.flatMap((jab, i) => jab.problems.map((p) => `Підколка ${i + 1}: ${p}`)),
  );
  const jabs: WrittenJabs['jabs'] = [];
  for (const jab of checked) {
    if (jab.problems.length > 0 || jabs.some((j) => j.userId === jab.userId)) continue;
    jabs.push({ userId: jab.userId, text: jab.text });
  }
  return { jabs: jabs.slice(0, request.count), attempts };
}

/** The story a chat's jabs are about */
export interface JabStory {
  title: string;
  categoryName: string;
  facts: { id: string; text: string }[];
  opening: string;
}

/**
 * The personal jabs of a chat's arc, from its profile: cats whose topics the
 * story touches, none if it touches nobody. The cats who opted out are not in the
 * profile; those who opted out since it was built are left out here.
 */
export class JabWriter {
  constructor(
    private readonly store: Pick<CrowStore, 'profile' | 'optedOut' | 'nicknames' | 'recentPosts'>,
    private readonly write: (request: JabRequest) => Promise<Priced<JabResult>>,
  ) {}

  async jabs(
    chatId: string,
    boldness: CrowBoldness,
    story: JabStory,
    now: Date,
  ): Promise<{ jabs: PlannedJab[]; costUsd: number }> {
    const [profile, optedOut, nicknames, memory] = await Promise.all([
      this.store.profile(chatId),
      this.store.optedOut(chatId),
      this.store.nicknames(chatId),
      this.store.recentPosts(chatId, MEMORY_POSTS),
    ]);
    const members = profile?.members.filter((member) => !optedOut.has(member.userId)) ?? [];
    if (members.length === 0) return { jabs: [], costUsd: 0 };

    const { count, ping } = jabsFor(boldness);
    const recentPosts = memory.map((post) => memoryLine(post, now));
    const request: JabRequest = {
      ...story,
      targets: members.map((member) => ({
        userId: member.userId,
        name: member.name,
        topics: member.topics,
        nickname: nicknames.get(member.userId) ?? null,
      })),
      count,
      recentPosts,
    };
    const allowed = allowedNumbers(
      story.title,
      story.opening,
      ...story.facts.map((fact) => fact.text),
      ...members.flatMap((member) => member.topics),
      ...recentPosts,
    );
    const written = await writeJabs(this.write, request, allowed);
    const costUsd = attemptsCost(written.attempts);
    const dropped = written.attempts.at(-1)!.problems;
    if (dropped.length > 0) {
      console.warn(`${LOG_PREFIX} Jabs for chat ${getLinkChatId(Number(chatId))}: dropped after the rewrite:\n  ${dropped.join('\n  ')}`);
    }
    const jabs = written.jabs.map((jab) => {
      const member = members.find((m) => m.userId === jab.userId)!;
      const mention: CrowMention = { userId: member.userId, name: member.name, username: member.username, ping };
      return { text: jab.text, mention };
    });
    return { jabs, costUsd };
  }
}

/**
 * The chats' profiles (docs/crow/behavior.md#the-chat-profile-and-the-jabs): the `profile` job
 * builds the profile of a chat that has none or an old one, from its last 30 days,
 * and before the crow's first jab there it tells the chat that she reads it.
 */
export class ChatProfiles {
  constructor(
    private readonly store: Pick<
      CrowStore,
      'profileDueChats' | 'profileMessages' | 'optedOut' | 'saveProfile' | 'planIntro'
    >,
    private readonly build: (messages: string) => Promise<Priced<ProfileResult>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  job(): CrowJobDefinition {
    return {
      name: 'profile',
      nextRun: (startedAt) => new Date(startedAt.getTime() + PROFILE_INTERVAL_MS),
      run: async () => {
        const now = this.clock();
        for (const chat of await this.store.profileDueChats(new Date(now.getTime() - PROFILE_TTL_MS))) {
          await this.rebuild(chat.chatId, chat.introduced, now).catch((e) =>
            console.error(`${LOG_PREFIX} The profile of chat ${getLinkChatId(Number(chat.chatId))} failed:`, e),
          );
        }
      },
    };
  }

  private async rebuild(chatId: string, introduced: boolean, now: Date) {
    const messages = await this.store.profileMessages(chatId, new Date(now.getTime() - PROFILE_WINDOW_MS));
    const input = profileInput(messages, await this.store.optedOut(chatId));
    if (input.count < MIN_PROFILE_MESSAGES) return;
    const { result, costUsd } = await this.build(input.text);
    const profile = cleanProfile(result, input.people);
    await this.store.saveProfile(chatId, profile, input.count, now);
    const chat = getLinkChatId(Number(chatId));
    console.log(
      `${LOG_PREFIX} Profile of chat ${chat}: ${profile.members.length} cats, ${profile.interests.length} interests ` +
        `from ${input.count} messages ($${costUsd.toFixed(4)})`,
    );
    if (!introduced) {
      await this.store.planIntro(chatId, INTRO_TEXT, now);
      console.log(`${LOG_PREFIX} The crow introduces herself in chat ${chat}`);
    }
  }
}
