import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AIService } from './ai.service';

type LanguageOptions = { is_multilingual: boolean; language?: string; task?: string };

/**
 * AIService with Whisper replaced: the transcriptions come back from `texts` in
 * turn, and `calls` records the language options each one was asked with
 */
const withTranscriptions = (t: TestContext, texts: string[]) => {
  const ai = AIService.getInstance();
  const calls: LanguageOptions[] = [];
  const whisper = ai as unknown as {
    transcribe: (audio: unknown, duration: number, options: LanguageOptions) => Promise<string>;
  };
  t.mock.method(whisper, 'transcribe', async (_audio: unknown, _duration: number, options: LanguageOptions) => {
    calls.push(options);
    return texts[calls.length - 1];
  });
  t.mock.method(console, 'warn', () => {});
  return { ai, calls };
};

const AUDIO = new Float32Array(16_000);

// Real transcriptions of the chat's voice messages: good ones and ones Whisper looped on
const GOOD = [
  'Конечно, да, проблемы, о которых невозможно молчать. Я совсем не додумался, а как я буду организовывать свое ' +
    'настольное пространство в плане всякого шмотя, который там стоит у меня. У меня раньше просто был вот этот ' +
    'коробок, у меня здесь были книжки, и между ними я просто аккуратненько это все засовывал.',
  'Ну короче ось God of War, походить я не можу, може тільки биться. Ну просадочки FPS есть. Ну вроде кажуть, шо, ' +
    'не знаю на скільки це правда, God of War не дуже хорошо эмулируються.',
  'Я придумал шутку. У меня тут в игре постоянно вызывают подкрепления, потому что я на них нападаю.',
  'Так',
];

const LOOPED = [
  'Конечно, да, ' + 'проблемы, '.repeat(200) + 'проблемы бы, бля, надо бы',
  'I, '.repeat(200) + 'I. Ну, понятно. Ну, короче, він вже рішив, що забираю і вже похуй.',
  'Ну, короче, ' + 'ось, '.repeat(150),
];

describe('AIService.isLoopedTranscription', () => {
  it('passes normal speech, short and long', () => {
    for (const text of GOOD) assert.equal(AIService.isLoopedTranscription(text), false, text);
  });

  it('catches Whisper repeating itself, even when the loop is only part of the text', () => {
    for (const text of LOOPED) assert.equal(AIService.isLoopedTranscription(text), true, text.slice(0, 40));
  });
});

describe('AIService.audio2text', () => {
  it('keeps a good transcription, with the language left to the model', async (t) => {
    const { ai, calls } = withTranscriptions(t, [GOOD[1]]);
    assert.equal(await ai.audio2text(AUDIO, 1), GOOD[1]);
    assert.deepEqual(calls, [{ is_multilingual: false }]);
  });

  it('redoes a looped transcription with Russian set', async (t) => {
    const { ai, calls } = withTranscriptions(t, [LOOPED[1], GOOD[0]]);
    assert.equal(await ai.audio2text(AUDIO, 1), GOOD[0]);
    assert.deepEqual(calls, [
      { is_multilingual: false },
      { is_multilingual: true, language: 'russian', task: 'transcribe' },
    ]);
  });

  it('redoes it only once, even if the Russian one loops too', async (t) => {
    const { ai, calls } = withTranscriptions(t, [LOOPED[0], LOOPED[2]]);
    assert.equal(await ai.audio2text(AUDIO, 1), LOOPED[2]);
    assert.equal(calls.length, 2);
  });
});
