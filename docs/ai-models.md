# Local ML models

`AIService` ([ai.service.ts](../src/services/ai.service.ts)) runs the models locally with
`@huggingface/transformers` (Transformers.js on onnxruntime). They are cached in `data/models/`
(`env.cacheDir`); the container downloads them itself on first use.

| Model | Used by |
| --- | --- |
| CLIP `Xenova/clip-vit-base-patch16` | Image and text embeddings: [media tracking and search](media.md) |
| `OperKH/twitter-xlmr-toxicity-classifier-ONNX` | Toxicity reactions (`ClassifyMessageCommand`) |
| Whisper large-v3-turbo | [Voice transcription](speech.md) |
| EmbeddingGemma `onnx-community/embeddinggemma-300m-ONNX` | The crow: talks and forwards heard by meaning, one game news of several publishers ([crow](crow/behavior.md#talking-in-the-chat)) |
| DistilBERT (sentiment), mDeBERTa (zero-shot) | Nothing: the sentiment pipeline has no command, and `ClassifyMessageByLabelsCommand` is not registered |

## Loading and release

Models are loaded on first use and disposed once on shutdown, by `AIService.dispose()` from
[app.ts](../src/app.ts): `AIService` is a singleton shared by several commands, so no command disposes it.
A repeated call returns the first one's promise: onnxruntime throws "Session already disposed" on a second
release.

## Whisper

Whisper runs with a q8 encoder and a **q4 decoder**. The q8 decoder is U8S8 (int8 weights, uint8
activations); onnxruntime computes that with a saturating instruction on x86 without VNNI — production runs
on an i7-6700K — and the transcription loops ("проблеми, проблеми, проблеми…").

Before switching models or `dtype`, check a quantized file's ops: `MatMulInteger` with int8 weights is the
risky kind, while `MatMulNBits` with `accuracy_level` 0 computes in float. The loops Whisper makes on any
`dtype` are handled in [speech.md](speech.md#loops).

## EmbeddingGemma

`getTextEmbeddings(texts, task)` gives the crow unit vectors of 768 dimensions, stored as `halfvec(768)`. Chosen by a
synthetic measurement against Qwen3, harrier, bge-m3 and OpenAI's 3-large: it separated on and off topic best of the
local models, as well as 3-large, at about 40 ms a message (the concept's section 12.5, `data/crow_embeddings/`).

- **`AutoModel` and its `sentence_embedding` output**, not the `feature-extraction` pipeline: that one mean-pools
  `last_hidden_state` and skips the model's projection layers, and its vectors are wrong.
- **fp32**, not q8: the q8 file is four times slower and takes twice the memory, since its int8 weights are unpacked
  to fp32 as it runs. About 1.2 GB on disk, 760 MB of memory.
- **Two threads** (`intraOpNumThreads`), so a burst of embeddings does not choke Whisper.
- **A prompt per task**, from the model card: a chat message — `task: search result | query: …`; what it should find,
  a detail or the facts a post tells — `title: none | text: …`; two texts of one kind, a forwarded post and the facts
  of a story, or the headlines of two entries — `task: sentence similarity | query: …` on both sides. A symmetric prompt for a message and a detail lost much
  of the gap between on and off topic (AUC 0.959 → 0.883). Batches of 16, padded: the vectors are the same as one by one.
- A failed download is tried again by the next call; the crow goes on without vectors meanwhile.
- **The Gemma Terms** are accepted by using the model, wherever its weights come from, and ask no attribution for
  using it. They forbid monitoring people without their consent, so the members are told the crow reads the chat —
  her introduction in the chat and `/start` — and a cat who pressed «🙅 Не чіпай мене» is never embedded. Whether a
  bot that uses the model inside is a «Hosted Service» of it is unclear; the notice the terms ask of one — «Gemma
  is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms» — belongs in the bot's
  profile text in BotFather, which the owner keeps, not in its messages. The weights are downloaded by the
  container, never built into the image: that would be distribution, with notices of its own.

The thresholds belong to the model, its prompts, the dimensions and the dtype: changing any of them means measuring
them again (the crow logs every score it acts on for that).
