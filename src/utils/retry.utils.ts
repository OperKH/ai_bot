import { setTimeout as sleep } from 'node:timers/promises';

const ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

/**
 * Retries an async operation up to 3 times, waiting 1s then 2s between
 * attempts. The error from the final attempt is rethrown.
 *
 * @param operation - The async operation to run
 * @param options.shouldRetry - Return false to rethrow immediately, e.g. for permanent errors
 * @param options.onRetry - Called before each delay, for logging
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: {
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void;
  } = {},
): Promise<T> {
  const { shouldRetry, onRetry } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= ATTEMPTS || (shouldRetry && !shouldRetry(error))) throw error;
      const nextDelayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      onRetry?.(error, attempt, nextDelayMs);
      await sleep(nextDelayMs);
    }
  }
}
