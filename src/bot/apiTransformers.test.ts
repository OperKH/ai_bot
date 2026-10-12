import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { type ApiCallFn, HttpError, type Transformer } from 'grammy';
import { ApiCallMonitor, hideToken, isSendMethod, throttleSends } from './apiTransformers';

/** A Bot API that answers every call with `response` and records the methods called */
const fakeApi = (response: object = { ok: true, result: true }) => {
  const calls: string[] = [];
  const prev = (async (method: string) => {
    calls.push(method);
    return response;
  }) as unknown as ApiCallFn;
  return { prev, calls };
};

describe('isSendMethod', () => {
  it('takes the methods that post a message', () => {
    for (const method of ['sendMessage', 'sendPhoto', 'sendAnimation', 'copyMessage', 'forwardMessages']) {
      assert.equal(isSendMethod(method), true, method);
    }
  });

  it('leaves out chat actions, reactions, edits and everything else', () => {
    for (const method of [
      'sendChatAction',
      'setMessageReaction',
      'editMessageText',
      'deleteMessage',
      'getFile',
      'getUpdates',
    ]) {
      assert.equal(isSendMethod(method), false, method);
    }
  });
});

describe('throttleSends', () => {
  it('passes only the send methods through the throttler', async () => {
    const throttled: string[] = [];
    const throttle: Transformer = (prev, method, payload, signal) => {
      throttled.push(method);
      return prev(method, payload, signal);
    };
    const { prev, calls } = fakeApi();
    const transformer = throttleSends(throttle);

    await transformer(prev, 'sendMessage', { chat_id: -100, text: 'hi' });
    await transformer(prev, 'setMessageReaction', { chat_id: -100, message_id: 1 });
    await transformer(prev, 'editMessageText', { chat_id: -100, message_id: 1, text: 'hi' });

    assert.deepEqual(throttled, ['sendMessage']);
    assert.deepEqual(calls, ['sendMessage', 'setMessageReaction', 'editMessageText']);
  });
});

describe('ApiCallMonitor', () => {
  it('counts calls per method, leaving out long polling, and starts over after a take', async () => {
    const monitor = new ApiCallMonitor();
    const { prev } = fakeApi();

    await monitor.transformer(prev, 'sendMessage', { chat_id: 1, text: 'a' });
    await monitor.transformer(prev, 'sendMessage', { chat_id: 1, text: 'b' });
    await monitor.transformer(prev, 'getFile', { file_id: 'x' });
    await monitor.transformer(prev, 'getUpdates', {});

    assert.deepEqual(monitor.take(), [
      ['sendMessage', 2],
      ['getFile', 1],
    ]);
    assert.deepEqual(monitor.take(), []);
  });

  it('reports a 429 with the wait Telegram asked for', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const monitor = new ApiCallMonitor();
    const { prev } = fakeApi({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 7',
      parameters: { retry_after: 7 },
    });

    await monitor.transformer(prev, 'sendMessage', { chat_id: 1, text: 'a' });

    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /429 on sendMessage, retry after 7s/);
  });
});

describe('hideToken', () => {
  it('takes the token out of a call failed on the network, and keeps its code', async () => {
    const token = '123456:SECRET';
    const reason = Object.assign(
      new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed, reason: getaddrinfo ENOTFOUND`),
      { code: 'ENOTFOUND' },
    );
    const prev = (async () => {
      throw new HttpError("Network request for 'sendMessage' failed!", reason);
    }) as unknown as ApiCallFn;
    const failure = await hideToken(token)(prev, 'sendMessage', { chat_id: 1, text: 'x' }).catch((e: unknown) => e);
    assert.ok(failure instanceof HttpError);
    const logged = inspect(failure);
    assert.ok(!logged.includes('SECRET'), logged);
    assert.ok(logged.includes('bot<token>/sendMessage'));
    assert.equal((failure.error as { code: string }).code, 'ENOTFOUND');
  });
});
