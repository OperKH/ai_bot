import { BackgroundQueue } from '../backgroundQueue';

/** What transcribing one voice message needs from the chat */
export interface TranscriptionPort {
  /** Replies to the voice message; returns the reply's id */
  reply(text: string): Promise<number>;
  /** Replaces the text of that reply */
  edit(messageId: number, text: string): Promise<void>;
}

/** The reply that stands in for a transcription until it is ready */
export const PLACEHOLDER = '💬';

/** What a queued voice message gets when the bot stops before transcribing it */
export const STOPPED_TEXT = '📛 Не встиг розпізнати: бот перезапускається';

/**
 * Transcribes voice messages one at a time. Each one gets its 💬 reply the moment
 * it arrives, however many are waiting, so every transcription lands right under
 * its own message instead of somewhere later in a busy chat; the reply's text is
 * replaced once the transcription is done.
 *
 * One Whisper run at a time keeps CPU and memory in check. The queue runs apart
 * from the update queue, so the chat's other updates do not wait for it either.
 */
export class TranscriptionQueue {
  private readonly queue = new BackgroundQueue('Transcription');

  /**
   * Answers with 💬 and queues `transcribe`, whose text then replaces the 💬.
   * Resolves once the 💬 is sent, not when the transcription is done.
   */
  async accept(port: TranscriptionPort, transcribe: () => Promise<string>): Promise<void> {
    const replyId = await port.reply(PLACEHOLDER);
    this.queue.push(async () => port.edit(replyId, await transcribe()), {
      onSkip: () => port.edit(replyId, STOPPED_TEXT),
    });
  }

  /**
   * Stops the queue: transcriptions that have not started are dropped and their
   * 💬 replaced by a notice. Resolves once the one in progress is done.
   */
  close(): Promise<void> {
    return this.queue.close();
  }
}
