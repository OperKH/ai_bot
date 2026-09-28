import { describe, it } from 'node:test';
import type { MaterialScore } from '../dataSource/vectorSearch';
import type { TextEmbeddingTask } from '../services/ai.service';
import assert from 'node:assert/strict';
import type { Message } from 'grammy/types';
import type { CrowPost } from '../entity/CrowPost.entity';
import { allowedNumbers } from './arcValidation';
import { BOLDNESS } from './cadence';
import { trigramSimilarity, wordTrigrams } from './clustering';
import {
  cleanSnippets,
  crowCalled,
  CrowConversation,
  FLY_OFF_TEXT,
  type HeardMessage,
  heardMessage,
  mayChime,
  mayReply,
  storyNamer,
  storyAliases,
  threadTurn,
  writeTalk,
} from './conversation';
import { type ConversationRequest, type ConversationResult, type ToldRequest, type ToldResult, toldPrompt } from './prompts';
import type { NewTalkPost, RepliedPost, StoryMaterial, TalkChat, TalkedStory } from './store';
import type { ToldStory } from './toldYou';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-27T12:00:00Z');

describe('heardMessage', () => {
  const message = (patch: Record<string, unknown>) =>
    ({
      message_id: 7,
      date: 0,
      chat: { id: -100, type: 'supergroup', title: 'Коти' },
      from: { id: 42, is_bot: false, first_name: 'Олег', username: 'oleg' },
      text: 'опус новий хтось юзав?',
      ...patch,
    }) as unknown as Message;

  it('hears the text of a cat in a group, and the message it replies to', () => {
    assert.deepEqual(heardMessage(message({ reply_to_message: { message_id: 5 } })), {
      chatId: '-100',
      messageId: 7,
      userId: '42',
      name: 'Олег',
      text: 'опус новий хтось юзав?',
      replyToMessageId: 5,
      forwardedAt: null,
      origin: null,
      urls: [],
    });
    assert.equal(heardMessage(message({ text: undefined, caption: 'а це опус' }))?.text, 'а це опус');
  });

  it('does not hear commands, bots, what a bot posted, private chats or messages without text', () => {
    assert.equal(heardMessage(message({ text: '/crow' })), null);
    assert.equal(heardMessage(message({ from: { id: 1, is_bot: true, first_name: 'Бот' } })), null);
    assert.equal(heardMessage(message({ via_bot: { id: 2, is_bot: true, first_name: 'gif' } })), null);
    assert.equal(heardMessage(message({ chat: { id: 42, type: 'private', first_name: 'Олег' } })), null);
    assert.equal(heardMessage(message({ text: undefined })), null);
  });

  it('hears a forwarded post with when its original came out and where from, and the links of a message', () => {
    const forwarded = heardMessage(
      message({
        text: 'Anthropic випустили Opus 5.5 — деталі',
        entities: [{ type: 'text_link', offset: 32, length: 6, url: 'https://www.anthropic.com/news/claude-opus-5-5' }],
        forward_origin: { type: 'channel', date: 1790000000, chat: { id: -1001, type: 'channel', title: 'ШІ новини' }, message_id: 5 },
      }),
    );
    assert.deepEqual(forwarded?.forwardedAt, new Date(1790000000 * 1000));
    assert.equal(forwarded?.origin, 'ШІ новини');
    assert.deepEqual(forwarded?.urls, ['https://www.anthropic.com/news/claude-opus-5-5']);
    const linked = heardMessage(
      message({
        text: 'дивіться anthropic.com/news/claude-opus-5-5',
        entities: [{ type: 'url', offset: 9, length: 34 }],
        link_preview_options: { url: 'https://anthropic.com/news/claude-opus-5-5' },
      }),
    );
    assert.equal(linked?.forwardedAt, null);
    assert.deepEqual(linked?.urls, ['anthropic.com/news/claude-opus-5-5', 'https://anthropic.com/news/claude-opus-5-5']);
  });
});

describe('crowCalled', () => {
  it('hears her called by «ворона» in any case, «Каро», @username, or «Кара,» opening a message', () => {
    assert.ok(crowCalled('Каро, а що там по лімітах?'));
    assert.ok(crowCalled('спитайте ворону, вона знає'));
    assert.ok(crowCalled('ну що, вороно, скажеш?'));
    assert.ok(crowCalled('Кара, скажи їм'));
    assert.ok(crowCalled('@SightScribeBot глянь', 'SightScribeBot'));
  });

  it('does not take «кара» inside a sentence, or words that only begin like her name', () => {
    assert.equal(crowCalled('це кара божа, а не патч'), false);
    assert.equal(crowCalled('каракулі якісь'), false);
    assert.equal(crowCalled('воронка знову'), false);
    assert.equal(crowCalled('@other_bot глянь', 'SightScribeBot'), false);
  });
});

describe('storyNamer', () => {
  const opus = ['claude opus 5.5', 'opus', 'опус', 'клод', 'anthropic'];
  const namesStory = (text: string, aliases: string[]) => storyNamer(text)(aliases);
  const similarity = (a: string, b: string) => trigramSimilarity(wordTrigrams(a), wordTrigrams(b));

  it('finds an alias as a word, with an ending, with a typo, or several words in a row', () => {
    assert.ok(namesStory('опус новий хтось юзав? шо по лімітах', opus));
    assert.ok(namesStory('я вчора з опусом сидів', opus));
    assert.ok(namesStory('Anthropik знову щось викотили', opus));
    assert.ok(namesStory('а Claude Opus 5.5 вже в API?', ['claude opus 5.5']));
    assert.ok(namesStory('ця зельді ваша', ['зельда']));
  });

  it('does not find a story in a message about something else, nor by a two-letter alias', () => {
    assert.equal(namesStory('шо на обід?', opus), false);
    assert.equal(namesStory('опера сьогодні', opus), false);
    assert.equal(namesStory('ai знову', ['ai']), false);
    assert.equal(namesStory('це claude code', ['claude opus 5.5']), false);
  });

  it('counts trigrams as pg_trgm does', () => {
    assert.equal(similarity('опус', 'опус'), 1);
    assert.ok(similarity('anthropik', 'anthropic') > 0.6);
    assert.ok(similarity('опус', 'обід') < 0.2);
  });
});

describe('the store for talks', () => {
  it('keeps the hero among the aliases, lowercase, once, and leaves out words that name any story', () => {
    assert.deepEqual(storyAliases(['Opus', 'опус', 'модель', 'ai', ' Клод '], 'Claude Opus 5.5'), [
      'claude opus 5.5',
      'opus',
      'опус',
      'клод',
    ]);
    assert.deepEqual(storyAliases([], null), []);
  });

  it('keeps the details once each and of a sane length', () => {
    const long = 'а'.repeat(301);
    const { details } = cleanSnippets({ details: ['Деталь.', ' Деталь. ', long, ''], aliases: [] }, null);
    assert.deepEqual(details, ['Деталь.']);
  });
});

describe('the limits of a talk', () => {
  const reply = (userId: string, iso: string, depth = 1) => ({ userId, sentAt: at(iso), depth });

  it('begins three talks with a cat in ten minutes, and answers the chat twelve times in an hour', () => {
    const three = [reply('1', '2026-09-27T11:52:00Z'), reply('1', '2026-09-27T11:55:00Z'), reply('1', '2026-09-27T11:58:00Z')];
    assert.equal(mayReply({ replies: three, chimes: [] }, '1', NOW), false);
    assert.equal(mayReply({ replies: three, chimes: [] }, '2', NOW), true);
    assert.equal(mayReply({ replies: three.slice(1), chimes: [] }, '1', NOW), true);
    const twelve = Array.from({ length: 12 }, (_, i) => reply(String(i), '2026-09-27T11:30:00Z'));
    assert.equal(mayReply({ replies: twelve, chimes: [] }, 'new', NOW), false);
    assert.equal(mayReply({ replies: twelve, chimes: [] }, 'new', NOW, true), false, 'a thread too');
  });

  it('goes on a thread of hers to its end, however many talks the cat began', () => {
    // A call, a reply to her arc, then the thread of the second: depths 1, 1, 2 within three minutes
    const talks = [reply('1', '2026-09-27T11:57:00Z'), reply('1', '2026-09-27T11:58:00Z'), reply('1', '2026-09-27T11:59:00Z', 2)];
    assert.equal(mayReply({ replies: talks, chimes: [] }, '1', NOW, true), true, 'the thread goes on');
    assert.equal(mayReply({ replies: talks, chimes: [] }, '1', NOW), true, 'the thread’s answers are no talks begun');
    const begun = [...talks, reply('1', '2026-09-27T11:59:30Z')];
    assert.equal(mayReply({ replies: begun, chimes: [] }, '1', NOW), false, 'a fourth talk begun');
  });

  it('chimes in after the gap since her last post, as often an hour as her boldness allows', () => {
    const chimes = (count: number) => ({ replies: [], chimes: Array.from({ length: count }, () => at('2026-09-27T11:30:00Z')) });
    assert.equal(mayChime(chimes(0), 'bold', null, NOW), true);
    assert.equal(mayChime(chimes(0), 'bold', at('2026-09-27T12:03:00Z'), NOW), false, 'within the gap');
    assert.equal(mayChime(chimes(BOLDNESS.restrained.chimesPerHour), 'restrained', null, NOW), false);
    assert.equal(mayChime(chimes(BOLDNESS.restrained.chimesPerHour), 'pestering', null, NOW), true);
    assert.deepEqual(
      [BOLDNESS.restrained.chimesPerHour, BOLDNESS.bold.chimesPerHour, BOLDNESS.pestering.chimesPerHour],
      [2, 4, 6],
    );
  });

  it('answers four exchanges of a thread, flies off, then keeps quiet there', () => {
    assert.deepEqual([0, 1, 3, 4, 5, 9].map(threadTurn), ['answer', 'answer', 'answer', 'fly-off', 'silent', 'silent']);
  });
});

const story = (patch: Partial<ConversationRequest['stories'][number]> = {}) => ({
  title: 'Claude Opus 5.5',
  facts: [{ id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' }],
  details: [{ id: 'Z1', text: 'Вікно контексту — 1 мільйон токенів.' }],
  planned: [{ id: 'P1', text: '🐦‍⬛ Генерація на 30% швидша.' }],
  ...patch,
});

const baseRequest: ConversationRequest = {
  kind: 'chime',
  message: { name: 'Олег', text: 'опус новий хтось юзав?' },
  thread: [],
  recentChat: [],
  stories: [story()],
  recentPosts: [],
  catTopics: [],
  nickname: null,
  maxLength: 400,
};

const answer = (patch: Partial<ConversationResult> = {}): ConversationResult => ({
  shouldReply: true,
  text: '🐦‍⬛ Юзала першою. Вікно — 1 мільйон токенів.',
  snippetIds: [],
  postIds: [],
  userTone: 'friendly',
  nickname: null,
  ...patch,
});

/** A model that answers from a list, one answer per call, and remembers what it was asked */
function fakeModel(...answers: ConversationResult[]) {
  const requests: ConversationRequest[] = [];
  const write = async (request: ConversationRequest) => {
    requests.push(request);
    return { result: answers[Math.min(requests.length, answers.length) - 1], costUsd: 0.0003 };
  };
  return { write, requests };
}

describe('writeTalk', () => {
  const allowed = allowedNumbers('1 мільйон', '20%', '30%', '5.5');

  it('keeps a nickname of a few words of letters, not the cat’s own name', async () => {
    const nickname = async (given: string | null) =>
      (await writeTalk(fakeModel(answer({ nickname: given })).write, baseRequest, allowed)).nickname;
    assert.equal(await nickname('«сірий вовче»'), 'сірий вовче');
    assert.equal(await nickname('Олег'), null);
    assert.equal(await nickname('агент 007'), null);
    assert.equal(await nickname('дуже довге прізвисько з чотирьох слів'), null);
    assert.equal(await nickname(null), null);
    const quiet = await writeTalk(fakeModel(answer({ shouldReply: false, nickname: 'вовче' })).write, baseRequest, allowed);
    assert.equal(quiet.nickname, null, 'no nickname when she keeps quiet');
  });

  it('keeps the text and the labels of the store it told, those the request gave only', async () => {
    const model = fakeModel(answer({ text: 'Юзала першою.', snippetIds: ['Z1', 'Z9'], postIds: ['P1', 'Z1'] }));
    const written = await writeTalk(model.write, baseRequest, allowed);
    assert.equal(written.text, '🐦‍⬛ Юзала першою.');
    assert.deepEqual(written.snippetIds, ['Z1']);
    assert.deepEqual(written.postIds, ['P1']);
  });

  it('keeps quiet when the model sees nothing to say, without checks', async () => {
    const written = await writeTalk(fakeModel(answer({ shouldReply: false, text: '' })).write, baseRequest, allowed);
    assert.equal(written.text, null);
    assert.equal(written.declined, true);
  });

  it('rewrites a text that fails the checks once, then gives up', async () => {
    const model = fakeModel(answer({ text: '🐦‍⬛ Дешевший на 40%.' }), answer({ text: '🐦‍⬛ Дешевший на 20%.' }));
    assert.equal((await writeTalk(model.write, baseRequest, allowed)).text, '🐦‍⬛ Дешевший на 20%.');
    assert.deepEqual(model.requests[1].corrections, ['числа 40 немає у фактах']);
    const stubborn = fakeModel(answer({ text: '🐦‍⬛ О 18:00.' }));
    const written = await writeTalk(stubborn.write, baseRequest, allowed);
    assert.equal(written.text, null);
    assert.equal(written.declined, false);
  });
});

const chat = (patch: Partial<TalkChat> = {}) =>
  ({
    chatId: '-100',
    boldness: 'bold',
    quietFrom: 1380,
    quietTo: 600,
    snoozedUntil: null,
    nextPostAt: null,
    timeZone: 'Europe/Kyiv',
    ...patch,
  }) as TalkChat;

const opusMaterial = (patch: Partial<StoryMaterial> = {}): StoryMaterial => ({
  storyId: 9,
  title: 'Anthropic Introduces Claude Opus 5.5',
  facts: [{ id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' }],
  details: [{ id: 301, text: 'Вікно контексту Opus 5.5 — 1 мільйон токенів.' }],
  planned: [{ id: 77, text: '🐦‍⬛ Генерація на 30% швидша.', table: null }],
  ...patch,
});

const toldOpus = (patch: Partial<ToldStory> = {}): ToldStory => ({
  storyId: 9,
  title: 'Anthropic Introduces Claude Opus 5.5',
  facts: [{ id: 'F1', text: 'Opus 5.5 на 20% дешевший за Opus 5' }],
  aliases: ['claude opus 5.5', 'opus', 'опус'],
  sources: [{ url: 'https://www.anthropic.com/news/claude-opus-5-5', publisher: 'Anthropic', official: true }],
  sentAt: at('2026-09-27T09:00:00Z'),
  tgMessageId: 1366,
  text: '🐦‍⬛🐦‍⬛🐦‍⬛ Прильот про Opus 5.5',
  toldYou: false,
  ...patch,
});

/** A store with one chat, one talked-about story and what the conversation asks of it */
function fakeStore(options: {
  chat?: TalkChat | null;
  replied?: RepliedPost | null;
  talked?: TalkedStory[];
  material?: StoryMaterial[];
  optedOut?: string[];
  replies?: { userId: string | null; sentAt: Date; depth: number }[];
  chimes?: Date[];
  told?: ToldStory[];
  /** How close a message is to the details and posts, as the vector search would say */
  scores?: MaterialScore[];
  nicknames?: Map<string, string>;
} = {}) {
  const created: { talk: NewTalkPost; consumed: number[] }[] = [];
  const nicknames = options.nicknames ?? new Map<string, string>();
  const counted: number[] = [];
  const store = {
    talkChat: async () => (options.chat === undefined ? chat() : options.chat),
    repliedPost: async () => options.replied ?? null,
    countReply: async (postId: number) => {
      counted.push(postId);
    },
    optedOut: async () => new Set(options.optedOut ?? []),
    talkedStories: async () => options.talked ?? [{ storyId: 9, aliases: ['claude opus 5.5', 'opus', 'опус'] }],
    toldStories: async () => options.told ?? [toldOpus()],
    storyMaterial: async (_chatId: string, ids: number[]) =>
      (options.material ?? [opusMaterial()]).filter((m) => ids.includes(m.storyId)),
    talkHistory: async () => ({ replies: options.replies ?? [], chimes: options.chimes ?? [] }),
    recentPosts: async () => [{ text: '🐦‍⬛🐦‍⬛🐦‍⬛ Прильот про Opus 5.5', sentAt: at('2026-09-27T09:00:00Z') }],
    chatMessagesBefore: async () => [
      { userId: '5', name: 'Іра', text: 'хто вже пробував?' },
      { userId: '6', name: 'Тихий', text: 'я не скажу' },
    ],
    chatMessage: async () => ({ userId: '42', name: 'Олег', text: 'а він швидкий?' }),
    nickname: async (_chatId: string, userId: string) => nicknames.get(userId) ?? null,
    // As the store does: a cat who asked to be left alone gets no nickname
    setNickname: async (_chatId: string, userId: string, nickname: string) => {
      if (!options.optedOut?.includes(userId)) nicknames.set(userId, nickname);
    },
    profile: async () => ({
      interests: [],
      memes: [],
      members: [{ userId: '42', name: 'Олег', username: 'oleg', topics: ['сидить на Claude Code'] }],
    }),
    createTalkPost: async (talk: NewTalkPost, consumed: number[]) => {
      created.push({ talk, consumed });
      return { id: 500 + created.length, ...talk } as unknown as CrowPost;
    },
    materialScores: async (_chatId: string, ids: number[]) => (options.scores ?? []).filter((s) => ids.includes(s.storyId)),
  };
  return { store, created, counted, nicknames };
}

/**
 * EmbeddingGemma as a fake: what it was asked, and a vector by what the text is about — Anthropic's news, or
 * anything else; the talks' scores come from the store, a forward's from these
 */
function fakeEmbedder() {
  const asked: { texts: string[]; task: TextEmbeddingTask }[] = [];
  const embed = async (texts: string[], task: TextEmbeddingTask) => {
    asked.push({ texts, task });
    return texts.map((text) => (/anthropic|opus/i.test(text) ? [1, 0] : [0, 1]));
  };
  return { embed, asked };
}

const heard = (patch: Partial<HeardMessage> = {}): HeardMessage => ({
  chatId: '-100',
  messageId: 900,
  userId: '42',
  name: 'Олег',
  text: 'опус новий хтось юзав?',
  replyToMessageId: null,
  forwardedAt: null,
  origin: null,
  urls: [],
  ...patch,
});

/** Runs what the conversation hears, as the command's queue would */
async function run(conversation: CrowConversation, message: HeardMessage) {
  const work = await conversation.hear(message, 'SightScribeBot');
  await work?.();
  return work !== null;
}

/** A model of «я ж казала» that answers from a list, as `fakeModel` does */
function fakeTold(...answers: ToldResult[]) {
  const requests: ToldRequest[] = [];
  const write = async (request: ToldRequest) => {
    requests.push(request);
    return { result: answers[Math.min(requests.length, answers.length) - 1], costUsd: 0.0002 };
  };
  return { write, requests };
}

function conversation(
  store: ReturnType<typeof fakeStore>['store'],
  model: ReturnType<typeof fakeModel>,
  clock = NOW,
  told = fakeTold({ sameNews: true, text: '🐦‍⬛ Я про це каркала ще {when}. Читати треба ворону, котику.' }),
  embed: ReturnType<typeof fakeEmbedder>['embed'] | null = null,
) {
  const sent: CrowPost[] = [];
  const talk = new CrowConversation(
    store,
    { talk: model.write, told: told.write },
    async (post) => {
      sent.push(post);
      return true;
    },
    () => clock,
    embed ? { embed, talkThreshold: 0.25, forwardThreshold: 0.78 } : null,
  );
  return { talk, sent };
}

describe('CrowConversation', () => {
  const opusPost: RepliedPost = {
    id: 40,
    kind: 'arc',
    depth: 0,
    text: '🐦‍⬛🐦‍⬛ Мінус 20% до ціни Opus 5',
    replyToMessageId: null,
    storyIds: [9],
  };

  it('answers a cat who replied to her post, with the post and its story, and counts the reply', async () => {
    const { store, created, counted } = fakeStore({ replied: opusPost });
    const model = fakeModel(answer({ text: '🐦‍⬛ Дешевший на 20%, котику.' }));
    const { talk, sent } = conversation(store, model);
    assert.ok(await run(talk, heard({ text: 'а він хоч швидкий?', replyToMessageId: 1366 })));
    assert.deepEqual(counted, [40]);
    const request = model.requests[0];
    assert.equal(request.kind, 'reply');
    assert.deepEqual(request.thread, ['Кара: 🐦‍⬛🐦‍⬛ Мінус 20% до ціни Opus 5']);
    assert.equal(request.stories[0].title, 'Anthropic Introduces Claude Opus 5.5');
    assert.deepEqual(request.catTopics, ['сидить на Claude Code']);
    assert.deepEqual(created[0].talk, {
      chatId: '-100',
      kind: 'reply',
      text: '🐦‍⬛ Дешевший на 20%, котику.',
      storyId: 9,
      depth: 1,
      snippetIds: [],
      replyToMessageId: 900,
      replyToUserId: '42',
      extras: null,
    });
    assert.equal(sent.length, 1);
  });

  it('calls a cat by the nickname she gave him in the next talks, and gives none to a cat who asked to be left alone', async () => {
    const { store, nicknames } = fakeStore({ replied: opusPost });
    const model = fakeModel(answer({ text: '🐦‍⬛ Вовче, дешевший на 20%.', nickname: '«вовче»' }), answer({ text: '🐦‍⬛ Та швидкий, вовче.', nickname: 'вовче' }));
    const { talk } = conversation(store, model);
    await run(talk, heard({ text: 'я вовк, мені байдуже', replyToMessageId: 1366 }));
    assert.equal(model.requests[0].nickname, null);
    assert.equal(nicknames.get('42'), 'вовче');
    await run(talk, heard({ messageId: 901, text: 'а він хоч швидкий?', replyToMessageId: 1366 }));
    assert.equal(model.requests[1].nickname, 'вовче');

    const alone = fakeStore({ replied: opusPost, optedOut: ['42'] });
    const quiet = fakeModel(answer({ nickname: 'вовче' }));
    await run(conversation(alone.store, quiet).talk, heard({ text: 'ворона, я вовк', replyToMessageId: 1366 }));
    assert.equal(alone.nicknames.size, 0);
  });

  it('answers a cat who calls her by name, about the stories the message names or the latest', async () => {
    const { store, created } = fakeStore();
    const model = fakeModel(answer({ text: '🐦‍⬛ Що, котику?' }));
    const { talk } = conversation(store, model);
    assert.ok(await run(talk, heard({ text: 'Каро, шо нового?' })));
    assert.equal(model.requests[0].kind, 'reply');
    assert.equal(model.requests[0].stories.length, 1);
    assert.equal(created[0].talk.depth, 1);
  });

  it('chimes into a talk about her story, telling a detail and a post of the arc ahead of its turn', async () => {
    const { store, created } = fakeStore();
    const model = fakeModel(answer({ snippetIds: ['Z1'], postIds: ['P1'] }));
    const { talk } = conversation(store, model);
    assert.ok(await run(talk, heard()));
    const request = model.requests[0];
    assert.equal(request.kind, 'chime');
    assert.deepEqual(request.stories[0].details, [{ id: 'Z1', text: 'Вікно контексту Opus 5.5 — 1 мільйон токенів.' }]);
    assert.deepEqual(request.stories[0].planned, [{ id: 'P1', text: '🐦‍⬛ Генерація на 30% швидша.' }]);
    assert.deepEqual(request.recentChat, ['Іра: хто вже пробував?', 'Тихий: я не скажу']);
    assert.equal(created[0].talk.kind, 'chime');
    assert.deepEqual(created[0].talk.snippetIds, [301]);
    assert.deepEqual(created[0].consumed, [77]);
  });

  it('keeps out of a talk she has nothing left for, or within the gap after her last post', async () => {
    const exhausted = fakeStore({ material: [opusMaterial({ details: [], planned: [] })] });
    const model = fakeModel(answer());
    assert.ok(await run(conversation(exhausted.store, model).talk, heard()));
    assert.equal(model.requests.length, 0);

    const soon = fakeStore({ chat: chat({ nextPostAt: at('2026-09-27T12:04:00Z') }) });
    assert.ok(await run(conversation(soon.store, model).talk, heard()));
    assert.equal(soon.created.length, 0);
    assert.equal(model.requests.length, 0);
  });

  it('does not join the talk of a cat who asked not to be touched, and hides their messages', async () => {
    const { store } = fakeStore({ optedOut: ['42', '6'] });
    const model = fakeModel(answer());
    assert.equal(await run(conversation(store, model).talk, heard()), false);
    // Calling her is their choice: she answers
    const called = fakeStore({ optedOut: ['42', '6'] });
    assert.ok(await run(conversation(called.store, model).talk, heard({ text: 'Каро, а ти що скажеш?' })));
    assert.deepEqual(model.requests[0].recentChat, ['Іра: хто вже пробував?']);
    assert.deepEqual(model.requests[0].catTopics, [], 'not from the profile either');
  });

  it('hears nothing in the quiet hours, while sent away, in a chat without subscriptions or off topic', async () => {
    const model = fakeModel(answer());
    const night = conversation(fakeStore().store, model, at('2026-09-27T21:00:00Z')); // midnight in Kyiv
    assert.equal(await run(night.talk, heard({ text: 'Каро!' })), false);
    const shooed = fakeStore({ chat: chat({ snoozedUntil: at('2026-09-27T12:30:00Z') }) });
    assert.equal(await run(conversation(shooed.store, model).talk, heard({ text: 'Каро!' })), false);
    assert.equal(await run(conversation(fakeStore({ chat: null }).store, model).talk, heard({ text: 'Каро!' })), false);
    assert.equal(await run(conversation(fakeStore().store, model).talk, heard({ text: 'шо на обід?' })), false);
    assert.equal(model.requests.length, 0);
    // A reply to her post at night is not answered, but counts
    const nightReply = fakeStore({ replied: opusPost });
    assert.equal(await run(conversation(nightReply.store, model, at('2026-09-27T21:00:00Z')).talk, heard({ replyToMessageId: 1366 })), false);
    assert.deepEqual(nightReply.counted, [40]);
  });

  it('flies off after four exchanges of a thread without asking the model, and then keeps quiet there', async () => {
    const deep = fakeStore({ replied: { ...opusPost, kind: 'reply', depth: 4, replyToMessageId: 880 } });
    const model = fakeModel(answer());
    assert.ok(await run(conversation(deep.store, model).talk, heard({ replyToMessageId: 1400 })));
    assert.equal(deep.created[0].talk.text, FLY_OFF_TEXT);
    assert.equal(deep.created[0].talk.depth, 5);
    const past = fakeStore({ replied: { ...opusPost, kind: 'reply', depth: 5 } });
    assert.ok(await run(conversation(past.store, model).talk, heard({ replyToMessageId: 1401 })));
    assert.equal(past.created.length, 0);
    assert.equal(model.requests.length, 0);
  });

  it('gives the thread of a reply of hers: the cat message it answered, then it', async () => {
    const { store } = fakeStore({ replied: { ...opusPost, kind: 'reply', depth: 1, text: '🐦‍⬛ Швидкий.', replyToMessageId: 880 } });
    const model = fakeModel(answer());
    await run(conversation(store, model).talk, heard({ text: 'а дешевий?', replyToMessageId: 1400 }));
    assert.deepEqual(model.requests[0].thread, ['Олег: а він швидкий?', 'Кара: 🐦‍⬛ Швидкий.']);
  });

  it('answers the fourth exchange of her thread after three talks begun, and flies off after it', async () => {
    const recent = (iso: string, depth: number) => ({ userId: '42', sentAt: at(iso), depth });
    const busy = fakeStore({
      replied: { ...opusPost, kind: 'reply', depth: 3, text: '🐦‍⬛ Третя.', replyToMessageId: 880 },
      replies: [recent('2026-09-27T11:55:00Z', 1), recent('2026-09-27T11:57:00Z', 2), recent('2026-09-27T11:59:00Z', 3)],
    });
    const model = fakeModel(answer());
    await run(conversation(busy.store, model).talk, heard({ text: 'а ще?', replyToMessageId: 1400 }));
    assert.equal(model.requests.length, 1, 'the fourth exchange');
    assert.equal(busy.created[0].talk.depth, 4);
    const end = fakeStore({
      replied: { ...opusPost, kind: 'reply', depth: 4, text: '🐦‍⬛ Четверта.', replyToMessageId: 880 },
      replies: [recent('2026-09-27T11:55:00Z', 1), recent('2026-09-27T11:57:00Z', 2), recent('2026-09-27T11:58:00Z', 3), recent('2026-09-27T11:59:00Z', 4)],
    });
    await run(conversation(end.store, fakeModel(answer())).talk, heard({ text: 'і?', replyToMessageId: 1400 }));
    assert.equal(end.created[0].talk.text, '🐦‍⬛ Все, я полетіла, у мене справи.');
  });

  it('stays silent when she is out of answers for the cat, or when the model sees nothing to say', async () => {
    const recent = (iso: string) => ({ userId: '42', sentAt: at(iso), depth: 1 });
    const tired = fakeStore({
      replied: opusPost,
      replies: [recent('2026-09-27T11:55:00Z'), recent('2026-09-27T11:57:00Z'), recent('2026-09-27T11:59:00Z')],
    });
    const model = fakeModel(answer({ shouldReply: false, text: '' }));
    assert.ok(await run(conversation(tired.store, model).talk, heard({ replyToMessageId: 1366 })));
    assert.equal(model.requests.length, 0);
    const quiet = fakeStore({ replied: opusPost });
    assert.ok(await run(conversation(quiet.store, model).talk, heard({ text: 'ахах', replyToMessageId: 1366 })));
    assert.equal(model.requests.length, 1);
    assert.equal(quiet.created.length, 0);
  });
});

describe('«я ж казала»', () => {
  const forward = (patch: Partial<HeardMessage> = {}) =>
    heard({
      text: 'Anthropic випустили Claude Opus 5.5, на 20% дешевший',
      forwardedAt: at('2026-09-27T11:00:00Z'),
      origin: 'ШІ новини',
      ...patch,
    });

  it('tells a cat who forwards her story that she told it, with when and a link to her post', async () => {
    const { store, created } = fakeStore();
    const told = fakeTold({ sameNews: true, text: 'Я про це каркала ще {when}. Читати треба ворону, котику.' });
    const { talk, sent } = conversation(store, fakeModel(answer()), NOW, told);
    assert.ok(await run(talk, forward({ chatId: '-1001906889754' })));
    const request = told.requests[0];
    assert.equal(request.forwarded, true);
    assert.equal(request.origin, 'ШІ новини');
    assert.equal(request.sameSource, false, 'named by its aliases: the model confirms');
    assert.equal(request.sourceWasFaster, false, 'the channel posted it after her');
    assert.equal(request.told.ago, '3 год тому');
    const post = created[0].talk;
    assert.equal(post.kind, 'told');
    assert.equal(post.storyId, 9);
    assert.equal(post.text, '🐦‍⬛ Я про це каркала ще {when:told} {link:post}. Читати треба ворону, котику.');
    assert.deepEqual(post.extras, {
      moments: { told: { unixTime: Math.floor(at('2026-09-27T09:00:00Z').getTime() / 1000), format: 'r', fallback: '3 год тому' } },
      anchors: { post: { label: '💬', url: 'https://t.me/c/1906889754/1366' } },
    });
    assert.equal(sent.length, 1);
  });

  it('calls the cat by the nickname she gave him', async () => {
    const { store } = fakeStore({ nicknames: new Map([['42', 'вовче']]) });
    const told = fakeTold({ sameNews: true, text: '🐦‍⬛ Вовче, я про це каркала ще {when}.' });
    await run(conversation(store, fakeModel(answer()), NOW, told).talk, forward());
    assert.equal(told.requests[0].nickname, 'вовче');
    assert.ok(toldPrompt(told.requests[0]).includes('«вовче»'));
  });

  it('owns up when the forwarded original came out before her post', async () => {
    const told = fakeTold({ sameNews: true, text: '🐦‍⬛ Ну добре, {when} я була повільніша.' });
    const { talk } = conversation(fakeStore().store, fakeModel(answer()), NOW, told);
    await run(talk, forward({ forwardedAt: at('2026-09-27T08:30:00Z') }));
    assert.equal(told.requests[0].sourceWasFaster, true);
  });

  it('knows her story by a link to one of its sources, and keeps no link to her post in a basic group', async () => {
    const { store, created } = fakeStore();
    const told = fakeTold({ sameNews: false, text: '🐦‍⬛ Я ж казала {when}.' });
    const { talk } = conversation(store, fakeModel(answer()), NOW, told);
    const message = heard({
      chatId: '-4001234',
      text: 'гляньте https://anthropic.com/news/claude-opus-5-5/?utm_source=x',
      urls: ['https://anthropic.com/news/claude-opus-5-5/?utm_source=x'],
    });
    assert.ok(await run(talk, message));
    assert.equal(told.requests[0].sameSource, true);
    assert.equal(created[0].talk.text, '🐦‍⬛ Я ж казала {when:told}.', 'the source settles it, whatever the model said');
    assert.equal(created[0].talk.extras?.anchors, undefined);
  });

  it('keeps quiet when the model sees other news, when she said it already, or for a cat who opted out', async () => {
    const other = fakeStore();
    const told = fakeTold({ sameNews: false, text: '' });
    assert.ok(await run(conversation(other.store, fakeModel(answer()), NOW, told).talk, forward()));
    assert.equal(other.created.length, 0);

    const said = fakeStore({ told: [toldOpus({ toldYou: true })] });
    const again = fakeTold({ sameNews: true, text: '🐦‍⬛ {when}' });
    assert.equal(await run(conversation(said.store, fakeModel(answer()), NOW, again).talk, forward()), false);
    assert.equal(again.requests.length, 0);

    const shy = fakeStore({ optedOut: ['42'] });
    assert.equal(await run(conversation(shy.store, fakeModel(answer()), NOW, again).talk, forward()), false);
  });

  it('keeps the gap after her last post, and does not chime on a forward of news she never told', async () => {
    const soon = fakeStore({ chat: chat({ nextPostAt: at('2026-09-27T12:04:00Z') }) });
    const told = fakeTold({ sameNews: true, text: '🐦‍⬛ {when}' });
    assert.ok(await run(conversation(soon.store, fakeModel(answer()), NOW, told).talk, forward()));
    assert.equal(told.requests.length, 0);

    const model = fakeModel(answer());
    const unknown = fakeStore({ told: [] });
    assert.equal(await run(conversation(unknown.store, model, NOW, told).talk, forward()), false);
    assert.equal(model.requests.length, 0, 'a forward is not a talk: no chime-in either');
  });

  it('rewrites a line without its moment once, then keeps quiet', async () => {
    const { store, created } = fakeStore();
    const told = fakeTold({ sameNews: true, text: '🐦‍⬛ Я ж казала.' });
    await run(conversation(store, fakeModel(answer()), NOW, told).talk, forward());
    assert.equal(told.requests.length, 2);
    assert.deepEqual(told.requests[1].corrections, ['`{when}` має бути в тексті рівно один раз, а не 0']);
    assert.equal(created.length, 0);
  });
});

describe('hearing by meaning', () => {
  const detail = (id: number, similarity: number, storyId = 9): MaterialScore => ({ storyId, kind: 'detail', id, similarity });
  const unnamed = (patch: Partial<HeardMessage> = {}) => heard({ text: 'а реально швидше пише чи маркетинг', ...patch });

  it('takes a message that names no story to the gate when it is close to what she may still say, the closest first', async () => {
    const material = opusMaterial({
      details: [
        { id: 301, text: 'Вікно контексту Opus 5.5 — 1 мільйон токенів.' },
        { id: 302, text: 'Opus 5.5 генерує на 30% швидше, ніж Opus 5.' },
      ],
    });
    const { store, created } = fakeStore({ material: [material], scores: [detail(302, 0.41), detail(301, 0.2)] });
    const model = fakeModel(answer({ snippetIds: ['Z1'] }));
    const embedder = fakeEmbedder();
    assert.ok(await run(conversation(store, model, NOW, undefined, embedder.embed).talk, unnamed()));
    assert.deepEqual(embedder.asked, [{ texts: ['а реально швидше пише чи маркетинг'], task: 'query' }]);
    assert.equal(model.requests[0].kind, 'chime');
    assert.equal(model.requests[0].stories[0].details[0].text, 'Opus 5.5 генерує на 30% швидше, ніж Opus 5.');
    assert.deepEqual(created[0].talk.snippetIds, [302]);
  });

  it('keeps quiet below the threshold without asking the model, and does not look for the meaning of a few words', async () => {
    const low = fakeStore({ scores: [detail(301, 0.21)] });
    const model = fakeModel(answer());
    const embedder = fakeEmbedder();
    assert.ok(await run(conversation(low.store, model, NOW, undefined, embedder.embed).talk, unnamed()));
    assert.equal(model.requests.length, 0);
    assert.equal(low.created.length, 0);

    const short = fakeStore({ scores: [detail(301, 0.9)] });
    assert.equal(await run(conversation(short.store, model, NOW, undefined, embedder.embed).talk, unnamed({ text: 'шо на обід' })), false);
    assert.equal(embedder.asked.length, 1, 'the short one was not embedded');
  });

  it('hears by names only without the model of embeddings', async () => {
    const { store } = fakeStore({ scores: [detail(301, 0.9)] });
    assert.equal(await run(conversation(store, fakeModel(answer())).talk, unnamed()), false);
  });

  it('embeds a reply to a cat together with the message it replies to', async () => {
    const { store } = fakeStore({ scores: [detail(301, 0.3)] });
    const embedder = fakeEmbedder();
    await run(conversation(store, fakeModel(answer()), NOW, undefined, embedder.embed).talk, unnamed({ text: 'а скільки коштує взагалі', replyToMessageId: 880 }));
    assert.deepEqual(embedder.asked[0].texts, ['а він швидкий?\nа скільки коштує взагалі']);
  });

  it('still asks the gate for a story its aliases name, however far its scores, and gives the closest detail first', async () => {
    const material = opusMaterial({
      details: [
        { id: 301, text: 'Вікно контексту Opus 5.5 — 1 мільйон токенів.' },
        { id: 302, text: 'Opus 5.5 генерує на 30% швидше, ніж Opus 5.' },
      ],
    });
    const { store } = fakeStore({ material: [material], scores: [detail(302, 0.12), detail(301, 0.05)] });
    const model = fakeModel(answer());
    assert.ok(await run(conversation(store, model, NOW, undefined, fakeEmbedder().embed).talk, heard()));
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].stories[0].details[0].text, 'Opus 5.5 генерує на 30% швидше, ніж Opus 5.');
  });

  it('says «я ж казала» to a forward that names none of her stories when it is close to one’s facts, and the model confirms', async () => {
    const told = fakeTold({ sameNews: true, text: '🐦‍⬛ Я про це каркала ще {when}.' });
    const embedder = fakeEmbedder();
    const forward = heard({
      text: 'Новий флагман від Anthropic подешевшав на 20% і став швидшим',
      forwardedAt: at('2026-09-27T11:00:00Z'),
      origin: 'ШІ новини',
    });
    const near = fakeStore({ told: [toldOpus({ aliases: ['клод'] })] });
    assert.ok(await run(conversation(near.store, fakeModel(answer()), NOW, told, embedder.embed).talk, forward));
    assert.deepEqual(embedder.asked[0], { texts: [forward.text], task: 'similarity' });
    assert.deepEqual(embedder.asked[1], { texts: ['Opus 5.5 на 20% дешевший за Opus 5'], task: 'similarity' }, 'the story’s facts');
    assert.equal(told.requests[0].sameSource, false, 'the model says whether it is the same news');
    assert.equal(near.created[0].talk.kind, 'told');

    const zelda = toldOpus({ storyId: 11, aliases: ['зельда'], facts: [{ id: 'F1', text: 'Ремейк Zelda виходить 5 листопада' }] });
    const far = fakeStore({ told: [zelda] });
    const quiet = fakeTold({ sameNews: true, text: '🐦‍⬛ {when}' });
    assert.ok(await run(conversation(far.store, fakeModel(answer()), NOW, quiet, embedder.embed).talk, forward));
    assert.equal(quiet.requests.length, 0);
    assert.equal(far.created.length, 0);
  });
});
