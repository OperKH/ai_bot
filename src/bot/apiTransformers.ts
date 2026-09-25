import { autoRetry } from '@grammyjs/auto-retry';
import { hydrateFiles } from '@grammyjs/files';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { Api, Transformer } from 'grammy';

/** Give up on a call that keeps hitting 429 after this many retries */
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Methods that put a new message into a chat. Telegram's per-chat limits — about
 * 20 messages a minute in a group, one a second in any chat — are about these.
 */
export function isSendMethod(method: string): boolean {
  return (method.startsWith('send') && method !== 'sendChatAction') || /^(copy|forward)Messages?$/.test(method);
}

/**
 * Paces the calls of `isSendMethod` and lets everything else straight through.
 * The throttler alone paces every call that has a `chat_id`, reactions and edits
 * included, and toxicity reactions would then eat a group's message budget.
 */
export function throttleSends(throttle: Transformer): Transformer {
  return (prev, method, payload, signal) =>
    isSendMethod(method) ? throttle(prev, method, payload, signal) : prev(method, payload, signal);
}

/**
 * Counts the requests that actually go out, per method, for the per-minute stats
 * line, and reports each 429 as it comes back. It sits closest to the network,
 * so a request repeated after a 429 counts every time it is sent.
 */
export class ApiCallMonitor {
  private counts = new Map<string, number>();

  readonly transformer: Transformer = async (prev, method, payload, signal) => {
    // getUpdates is long polling, not load — leave it out of the stats
    if (method !== 'getUpdates') this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
    const result = await prev(method, payload, signal);
    if (!result.ok && result.parameters?.retry_after !== undefined) {
      console.warn(`Telegram 429 on ${method}, retry after ${result.parameters.retry_after}s`);
    }
    return result;
  };

  /** The calls counted since the previous take; counting starts over */
  take(): Array<[method: string, count: number]> {
    const entries = [...this.counts];
    this.counts.clear();
    return entries;
  }
}

/**
 * Every outgoing call — `ctx.reply`, `ctx.react`, `getFile`, `getUpdates` — goes
 * through these transformers; the ones on `bot.api` apply to `ctx.api` too. A
 * transformer installed later wraps those before it, so a call passes
 * auto-retry → throttle → monitor → files → network.
 *
 * - Sends are paced to Telegram's limits up front, so 429s should be rare.
 * - A 429 is retried after Telegram's `retry_after`, up to 5 times. The wait holds
 *   the caller's update slot, so the whole queue pauses rather than piling more
 *   calls onto the limit.
 * - Nothing else is retried, unlike the plugin's defaults (network errors forever,
 *   5xx with backoff): a `sendMessage` that failed that way may still have been
 *   delivered, and a repeat would post it twice.
 */
export function installApiTransformers(api: Api, token: string, monitor: ApiCallMonitor) {
  api.config.use(hydrateFiles(token));
  api.config.use(monitor.transformer);
  api.config.use(throttleSends(apiThrottler()));
  api.config.use(
    autoRetry({ maxRetryAttempts: MAX_RATE_LIMIT_RETRIES, rethrowHttpErrors: true, rethrowInternalServerErrors: true }),
  );
}
