import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CrowProfile } from '../entity/CrowChatProfile.entity';
import { allowedNumbers } from './arcValidation';
import { withJabs, type PlannedPost } from './planning';
import {
  ChatProfiles,
  cleanProfile,
  INTRO_TEXT,
  jabProblems,
  jabsFor,
  JabWriter,
  MIN_PROFILE_MESSAGES,
  type ProfileMessage,
  profileInput,
  writeJabs,
} from './profile';
import type { JabRequest, JabResult } from './prompts';

const NOW = new Date('2026-09-27T12:00:00Z');

const message = (
  userId: string,
  text: string,
  firstName: string | null = `Кіт${userId}`,
  at = new Date('2026-09-16T10:00:00Z'),
): ProfileMessage => ({ userId, firstName, username: `cat${userId}`, text, at });

describe('profileInput', () => {
  it('reads a line per message and leaves out the cats who opted out', () => {
    const input = profileInput([message('1', 'граю в DS3'), message('2', 'сиджу на Claude Code'), message('3', 'секрет')], new Set(['3']));
    assert.equal(input.text, '— 16.09 —\n[1] Кіт1: граю в DS3\n[2] Кіт2: сиджу на Claude Code');
    assert.equal(input.count, 2);
    assert.deepEqual([...input.people.keys()], ['2', '1']);
    assert.equal(input.people.has('3'), false);
  });

  it('names a cat without a first name by the username, and cuts long messages', () => {
    const input = profileInput([message('1', 'а'.repeat(500), null)], new Set());
    assert.equal(input.people.get('1')?.name, 'cat1');
    assert.equal(input.text.split('\n')[1].length, '[1] cat1: '.length + 300);
  });

  it('opens each day with its date, so a joke that comes back shows as one', () => {
    const input = profileInput(
      [
        message('1', 'перше', 'Кіт1', new Date('2026-09-15T21:00:00Z')),
        message('2', 'друге', 'Кіт2', new Date('2026-09-15T22:00:00Z')),
        message('1', 'третє', 'Кіт1', new Date('2026-09-17T08:00:00Z')),
      ],
      new Set(),
    );
    assert.equal(input.text, '— 15.09 —\n[1] Кіт1: перше\n[2] Кіт2: друге\n— 17.09 —\n[1] Кіт1: третє');
  });
});

describe('cleanProfile', () => {
  const people = new Map([
    ['1', { name: 'Олег', username: 'oleg' }],
    ['2', { name: 'Саша', username: null }],
  ]);

  it('keeps only the cats it was built from, each once, with topics', () => {
    const profile = cleanProfile(
      {
        interests: ['PS5', 'PS5', ' Claude Code '],
        memes: ['олдгой'],
        members: [
          { id: '1', topics: ['фанат соулсів', ''] },
          { id: '1', topics: ['ще раз'] },
          { id: '2', topics: [] },
          { id: '9', topics: ['вигаданий кіт'] },
        ],
      },
      people,
    );
    assert.deepEqual(profile, {
      interests: ['PS5', 'Claude Code'],
      memes: ['олдгой'],
      members: [{ userId: '1', name: 'Олег', username: 'oleg', topics: ['фанат соулсів'] }],
    });
  });
});

describe('jabsFor', () => {
  it('names one cat quietly when restrained, mentions one when bold and two when pestering', () => {
    assert.deepEqual(jabsFor('restrained'), { count: 1, ping: false });
    assert.deepEqual(jabsFor('bold'), { count: 1, ping: true });
    assert.deepEqual(jabsFor('pestering'), { count: 2, ping: true });
  });
});

describe('jabProblems', () => {
  const allowed = allowedNumbers('на 20% дешевший');
  it('wants the cat named exactly once, by the rules of an arc message', () => {
    assert.deepEqual(jabProblems('🐦‍⬛ {cat}, мінус 20% — твої агенти раді.', allowed), []);
    assert.deepEqual(jabProblems('🐦‍⬛ Коти, мінус 20%.', allowed), ['`{cat}` має бути в тексті рівно один раз, а не 0']);
    assert.deepEqual(jabProblems('🐦‍⬛ {cat}, мінус 30%.', allowed), ['числа 30 немає у фактах']);
  });
});

const request: JabRequest = {
  title: 'Claude Opus 5.5',
  categoryName: '🤖 AI Enterprise',
  facts: [{ id: 'F1', text: 'на 20% дешевший' }],
  opening: '🐦‍⬛🐦‍⬛🐦‍⬛ Прильот',
  targets: [
    { userId: '1', name: 'Олег', topics: ['вісім агентів у Claude Code'] },
    { userId: '2', name: 'Саша', topics: ['Switch 2'] },
  ],
  count: 2,
  recentPosts: [],
};

/** A model that answers from a list, one answer per call, and remembers what it was asked */
function fakeModel(...answers: JabResult['jabs'][]) {
  const requests: JabRequest[] = [];
  const write = async (r: JabRequest) => {
    requests.push(r);
    return { result: { jabs: answers[requests.length - 1] }, costUsd: 0.001 };
  };
  return { write, requests };
}

describe('writeJabs', () => {
  const allowed = allowedNumbers(...request.facts.map((f) => f.text));

  it('keeps good jabs at different cats, with their crows counted', async () => {
    const model = fakeModel([
      { userId: '1', text: '🐦‍⬛{cat}, твої агенти тепер на 20% дешевші.' },
      { userId: '1', text: '🐦‍⬛ {cat}, ще раз.' },
    ]);
    const written = await writeJabs(model.write, request, allowed);
    assert.deepEqual(written.jabs, [{ userId: '1', text: '🐦‍⬛ {cat}, твої агенти тепер на 20% дешевші.' }]);
    assert.equal(written.attempts.length, 1);
  });

  it('rewrites once, then drops a jab that still fails, or aims at a cat who is not there', async () => {
    const model = fakeModel(
      [
        { userId: '1', text: '🐦‍⬛ Коти, агенти.' },
        { userId: '7', text: '🐦‍⬛ {cat}, привіт.' },
      ],
      [
        { userId: '1', text: '🐦‍⬛ {cat}, агенти.' },
        { userId: '7', text: '🐦‍⬛ {cat}, привіт.' },
      ],
    );
    const written = await writeJabs(model.write, request, allowed);
    assert.deepEqual(model.requests[1].corrections, [
      'Підколка 1: `{cat}` має бути в тексті рівно один раз, а не 0',
      'Підколка 2: кота 7 немає серед котів чату',
    ]);
    assert.deepEqual(written.jabs, [{ userId: '1', text: '🐦‍⬛ {cat}, агенти.' }]);
  });

  it('takes no jab at all when the story touches nobody', async () => {
    const written = await writeJabs(fakeModel([]).write, request, allowed);
    assert.deepEqual(written.jabs, []);
  });
});

const PROFILE: CrowProfile = {
  interests: ['AI'],
  memes: [],
  members: [
    { userId: '1', name: 'Олег', username: 'oleg', topics: ['вісім агентів у Claude Code'] },
    { userId: '2', name: 'Саша', username: null, topics: ['Switch 2'] },
  ],
};

describe('JabWriter', () => {
  const story = { title: 'Claude Opus 5.5', categoryName: '🤖 AI Enterprise', facts: request.facts, opening: 'Прильот' };
  const store = (optedOut: string[]) => ({
    profile: async () => PROFILE,
    optedOut: async () => new Set(optedOut),
    recentPosts: async () => [],
  });

  it('aims at the cats of the profile but those who opted out since, and mentions them by the boldness', async () => {
    const model = fakeModel([{ userId: '1', text: '🐦‍⬛ {cat}, агенти.' }]);
    const { jabs } = await new JabWriter(store(['2']), model.write).jabs('-100', 'bold', story, NOW);
    assert.deepEqual(
      model.requests[0].targets.map((target) => target.userId),
      ['1'],
    );
    assert.equal(model.requests[0].count, 1);
    assert.deepEqual(jabs, [
      { text: '🐦‍⬛ {cat}, агенти.', mention: { userId: '1', name: 'Олег', username: 'oleg', ping: true } },
    ]);
  });

  it('writes nothing, and asks nothing, without a cat to aim at', async () => {
    const model = fakeModel([]);
    const { jabs } = await new JabWriter(store(['1', '2']), model.write).jabs('-100', 'pestering', story, NOW);
    assert.deepEqual(jabs, []);
    assert.equal(model.requests.length, 0);
  });
});

const post = (seq: number): PlannedPost => ({
  kind: 'arc',
  storyMessageId: 100 + seq,
  text: null,
  mention: null,
  seq,
  optional: false,
  importance: 3,
  gapMs: seq === 1 ? 0 : 600_000,
  notBefore: seq === 1 ? NOW : null,
  expiresAt: null,
});

describe('withJabs', () => {
  const mention = { userId: '1', name: 'Олег', username: 'oleg', ping: true };
  const jab = (text: string) => ({ text, mention });

  it('puts the first jab after the second post and the next one halfway through the rest', () => {
    const chain = withJabs([1, 2, 3, 4, 5, 6].map(post), [jab('перша'), jab('друга')], () => 0.5);
    assert.deepEqual(
      chain.map((p) => (p.kind === 'jab' ? p.text : p.storyMessageId)),
      [101, 102, 'перша', 103, 104, 'друга', 105, 106],
    );
    assert.deepEqual(
      chain.map((p) => p.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const jabPost = chain[2];
    assert.equal(jabPost.optional, true);
    assert.equal(jabPost.notBefore, null);
    assert.equal(jabPost.gapMs, 25 * 60_000);
  });

  it('leaves a short arc alone', () => {
    const chain = withJabs([1, 2].map(post), [jab('перша')], () => 0.5);
    assert.equal(chain.length, 2);
  });
});

describe('ChatProfiles', () => {
  const many = Array.from({ length: MIN_PROFILE_MESSAGES }, (_, i) => message(String(i % 3), `повідомлення ${i}`));

  function fakeStore(messages: ProfileMessage[], introduced: boolean) {
    const saved: CrowProfile[] = [];
    const intros: string[] = [];
    return {
      saved,
      intros,
      store: {
        profileDueChats: async () => [{ chatId: '-100', introduced }],
        profileMessages: async () => messages,
        optedOut: async () => new Set<string>(),
        saveProfile: async (_chatId: string, profile: CrowProfile) => {
          saved.push(profile);
        },
        planIntro: async (_chatId: string, text: string) => {
          intros.push(text);
        },
      },
    };
  }
  const build = async () => ({
    result: { interests: ['AI'], memes: [], members: [{ id: '1', topics: ['Claude Code'] }] },
    costUsd: 0.005,
  });

  it('builds the profile and introduces the crow before her first jab', async () => {
    const { store, saved, intros } = fakeStore(many, false);
    await new ChatProfiles(store, build, () => NOW).job().run({});
    assert.equal(saved.length, 1);
    assert.deepEqual(
      saved[0].members.map((m) => m.userId),
      ['1'],
    );
    assert.deepEqual(intros, [INTRO_TEXT]);
  });

  it('introduces the crow once, and builds nothing from too few messages', async () => {
    const introduced = fakeStore(many, true);
    await new ChatProfiles(introduced.store, build, () => NOW).job().run({});
    assert.deepEqual(introduced.intros, []);

    const few = fakeStore(many.slice(1), false);
    await new ChatProfiles(few.store, build, () => NOW).job().run({});
    assert.equal(few.saved.length, 0);
    assert.deepEqual(few.intros, []);
  });
});
