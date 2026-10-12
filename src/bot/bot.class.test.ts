import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError, HttpError } from 'grammy';
import { unsentTelegramReason } from './bot.class';

/** A call that failed on the network, as grammY wraps node-fetch's error: its system code */
const network = (code: string) => new HttpError("Network request for 'sendRichMessage' failed!", { code });

describe('unsentTelegramReason', () => {
  it('names why a call never reached Telegram: no address for it, no connection', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
      assert.equal(unsentTelegramReason(network(code)), code);
    }
  });

  it('leaves a call that may have been done, and Telegram’s own answers', () => {
    assert.equal(unsentTelegramReason(network('ETIMEDOUT')), null, 'a timeout may come after the request was read');
    assert.equal(unsentTelegramReason(network('ECONNRESET')), null);
    assert.equal(unsentTelegramReason(new HttpError('failed', new Error('aborted'))), null);
    const answer = new GrammyError(
      'Call to sendRichMessage failed!',
      { ok: false, error_code: 502, description: 'Bad Gateway' },
      'sendRichMessage',
      {},
    );
    assert.equal(unsentTelegramReason(answer), null);
    assert.equal(unsentTelegramReason(new Error('getaddrinfo ENOTFOUND')), null);
  });
});
