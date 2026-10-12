import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CrowPost, CrowPostKind } from '../entity/CrowPost.entity';
import { shooMessage } from './dispatch';
import { CrowScheduler, type CrowSender } from './scheduler';
import type { CrowStore } from './store';

/**
 * The store as the sending reads it: the posts marked sent, in order, and the message with «Кш!» among them as the
 * store's query finds it — the latest of the kinds that do not leave the button, by `shooMessage`
 */
function fakeStore() {
  const kinds = new Map<number, CrowPostKind>();
  const sent: { id: number; kind: CrowPostKind; tgMessageId: number }[] = [];
  const store = {
    markSent: async (postId: number, messageId: number) => {
      sent.push({ id: postId, kind: kinds.get(postId)!, tgMessageId: messageId });
    },
    previousShooMessage: async (_chatId: string, postId: number) =>
      shooMessage(sent.filter((post) => post.id !== postId).reverse()),
    markFailed: async () => undefined,
    dropChat: async () => undefined,
  };
  return { store: store as unknown as CrowStore, kinds };
}

/** A sender whose sends arrive and whose failures never mean anything, but for what a test sets */
const fakeSender = (sender: Partial<CrowSender>): CrowSender => ({
  send: async () => ({ messageId: 0, photoFileIds: [] }),
  sendPoll: async () => ({ messageId: 0, pollId: '' }),
  dropShoo: async () => undefined,
  isChatGone: () => false,
  unsentReason: () => null,
  ...sender,
});

describe('CrowScheduler, «Кш!»', () => {
  it('moves the button to each post that carries it, leaves it for an answer, and takes it away with the goodbye', async () => {
    const { store, kinds } = fakeStore();
    const dropped: number[] = [];
    const sender = fakeSender({
      send: async (post) => ({ messageId: 1000 + post.postId, photoFileIds: [] }),
      dropShoo: async (_chatId, messageId) => {
        dropped.push(messageId);
      },
    });
    const scheduler = new CrowScheduler(store, sender, []);
    const send = async (id: number, kind: CrowPostKind) => {
      kinds.set(id, kind);
      const post = { id, chatId: '-100', kind, text: '🐦‍⬛ …', extras: null, mention: null, replyToMessageId: null, expiresAt: null };
      assert.ok(await scheduler.sendTalk(post as unknown as CrowPost));
    };

    await send(1, 'arc');
    await send(2, 'arc');
    assert.deepEqual(dropped, [1001], 'a new post takes the button over');
    await send(3, 'reply');
    assert.deepEqual(dropped, [1001], 'an answer to a cat who called her leaves it under the arc');
    await send(4, 'goodbye');
    assert.deepEqual(dropped, [1001, 1002], 'the goodbye takes it off the post before');
    await send(5, 'chime');
    assert.deepEqual(dropped, [1001, 1002], 'her word in a talk after the goodbye has the button, and takes none');
    await send(6, 'arc');
    assert.deepEqual(dropped, [1001, 1002, 1005], 'the morning takes it off her word in the talk');
    await send(7, 'goodbye');
    await send(8, 'arc');
    assert.deepEqual(dropped, [1001, 1002, 1005, 1006], 'after a goodbye with no talk the morning finds none to take');
  });
});

/** The network's failure before the request left — no address for Telegram — as the sender tells it */
const unsent = new Error('getaddrinfo ENOTFOUND api.telegram.org');

/**
 * A chat with its evening goodbye due, a quarter of an hour before its quiet hours, and a sender that fails with
 * `failure`: what the store was told of the post
 */
async function goodbyeFailing(failure: Error, how: 'queue' | 'talk' = 'queue', ticks = 1) {
  const now = new Date();
  const post = {
    id: 7,
    chatId: '-100',
    kind: 'goodbye' as CrowPostKind,
    text: '🐦‍⬛ Коти, я спати.',
    extras: null,
    mention: null,
    replyToMessageId: null,
    expiresAt: new Date(now.getTime() + 15 * 60_000),
  };
  const told: { status: 'planned' | 'failed'; notBefore?: Date }[] = [];
  const store = {
    dueChats: async () => [
      {
        chatId: '-100',
        timeZone: 'UTC',
        boldness: 'bold',
        quietFrom: null,
        quietTo: null,
        snoozedUntil: null,
        nextPostAt: null,
      },
    ],
    candidates: async () => [
      {
        postId: 7,
        kind: 'goodbye',
        storyId: null,
        isFirst: false,
        optional: false,
        importance: 1,
        notBefore: now,
        expiresAt: post.expiresAt,
        storyLastSentAt: null,
      },
    ],
    sentCounts: async () => ({ lastHour: 0, today: 0 }),
    claim: async () => true,
    postToSend: async () => ({ post, text: post.text, table: null, stories: [], replyToMessageId: null, event: null }),
    putBack: async (_postId: number, notBefore: Date) => {
      told.push({ status: 'planned', notBefore });
    },
    markFailed: async () => {
      told.push({ status: 'failed' });
    },
    dropChat: async () => undefined,
    dueJobs: async () => new Map(),
  };
  const sender = fakeSender({
    send: async () => {
      throw failure;
    },
    unsentReason: (e) => (e === unsent ? 'ENOTFOUND' : null),
  });
  const scheduler = new CrowScheduler(store as unknown as CrowStore, sender, []);
  if (how === 'queue') for (let i = 0; i < ticks; i++) await scheduler.tick();
  else assert.equal(await scheduler.sendTalk(post as unknown as CrowPost), false);
  return { told, now };
}

describe('CrowScheduler, a send that failed', () => {
  it('puts a post whose request never reached Telegram back in the queue, a minute later', async () => {
    const { told, now } = await goodbyeFailing(unsent);
    assert.equal(told.length, 1);
    assert.equal(told[0].status, 'planned', 'a blip of the DNS once cost a chat its goodbye');
    assert.ok(told[0].notBefore!.getTime() - now.getTime() >= 60_000);
  });

  it('tries it later each time, by the Fibonacci numbers, and gives up once they are spent', async () => {
    const { told, now } = await goodbyeFailing(unsent, 'queue', 10);
    const minutes = told.map((t) =>
      t.notBefore ? Math.round((t.notBefore.getTime() - now.getTime()) / 60_000) : t.status,
    );
    assert.deepEqual(minutes, [1, 1, 2, 3, 5, 8, 13, 21, 34, 'failed']);
  });

  it('marks it failed when it may have arrived: a duplicate is worse than a gap', async () => {
    const { told } = await goodbyeFailing(new Error('read ETIMEDOUT'));
    assert.deepEqual(told, [{ status: 'failed' }]);
  });

  it('never sends a talk again: the cat waited for it then', async () => {
    const { told } = await goodbyeFailing(unsent, 'talk');
    assert.deepEqual(told, [{ status: 'failed' }]);
  });
});
