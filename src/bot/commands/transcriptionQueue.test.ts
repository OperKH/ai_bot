import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { PLACEHOLDER, STOPPED_TEXT, TranscriptionPort, TranscriptionQueue } from './transcriptionQueue';

/** A chat that keeps the current text of every reply the bot sent, in order */
class FakeChat implements TranscriptionPort {
  private readonly replies = new Map<number, string>();
  private nextId = 1;

  async reply(text: string) {
    const id = this.nextId++;
    this.replies.set(id, text);
    return id;
  }

  async edit(messageId: number, text: string) {
    this.replies.set(messageId, text);
  }

  texts() {
    return [...this.replies.values()];
  }
}

/** Transcriptions that finish only when the test says so; `started` lists them in the order they began */
const heldTranscriptions = () => {
  const started: PromiseWithResolvers<string>[] = [];
  const transcribe = () => {
    const transcription = Promise.withResolvers<string>();
    started.push(transcription);
    return transcription.promise;
  };
  return { started, transcribe };
};

// A hang would mean the 💬 waited for the transcriptions — fail instead of stalling the run
describe('TranscriptionQueue', { timeout: 2000 }, () => {
  it('answers every voice message with 💬 at once, while an earlier one is still being transcribed', async () => {
    const chat = new FakeChat();
    const queue = new TranscriptionQueue();
    const { started, transcribe } = heldTranscriptions();

    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await settle();

    assert.deepEqual(chat.texts(), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]);
    assert.equal(started.length, 1, 'only the first one is being transcribed');
  });

  it('transcribes one at a time, in arrival order, each into its own reply', async () => {
    const chat = new FakeChat();
    const queue = new TranscriptionQueue();
    const { started, transcribe } = heldTranscriptions();

    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await settle();

    started[0].resolve('📝 перше');
    await settle();
    assert.deepEqual(chat.texts(), ['📝 перше', PLACEHOLDER]);
    assert.equal(started.length, 2);

    started[1].resolve('📝 друге');
    await settle();
    assert.deepEqual(chat.texts(), ['📝 перше', '📝 друге']);
  });

  it('does not let a failed transcription hold up the ones after it', async (t) => {
    t.mock.method(console, 'error', () => {});
    const chat = new FakeChat();
    const queue = new TranscriptionQueue();
    const { started, transcribe } = heldTranscriptions();

    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await settle();

    started[0].reject(new Error('ffmpeg failed'));
    await settle();
    assert.equal(started.length, 2);

    started[1].resolve('📝 друге');
    await settle();
    assert.deepEqual(chat.texts(), [PLACEHOLDER, '📝 друге']);
  });

  it('on close lets the running transcription finish and gives the queued ones a notice', async () => {
    const chat = new FakeChat();
    const queue = new TranscriptionQueue();
    const { started, transcribe } = heldTranscriptions();

    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await queue.accept(chat, transcribe);
    await settle();

    let closed = false;
    const closing = queue.close().then(() => (closed = true));
    await settle();
    assert.equal(closed, false, 'close waits for the transcription in progress');

    started[0].resolve('📝 перше');
    await closing;
    assert.deepEqual(chat.texts(), ['📝 перше', STOPPED_TEXT, STOPPED_TEXT]);
    assert.equal(started.length, 1, 'the queued ones are not transcribed');
  });
});
