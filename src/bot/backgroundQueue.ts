/** What a queued job does besides its work */
export interface BackgroundJobOptions {
  /** Runs instead of the job when the queue closed before the job started */
  onSkip?: () => Promise<void>;
  /** Handles the job's failure; by default it is logged */
  onError?: (error: unknown) => Promise<void> | void;
}

/**
 * Runs jobs one at a time, in order, apart from the update queue, so an update
 * handler can hand over long work and free its slot. A failed job does not hold
 * up the ones after it. On `close` the jobs that have not started are skipped,
 * and it resolves once the one in progress is done: a command closes its queues
 * when disposed, so the shutdown waits for them.
 */
export class BackgroundQueue {
  /** The job queued last; the queue is FIFO, so once it settles all have */
  private last: Promise<void> = Promise.resolve();
  private closed = false;

  /** @param name - Names the queue in logs */
  constructor(private readonly name: string) {}

  push(job: () => Promise<void>, { onSkip, onError }: BackgroundJobOptions = {}): void {
    this.last = this.last
      .then(async () => {
        if (!this.closed) await job();
        else await onSkip?.();
      })
      .catch(async (e) => {
        if (onError) await onError(e);
        else console.error(`${this.name} failed:`, e);
      })
      // An onError that throws must not break the chain either
      .catch((e) => console.error(`${this.name} failed to handle a failure:`, e));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.last;
  }
}
