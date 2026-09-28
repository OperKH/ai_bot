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

describe('CrowScheduler, «Кш!»', () => {
  it('moves the button to each post that carries it, leaves it for an answer, and takes it away with the goodbye', async () => {
    const { store, kinds } = fakeStore();
    const dropped: number[] = [];
    const sender: CrowSender = {
      send: async (post) => ({ messageId: 1000 + post.postId, photoFileIds: [] }),
      sendPoll: async () => ({ messageId: 0, pollId: '' }),
      dropShoo: async (_chatId, messageId) => {
        dropped.push(messageId);
      },
      isChatGone: () => false,
    };
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
