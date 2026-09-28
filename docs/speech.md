# Voice transcription

Voice messages and video notes are transcribed by Whisper and the text replaces a 💬 reply under the
message. Code: [recognizeSpeech.command.ts](../src/bot/commands/recognizeSpeech.command.ts),
[transcriptionQueue.ts](../src/bot/commands/transcriptionQueue.ts) and `audio2text` in
[ai.service.ts](../src/services/ai.service.ts). The model and its quantization are in
[ai-models.md](ai-models.md).

## The queue

A voice message or video note gets its 💬 reply at once, and the transcription goes into a queue that runs
one Whisper at a time, apart from the update queue. So every transcription replaces the 💬 right under its
own message, even when several arrive while one is being transcribed, and other updates do not wait for
Whisper. At shutdown the transcription in progress finishes and the queued ones get a notice in place of
their 💬 ([telegram.md](telegram.md#stop)).

Transcriptions also go into `ChatMessage`, as input for [`/trends`](trends.md).

## Loops

Whisper can loop on a hard start, on any `dtype` including fp32: left to pick the language (needed for the
Russian–Ukrainian mix), it takes the speech for English ("I, I, I…"). `audio2text` catches that by the
text's compression ratio (`AIService.isLoopedTranscription`, above 3) and redoes it once with Russian set.
A decoder quantized the wrong way loops too, on every message — see [ai-models.md](ai-models.md#whisper).

## Tests

- [transcriptionQueue.test.ts](../src/bot/commands/transcriptionQueue.test.ts): every voice message gets
  its 💬 without waiting for the transcriptions ahead of it.
- [ai.service.test.ts](../src/services/ai.service.test.ts): `audio2text` with Whisper replaced — a looped
  transcription is redone once, with Russian set.
