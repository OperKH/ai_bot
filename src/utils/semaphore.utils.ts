/**
 * Counting semaphore: at most `limit` callers hold a slot at once, the rest
 * wait in FIFO order.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }

  /** Number of callers waiting for a slot */
  get pending(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * The slot is handed straight to the next waiter instead of being freed and
   * re-acquired — otherwise a newcomer could slip in between and push the
   * number of active tasks past the limit.
   */
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
