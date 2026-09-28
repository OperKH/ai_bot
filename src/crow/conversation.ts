import type { Message } from 'grammy/types';
import { getLinkChatId, supergroupMessageLink } from '../bot/telegramLinks';
import type { CrowBoldness } from '../entity/CrowChat.entity';
import type { CrowPost, CrowPostExtras } from '../entity/CrowPost.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';
import { allowedNumbers, type Attempt, attemptsCost, crowPrefix, textProblems, writeChecked } from './arcValidation';
import { BOLDNESS } from './cadence';
import { trigramSimilarity, wordTrigrams } from './clustering';
import { isQuiet } from './chatClock';
import type { Priced } from './crowLlm';
import type {
  ConversationRequest,
  ConversationResult,
  ConversationStory,
  SnippetsResult,
  ToldRequest,
  ToldResult,
} from './prompts';
import type { CrowStore, RepliedPost, TalkChat } from './store';
import { broughtStory, MAX_TOLD_LENGTH, messageUrls, TOLD_WINDOW_MS, type ToldStory, writeTold } from './toldYou';
import { agoLabel, catName, memoryLine } from './words';
import type { MaterialScore } from '../dataSource/vectorSearch';
import { embedOrNone, enoughWords, FactVectors, type Meaning, talkText } from './embeddings';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A story is talked about for this long after the crow's last post of it in the chat */
export const ACTIVE_STORY_MS = 48 * HOUR;
/** A cat gets this many answers in `CAT_REPLY_WINDOW_MS`, the chat this many in an hour (concept, section 12.1) */
export const CAT_REPLIES = 3;
export const CAT_REPLY_WINDOW_MS = 10 * MINUTE;
export const CHAT_REPLIES_PER_HOUR = 12;
/** After this many exchanges in a thread the crow flies off */
export const THREAD_EXCHANGES = 4;
export const FLY_OFF_TEXT = '🐦‍⬛ Все, я полетіла, у мене справи.';
const MAX_TALK_LENGTH = 400;
/** The chat's messages before the one answered, for the context */
const RECENT_CHAT = 10;
const MEMORY_POSTS = 8;
/** Stories a call that names none of them is given, the latest first */
const REPLY_STORIES = 2;
const DETAILS_PER_STORY = 8;
const PLANNED_PER_STORY = 4;
/** The crow's store of a story as it is kept: its details and the aliases, the hero's among them */
export const DETAILS_MAX = 12;
const DETAIL_MAX_LENGTH = 300;
const ALIASES_MAX = 20;
/** What the store's prompt asks for (prompts.ts), short of the limits above so a longer answer still counts */
export const SNIPPETS_ASKED = { details: { min: 6, max: DETAILS_MAX }, detailLength: 200, aliases: { min: 5, max: 15 } };
/** Words that fit every story, so they name none */
const GENERIC_ALIASES = new Set([
  'модель',
  'модели',
  'моделі',
  'нейронка',
  'нейросеть',
  'нейромережа',
  'реліз',
  'релиз',
  'оновлення',
  'обновление',
  'апдейт',
  'гра',
  'игра',
  'новина',
  'новость',
]);

/** A message of a chat as the crow hears it */
export interface HeardMessage {
  chatId: string;
  messageId: number;
  userId: string;
  /** How the chat knows the cat: the first name, or else the username */
  name: string;
  text: string;
  /** The message it replies to, if any */
  replyToMessageId: number | null;
  /** When the original of a forwarded post came out; null — the cat's own message */
  forwardedAt: Date | null;
  /** The channel or the chat a forwarded post comes from, if it says */
  origin: string | null;
  /** The links it carries: shown, behind its words, and that of its preview */
  urls: string[];
}

/**
 * A message the crow may hear, or null: she hears groups only, and not commands,
 * bots or what a bot posted for the cat. A photo's caption is its text. A
 * forwarded post is no talk — she only says «я ж казала» to it.
 */
export function heardMessage(message: Message): HeardMessage | null {
  const text = (message.text ?? message.caption ?? '').trim();
  const from = message.from;
  if (!text || !from || from.is_bot || text.startsWith('/')) return null;
  if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return null;
  if (message.via_bot) return null;
  const origin = message.forward_origin;
  const originName =
    origin?.type === 'channel' ? origin.chat.title : origin?.type === 'chat' ? origin.sender_chat.title : undefined;
  return {
    chatId: String(message.chat.id),
    messageId: message.message_id,
    userId: String(from.id),
    name: catName(from.first_name, from.username, from.id),
    text,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    forwardedAt: origin ? new Date(origin.date * 1000) : null,
    origin: originName ?? null,
    urls: messageUrls(
      message.text ?? message.caption ?? '',
      message.entities ?? message.caption_entities,
      message.link_preview_options?.url,
    ),
  };
}

/** «ворона» in any case, and «Каро», as the chat calls her */
const CALL = /(?<!\p{L})(?:ворон(?:а|и|і|у|ою|о|е|ой|ы)|каро)(?!\p{L})/iu;
/** «Кара» only opening a message, «Кара, …»: inside a sentence it is a word of its own, «кара божа» */
const NAME_FIRST = /^кара(?!\p{L})\s*[,!?]/iu;

/** Whether a message calls the crow: by @username, «ворона» or «Каро», or «Кара,» to open it */
export function crowCalled(text: string, botUsername?: string): boolean {
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  return CALL.test(text) || NAME_FIRST.test(text.trimStart());
}

/** The words of a text, lowercase, «ё» as «е»; a number keeps its point, «5.5» */
function words(text: string): string[] {
  return text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu) ?? [];
}

/**
 * Whether a word of a message is an alias: the same word, the same with an ending
 * («опуса», «клодом»), or near enough for a typo or another ending («anthropik»,
 * «зельді»). An alias of three letters is taken whole: too few to guess from.
 */
function sameWord(word: string, alias: string, grams: (word: string) => Set<string>): boolean {
  if (word === alias) return true;
  if (alias.length < 4) return false;
  if (word.startsWith(alias) && word.length - alias.length <= 3) return true;
  if (alias.length < 5 || Math.abs(word.length - alias.length) > 2) return false;
  return trigramSimilarity(grams(word), grams(alias)) >= 0.5;
}

/**
 * Whether a message names a story by one of its aliases: a word, or several in a row. A message is checked
 * against many stories, so it is split once, and each word's trigrams are counted once.
 */
export function storyNamer(text: string): (aliases: readonly string[]) => boolean {
  const said = words(text);
  const counted = new Map<string, Set<string>>();
  const grams = (word: string) => {
    let set = counted.get(word);
    if (!set) counted.set(word, (set = wordTrigrams(word)));
    return set;
  };
  return (aliases) =>
    aliases.some((alias) => {
      const parts = words(alias);
      if (parts.length === 0 || (parts.length === 1 && parts[0].length < 3)) return false;
      return said.some((_, i) => parts.every((part, j) => i + j < said.length && sameWord(said[i + j], part, grams)));
    });
}

/** The aliases of a story as they are kept: its hero's name, which the chat may write out, and the model's */
export function storyAliases(aliases: readonly string[], hero: string | null): string[] {
  const all = [...(hero ? [hero] : []), ...aliases].map((alias) => alias.toLowerCase().replace(/\s+/g, ' ').trim());
  return [...new Set(all)].filter((alias) => alias.length >= 3 && !GENERIC_ALIASES.has(alias)).slice(0, ALIASES_MAX);
}

/** The model's store as it is kept: the details once each and of a sane length, the aliases cleaned */
export function cleanSnippets(result: SnippetsResult, hero: string | null): { details: string[]; aliases: string[] } {
  const details = [...new Set(result.details.map((detail) => detail.replace(/\s+/g, ' ').trim()))]
    .filter((detail) => detail.length > 0 && detail.length <= DETAIL_MAX_LENGTH)
    .slice(0, DETAILS_MAX);
  return { details, aliases: storyAliases(result.aliases, hero) };
}

/** Each story's closest detail or post, the closest story first */
export function bestByStory(scores: readonly MaterialScore[]): { storyId: number; similarity: number }[] {
  const best = new Map<number, number>();
  for (const score of scores) best.set(score.storyId, Math.max(best.get(score.storyId) ?? -1, score.similarity));
  return [...best].map(([storyId, similarity]) => ({ storyId, similarity })).sort((a, b) => b.similarity - a.similarity);
}

/** Scores as the log shows them: «story 12 0.41, story 15 0.22» */
export function scoreLine(scores: readonly { storyId: number; similarity: number }[]): string {
  if (scores.length === 0) return 'nothing to compare';
  return scores
    .slice(0, 4)
    .map((score) => `story ${score.storyId} ${score.similarity.toFixed(2)}`)
    .join(', ');
}

/** The crow's talk in a chat within the last hour: the cats she answered, how deep in a thread, and when she chimed in */
export interface TalkHistory {
  replies: { userId: string | null; sentAt: Date; depth: number }[];
  chimes: Date[];
}

/**
 * Whether the crow may answer a cat: twelve answers to the chat in an hour, and three talks begun with one cat in
 * ten minutes. An answer that goes on a thread of hers (`continuing`) is not a talk begun: the thread has its own
 * end, four exchanges — counted with the talks, it cut the thread short at the third answer, and she fell silent.
 */
export function mayReply(history: TalkHistory, userId: string, now: Date, continuing = false): boolean {
  if (history.replies.length >= CHAT_REPLIES_PER_HOUR) return false;
  if (continuing) return true;
  const begun = history.replies.filter(
    (reply) => reply.userId === userId && reply.depth <= 1 && now.getTime() - reply.sentAt.getTime() < CAT_REPLY_WINDOW_MS,
  ).length;
  return begun < CAT_REPLIES;
}

/** Whether the crow may join a talk uncalled: not within the gap after her last post, and as often as her boldness allows */
export function mayChime(history: TalkHistory, boldness: CrowBoldness, nextPostAt: Date | null, now: Date): boolean {
  return (nextPostAt === null || nextPostAt <= now) && history.chimes.length < BOLDNESS[boldness].chimesPerHour;
}

/** Why the crow may not speak uncalled now, for the log, or null when she may */
function uncalledPause(history: TalkHistory, chat: TalkChat, now: Date): string | null {
  if (mayChime(history, chat.boldness, chat.nextPostAt, now)) return null;
  return chat.nextPostAt && chat.nextPostAt > now ? 'the gap after her last post' : 'enough chime-ins this hour';
}

/**
 * The crow's turn in a thread, by the depth of her post the cat answered: she
 * answers four exchanges, then flies off, and after that keeps quiet there.
 */
export function threadTurn(depth: number): 'answer' | 'fly-off' | 'silent' {
  if (depth < THREAD_EXCHANGES) return 'answer';
  return depth === THREAD_EXCHANGES ? 'fly-off' : 'silent';
}

export interface WrittenTalk {
  /** Null when she keeps quiet: she had nothing to say, or the text still failed after the rewrite */
  text: string | null;
  /** She had nothing to say, rather than failing the checks */
  declined: boolean;
  /** The labels of her details (`Z…`) and her posts (`P…`) she told, of those the request gave */
  snippetIds: string[];
  postIds: string[];
  userTone: ConversationResult['userTone'] | null;
  attempts: Attempt[];
}

/**
 * The gate and the answer, checked as the arcs are: an attempt, the checks, one
 * rewrite with the problems listed. On either attempt she may choose to keep quiet.
 */
export async function writeTalk(
  write: (request: ConversationRequest) => Promise<Priced<ConversationResult>>,
  request: ConversationRequest,
  allowed: Set<string>,
): Promise<WrittenTalk> {
  const details = new Set(request.stories.flatMap((story) => story.details.map((detail) => detail.id)));
  const planned = new Set(request.stories.flatMap((story) => story.planned.map((post) => post.id)));
  const { value, problems, attempts } = await writeChecked(
    write,
    request,
    (result) => ({ result, text: crowPrefix(result.text.trim()).text }),
    ({ result, text }) => (result.shouldReply ? textProblems(text, allowed, request.maxLength) : []),
  );
  const { result, text } = value;
  const spoke = result.shouldReply && problems.length === 0;
  const known = (ids: string[], labels: Set<string>) => (spoke ? [...new Set(ids)].filter((id) => labels.has(id)) : []);
  return {
    text: spoke ? text : null,
    declined: !result.shouldReply,
    snippetIds: known(result.snippetIds, details),
    postIds: known(result.postIds, planned),
    userTone: result.userTone ?? null,
    attempts,
  };
}

/** A post of the arc as a talk may tell it: the text, and its table in lines */
function plannedText(text: string, table: CrowTable | null): string {
  if (!table) return text;
  return [text, ...[table.header, ...table.rows].map((row) => row.join(' | '))].join('\n');
}

type ConversationStore = Pick<
  CrowStore,
  | 'talkChat'
  | 'repliedPost'
  | 'countReply'
  | 'optedOut'
  | 'talkedStories'
  | 'toldStories'
  | 'storyMaterial'
  | 'talkHistory'
  | 'recentPosts'
  | 'chatMessagesBefore'
  | 'chatMessage'
  | 'profile'
  | 'createTalkPost'
  | 'materialScores'
>;

/** What the crow says in a talk, before it becomes a post */
interface Talk {
  kind: 'reply' | 'chime' | 'told';
  text: string;
  storyId: number | null;
  depth: number;
  snippetIds: number[];
  /** Posts of an arc it tells ahead of their turn */
  postIds: number[];
  extras?: CrowPostExtras;
}

/** The model's calls of a talk: an answer or a chime-in, and a «я ж казала» */
export interface TalkWriters {
  talk: (request: ConversationRequest) => Promise<Priced<ConversationResult>>;
  told: (request: ToldRequest) => Promise<Priced<ToldResult>>;
}

/**
 * The crow in a talk (docs/crow/behavior.md#talking-in-the-chat): she answers the
 * cats who reply to her posts or call her, joins a talk about a story she has
 * more to tell, and says «я ж казала» to a cat who brings news she told before.
 * `hear` decides at once whether a message is for her; the answer — a model
 * call, seconds long — is the work it hands back, to run in the background.
 */
export class CrowConversation {
  private readonly factVectors: FactVectors | null;

  constructor(
    private readonly store: ConversationStore,
    private readonly write: TalkWriters,
    /** Sends a post created `sending`; true once Telegram took it */
    private readonly send: (post: CrowPost) => Promise<boolean>,
    private readonly clock: () => Date = () => new Date(),
    /** EmbeddingGemma and its thresholds: a talk or a forward about a story is heard by its meaning too; by names only without it */
    private readonly meaning: Meaning | null = null,
  ) {
    this.factVectors = meaning ? new FactVectors(meaning.embed) : null;
  }

  /**
   * The work of answering a message, or null when it is not for her: nothing to
   * answer, or she may not talk now. A reply to her post counts either way.
   */
  async hear(message: HeardMessage, botUsername?: string): Promise<(() => Promise<void>) | null> {
    const now = this.clock();
    const chat = await this.store.talkChat(message.chatId);
    if (!chat) return null;
    const post = message.replyToMessageId === null ? null : await this.store.repliedPost(message.chatId, message.replyToMessageId);
    if (post) await this.store.countReply(post.id);
    if (!CrowConversation.listening(chat, now)) return null;
    const forwarded = message.forwardedAt !== null;
    if (post && !forwarded) return () => this.reply(message, post);
    if (!forwarded && crowCalled(message.text, botUsername)) return () => this.reply(message, null);
    // «🙅 Не чіпай мене»: she answers such a cat who calls her, but does not join their talk
    if ((await this.store.optedOut(message.chatId)).has(message.userId)) return null;
    if (forwarded || message.urls.length > 0) {
      const told = await this.store.toldStories(message.chatId, new Date(now.getTime() - TOLD_WINDOW_MS));
      const brought = broughtStory(message, told, storyNamer);
      if (brought) return () => this.toldYou(message, brought.story, brought.sameSource);
      // A forward that names none of her stories may still tell one of them in other words
      if (forwarded) {
        const fresh = told.filter((story) => !story.toldYou);
        return this.meaning && fresh.length > 0 && enoughWords(message.text) ? () => this.toldByMeaning(message, fresh) : null;
      }
    }
    const talked = await this.store.talkedStories(message.chatId, new Date(now.getTime() - ACTIVE_STORY_MS));
    const names = storyNamer(message.text);
    const named = talked.filter((story) => names(story.aliases)).map((story) => story.storyId);
    if (named.length > 0) return () => this.chime(message, named, 'aliases');
    if (!this.meaning || talked.length === 0 || !enoughWords(message.text)) return null;
    return () => this.chime(message, talked.map((story) => story.storyId), 'meaning');
  }

  /** She talks in a chat that hears her, outside its quiet hours and while nobody sent her away */
  private static listening(chat: TalkChat | null, now: Date): chat is TalkChat {
    if (!chat || (chat.snoozedUntil && chat.snoozedUntil > now)) return false;
    return !isQuiet(now, chat.timeZone, chat.quietFrom, chat.quietTo);
  }

  /** An answer to a cat who replied to her post (`post`) or called her */
  private async reply(message: HeardMessage, post: RepliedPost | null) {
    const now = this.clock();
    const chat = await this.store.talkChat(message.chatId);
    if (!CrowConversation.listening(chat, now)) return;
    const turn = threadTurn(post?.depth ?? 0);
    if (turn === 'silent') return;
    // A reply to a talk of hers goes on its thread; a reply to an arc's post, or a call, begins a talk
    const continuing = (post?.depth ?? 0) >= 1;
    if (!mayReply(await this.store.talkHistory(message.chatId, now), message.userId, now, continuing)) {
      console.log(`${LOG_PREFIX} No answer to ${message.name} in chat ${getLinkChatId(Number(message.chatId))}: enough for now`);
      return;
    }
    const depth = (post?.depth ?? 0) + 1;
    if (turn === 'fly-off') {
      const storyId = post?.storyIds[0] ?? null;
      await this.post(message, { kind: 'reply', text: FLY_OFF_TEXT, storyId, depth, snippetIds: [], postIds: [] });
      return;
    }
    let storyIds = post?.storyIds ?? [];
    if (storyIds.length === 0) {
      const talked = await this.store.talkedStories(message.chatId, new Date(now.getTime() - ACTIVE_STORY_MS));
      const names = storyNamer(message.text);
      const named = talked.filter((story) => names(story.aliases));
      storyIds = (named.length > 0 ? named : talked).slice(0, REPLY_STORIES).map((story) => story.storyId);
    }
    await this.answer('reply', message, post, storyIds, depth);
  }

  /**
   * Her word in a talk about her stories that nobody called her into: stories its aliases name, or those it comes
   * close to by meaning. The scores are logged either way, to calibrate the threshold on the chat's own talk
   */
  private async chime(message: HeardMessage, storyIds: number[], heardBy: 'aliases' | 'meaning') {
    const scores = await this.materialScores(message, storyIds);
    const best = bestByStory(scores ?? []);
    const threshold = this.meaning?.talkThreshold ?? 1;
    const close = best.filter((score) => score.similarity >= threshold).map((score) => score.storyId);
    const chat = getLinkChatId(Number(message.chatId));
    if (scores) {
      const verdict = heardBy === 'aliases' ? '' : close.length > 0 ? ' → the gate' : ' — below it';
      console.log(`${LOG_PREFIX} Talk of ${message.name} in chat ${chat}, by ${heardBy}, threshold ${threshold}: ${scoreLine(best)}${verdict}`);
    }
    if (heardBy === 'meaning' && close.length === 0) return;
    const now = this.clock();
    const talkChat = await this.store.talkChat(message.chatId);
    if (!CrowConversation.listening(talkChat, now)) return;
    const pause = uncalledPause(await this.store.talkHistory(message.chatId, now), talkChat, now);
    if (pause) {
      console.log(`${LOG_PREFIX} No chime-in on ${message.name} in chat ${chat}: ${pause}`);
      return;
    }
    await this.answer('chime', message, null, heardBy === 'aliases' ? storyIds : close, 1, scores);
  }

  /** How close the message — with the one it replies to — is to what she may still say of the stories; null without the model */
  private async materialScores(message: HeardMessage, storyIds: number[]): Promise<MaterialScore[] | null> {
    if (!this.meaning) return null;
    const repliedTo =
      message.replyToMessageId === null ? null : await this.store.chatMessage(message.chatId, message.replyToMessageId);
    const [vector] = await embedOrNone(this.meaning.embed, [talkText(message.text, repliedTo?.text ?? null)], 'query');
    return vector ? this.store.materialScores(message.chatId, storyIds, vector) : null;
  }

  private async answer(
    kind: 'reply' | 'chime',
    message: HeardMessage,
    post: RepliedPost | null,
    storyIds: number[],
    depth: number,
    /** How close the message is to the details and posts, to give the model the closest first; none — their order */
    scores: MaterialScore[] | null = null,
  ) {
    const now = this.clock();
    const closeness = (kind: MaterialScore['kind'], id: number) =>
      scores?.find((score) => score.kind === kind && score.id === id)?.similarity ?? 0;
    // Uncalled, she speaks only with something the chat has not heard
    const materials = (await this.store.storyMaterial(message.chatId, storyIds))
      .filter((story) => kind === 'reply' || story.details.length + story.planned.length > 0)
      .map((story) =>
        scores
          ? {
              ...story,
              details: [...story.details].sort((a, b) => closeness('detail', b.id) - closeness('detail', a.id)),
              planned: [...story.planned].sort((a, b) => closeness('post', b.id) - closeness('post', a.id)),
            }
          : story,
      );
    if (kind === 'chime' && materials.length === 0) return;

    // Labels for the model across the stories: Z1… her details, P1… her posts
    const details = new Map<string, number>();
    const planned = new Map<string, number>();
    const stories: ConversationStory[] = materials.map((story) => ({
      title: story.title,
      facts: story.facts,
      details: story.details.slice(0, DETAILS_PER_STORY).map((detail) => {
        const id = `Z${details.size + 1}`;
        details.set(id, detail.id);
        return { id, text: detail.text };
      }),
      planned: story.planned.slice(0, PLANNED_PER_STORY).map((item) => {
        const id = `P${planned.size + 1}`;
        planned.set(id, item.id);
        return { id, text: plannedText(item.text, item.table) };
      }),
    }));

    const optedOut = await this.store.optedOut(message.chatId);
    const recentChat = (await this.store.chatMessagesBefore(message.chatId, message.messageId, RECENT_CHAT))
      .filter((line) => !optedOut.has(line.userId))
      .map((line) => `${line.name}: ${line.text}`);
    const recentPosts = (await this.store.recentPosts(message.chatId, MEMORY_POSTS)).map((post) => memoryLine(post, now));
    const thread = post ? await this.thread(message.chatId, post) : [];
    const profile = optedOut.has(message.userId) ? null : await this.store.profile(message.chatId);
    const catTopics = profile?.members.find((member) => member.userId === message.userId)?.topics ?? [];
    const request: ConversationRequest = {
      kind,
      message: { name: message.name, text: message.text },
      thread,
      recentChat,
      stories,
      recentPosts,
      catTopics,
      maxLength: MAX_TALK_LENGTH,
    };
    const allowed = allowedNumbers(
      message.text,
      ...thread,
      ...recentChat,
      ...recentPosts,
      ...stories.flatMap((story) => [...story.facts, ...story.details, ...story.planned].map((item) => item.text)),
    );

    const written = await writeTalk(this.write.talk, request, allowed);
    const costUsd = attemptsCost(written.attempts);
    const chat = getLinkChatId(Number(message.chatId));
    const what = kind === 'reply' ? 'Answer to' : 'Chime-in on';
    if (written.text === null) {
      const why = written.declined ? 'nothing to say' : `failed its checks: ${written.attempts.at(-1)!.problems.join('; ')}`;
      console.log(`${LOG_PREFIX} ${what} ${message.name} in chat ${chat}: ${why} ($${costUsd.toFixed(4)})`);
      return;
    }
    const snippetIds = written.snippetIds.map((id) => details.get(id)!);
    const postIds = written.postIds.map((id) => planned.get(id)!);
    // The story the talk told of: the one her details or posts come from, or the only one there was
    const told = materials.find((story) =>
      story.details.some((d) => snippetIds.includes(d.id)) || story.planned.some((p) => postIds.includes(p.id)),
    );
    const storyId = told?.storyId ?? (materials.length === 1 ? materials[0].storyId : (post?.storyIds[0] ?? null));
    await this.post(message, { kind, text: written.text, storyId, depth, snippetIds, postIds });
    console.log(
      `${LOG_PREFIX} ${what} ${message.name} in chat ${chat}: ${snippetIds.length} details, ${postIds.length} posts told ahead, ` +
        `tone ${written.userTone} ($${costUsd.toFixed(4)})`,
    );
  }

  /**
   * «Я ж казала» to a cat who brought news she told the chat before: once per story in the chat, uncalled
   * like a chime-in — after the gap since her last post, within her chime-ins of the hour — and in the
   * character of who was faster: she, or the channel the cat forwarded
   */
  private async toldYou(message: HeardMessage, story: ToldStory, sameSource: boolean) {
    const now = this.clock();
    const chat = await this.store.talkChat(message.chatId);
    if (!CrowConversation.listening(chat, now)) return;
    const chatLink = getLinkChatId(Number(message.chatId));
    const pause = uncalledPause(await this.store.talkHistory(message.chatId, now), chat, now);
    if (pause) {
      console.log(`${LOG_PREFIX} No «я ж казала» to ${message.name} in chat ${chatLink}: ${pause}`);
      return;
    }
    const ago = agoLabel(now.getTime() - story.sentAt.getTime());
    const recentPosts = (await this.store.recentPosts(message.chatId, MEMORY_POSTS)).map((post) => memoryLine(post, now));
    const request: ToldRequest = {
      message: { name: message.name, text: message.text },
      origin: message.origin,
      forwarded: message.forwardedAt !== null,
      sameSource,
      sourceWasFaster: message.forwardedAt !== null && message.forwardedAt < story.sentAt,
      story: { title: story.title, facts: story.facts },
      told: { text: story.text, ago },
      recentPosts,
      maxLength: MAX_TOLD_LENGTH,
    };
    const allowed = allowedNumbers(message.text, story.title, story.text, ...story.facts.map((fact) => fact.text), ...recentPosts);
    const written = await writeTold(this.write.told, request, allowed);
    const costUsd = attemptsCost(written.attempts);
    if (written.text === null) {
      const why = written.declined ? 'other news' : `failed its checks: ${written.attempts.at(-1)!.problems.join('; ')}`;
      console.log(`${LOG_PREFIX} «Я ж казала» to ${message.name} in chat ${chatLink}: ${why} ($${costUsd.toFixed(4)})`);
      return;
    }
    // A link to her post works in a supergroup, which every chat of the crow's is by now
    const link = supergroupMessageLink(message.chatId, story.tgMessageId);
    const extras: CrowPostExtras = {
      moments: { told: { unixTime: Math.floor(story.sentAt.getTime() / 1000), format: 'r', fallback: ago } },
      ...(link ? { anchors: { post: { label: '💬', url: link } } } : {}),
    };
    const text = written.text.replace('{when}', link ? '{when:told} {link:post}' : '{when:told}');
    await this.post(message, { kind: 'told', text, storyId: story.storyId, depth: 1, snippetIds: [], postIds: [], extras });
    console.log(`${LOG_PREFIX} «Я ж казала» to ${message.name} in chat ${chatLink}: story ${story.storyId} ($${costUsd.toFixed(4)})`);
  }

  /**
   * A forward that names none of her stories, heard by its meaning: its similarity to the facts of the stories she
   * told the chat. Close enough, it is a «я ж казала» — the model still says whether it is the same news
   */
  private async toldByMeaning(message: HeardMessage, stories: ToldStory[]) {
    if (!this.meaning) return;
    const threshold = this.meaning.forwardThreshold;
    const [vector] = await embedOrNone(this.meaning.embed, [message.text], 'similarity');
    if (!vector) return;
    const scores = await this.factVectors!.scores(stories, vector);
    const [best] = scores;
    const close = best !== undefined && best.similarity >= threshold;
    console.log(
      `${LOG_PREFIX} Forward of ${message.name} in chat ${getLinkChatId(Number(message.chatId))}, threshold ${threshold}: ` +
        `${scoreLine(scores)}${close ? ' → «я ж казала»' : ' — below it'}`,
    );
    const story = close ? stories.find((s) => s.storyId === best.storyId) : undefined;
    if (story) await this.toldYou(message, story, false);
  }

  /** What the cat answered: her post, and before it the cat's message her post answered, if it was a talk of hers */
  private async thread(chatId: string, post: RepliedPost): Promise<string[]> {
    const lines = [`Кара: ${post.text}`];
    if (post.replyToMessageId !== null) {
      const earlier = await this.store.chatMessage(chatId, post.replyToMessageId);
      if (earlier) lines.unshift(`${earlier.name}: ${earlier.text}`);
    }
    return lines;
  }

  /** The talk becomes a post of the chat, the arc posts it tells go from the queue, and it is sent at once */
  private async post(message: HeardMessage, talk: Talk) {
    const post = await this.store.createTalkPost(
      {
        chatId: message.chatId,
        kind: talk.kind,
        text: talk.text,
        storyId: talk.storyId,
        depth: talk.depth,
        snippetIds: talk.snippetIds,
        replyToMessageId: message.messageId,
        replyToUserId: message.userId,
        extras: talk.extras ?? null,
      },
      talk.postIds,
      this.clock(),
    );
    await this.send(post);
  }
}
