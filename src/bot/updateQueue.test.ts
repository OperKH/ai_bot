import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { Bot } from 'grammy';
import type { BotApi, BotContext } from './context/context.interface';
import { UpdateQueue } from './updateQueue';

/** How long a handler works on one update */
const HANDLER_MS = 50;

/**
 * A Bot API that hands out `backlog` in the first getUpdates — as after downtime,
 * a whole batch at once — and then long-polls with nothing new
 */
class FakeTelegram {
  backlog: object[] = [];
  private server!: http.Server;

  get apiRoot() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (req.url!.endsWith('/getMe')) {
        reply({ id: 1, is_bot: true, first_name: 'bot', username: 'bot' });
      } else if (!req.url!.endsWith('/getUpdates')) {
        reply(true);
      } else if (this.backlog.length > 0) {
        reply(this.backlog.splice(0));
      } else {
        const idle = setTimeout(() => reply([]), 1000);
        req.on('close', () => clearTimeout(idle));
      }
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}

/** `count` text messages, alternating between the chats given */
const messages = (count: number, chats: number[]) =>
  Array.from({ length: count }, (_, i) => ({
    update_id: i + 1,
    message: {
      message_id: i + 1,
      date: 0,
      chat: { id: chats[i % chats.length], type: 'group', title: 'g' },
      text: 't',
    },
  }));

/** A bot behind an UpdateQueue whose handler records how the updates went through */
const queuedBot = (telegram: FakeTelegram, concurrency: number) => {
  const bot = new Bot<BotContext, BotApi>('1:token', { client: { apiRoot: telegram.apiRoot } });
  const queue = new UpdateQueue(bot, concurrency);
  const stats = {
    active: 0,
    peak: 0,
    /** The most updates of a single chat ever handled at once */
    peakInChat: 0,
    activeByChat: new Map<number, number>(),
    handled: [] as { chat: number; message: number }[],
  };
  bot.on('message', async (ctx) => {
    const chat = ctx.chat.id;
    const inChat = (stats.activeByChat.get(chat) ?? 0) + 1;
    stats.activeByChat.set(chat, inChat);
    stats.peakInChat = Math.max(stats.peakInChat, inChat);
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    await sleep(HANDLER_MS);
    stats.handled.push({ chat, message: ctx.msg.message_id });
    stats.active--;
    stats.activeByChat.set(chat, inChat - 1);
  });
  return { bot, queue, stats };
};

/** Waits until `done` holds, polling; fails the test after `timeoutMs` */
const until = async (done: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await sleep(10);
  }
};

describe('UpdateQueue', { timeout: 10_000 }, () => {
  // A server per test: the bot of the test before aborts its last getUpdates on
  // stop, and a loaded machine may only handle that request after the next test
  // has put in its backlog, which would then go to a closed connection
  let telegram: FakeTelegram;
  let running: UpdateQueue | undefined;

  beforeEach(async () => {
    telegram = new FakeTelegram();
    await telegram.start();
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    telegram.stop();
  });

  // Five chats, so the order within a chat cannot be what keeps them apart
  it('handles a whole backlog batch one at a time when the limit is 1', async () => {
    telegram.backlog = messages(20, [-1, -2, -3, -4, -5]);
    const { bot, queue, stats } = queuedBot(telegram, 1);
    running = queue;
    // The runner alone would start all 20 at once: its concurrency only sizes the next fetch
    void queue.start(bot);

    await until(() => stats.handled.length === 20);
    assert.equal(stats.peak, 1);
  });

  // Updates of a chat come in pairs, so without the per-chat order two of them would share the slots
  it('runs different chats side by side up to the limit, and one chat in order', async () => {
    telegram.backlog = messages(12, [-1, -1, -2, -2, -3, -3]);
    const { bot, queue, stats } = queuedBot(telegram, 2);
    running = queue;
    void queue.start(bot);

    await until(() => stats.handled.length === 12);
    assert.equal(stats.peak, 2, 'three chats, two slots');
    assert.equal(stats.peakInChat, 1, 'two updates of one chat ran at once');
    for (const chat of [-1, -2, -3]) {
      const order = stats.handled.filter((h) => h.chat === chat).map((h) => h.message);
      assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b),
        `chat ${chat} out of order`,
      );
    }
  });

  it('on stop lets the update in progress finish and drops the ones that have not started', async () => {
    telegram.backlog = messages(10, [-1]);
    const { bot, queue, stats } = queuedBot(telegram, 1);
    void queue.start(bot);
    await until(() => stats.active === 1);

    const t0 = Date.now();
    await queue.stop();

    assert.equal(stats.active, 0, 'the update in progress finished before stop resolved');
    assert.equal(stats.handled.length, 1, 'the waiting updates were dropped');
    assert.equal(queue.waiting, 0);
    assert.ok(Date.now() - t0 < HANDLER_MS * 4, 'stop waited for one update, not for the backlog');
  });
});
