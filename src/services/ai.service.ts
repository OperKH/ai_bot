import { deflateSync } from 'node:zlib';
import googleTranslate from '@iamtraction/google-translate';
import sharp from 'sharp';
import {
  env,
  pipeline,
  TextClassificationPipeline,
  AutomaticSpeechRecognitionPipeline,
  PreTrainedTokenizer,
  Processor,
  PreTrainedModel,
  AutoTokenizer,
  AutoProcessor,
  CLIPVisionModelWithProjection,
  CLIPTextModelWithProjection,
  RawImage,
  ZeroShotClassificationPipeline,
} from '@huggingface/transformers';
import { retry } from '../utils/retry.utils';
import type { VideoFrame } from './video.service';
env.cacheDir = './data/models';

// Transformers.js v4 moved these out of the package barrel into an internal
// module, so they are mirrored here. Kept identical to the upstream union.
type AudioInput = string | URL | Float32Array | Float64Array;
type AudioPipelineInputs = AudioInput | AudioInput[];

export type DistilBertLabel = 'NEGATIVE' | 'POSITIVE';

/** The CLIP embedding of one video frame, as the `'[...]'` string a `vector` column takes */
export type FrameEmbedding = { frameIndex: number; embedding: string };

export type DistilBertResponse = {
  label: DistilBertLabel;
  score: number;
};

export type TextClassificationResponse = {
  label: string;
  score: number;
};

export type ZeroShotClassificationResponse = {
  sequence: string;
  labels: string[];
  scores: number[];
};

export type WhisperResponse = {
  text: string;
};

export class AIService {
  private static instance: AIService;
  private constructor() {}
  public static getInstance(): AIService {
    if (!AIService.instance) {
      AIService.instance = new AIService();
    }
    return AIService.instance;
  }

  private static clipModel = 'Xenova/clip-vit-base-patch16';
  private static whisperModel = 'onnx-community/whisper-large-v3-turbo';
  private static sentimentModel = 'Xenova/distilbert-base-uncased-finetuned-sst-2-english';
  /**
   * Multilingual (ru/uk/en among 15 languages), so messages are classified as
   * written, without a round trip through Google Translate. Our ONNX export of
   * textdetox/twitter-xlmr-toxicity-classifier, which has PyTorch weights only.
   */
  private static toxicModel = 'OperKH/twitter-xlmr-toxicity-classifier-ONNX';
  private static toxicLabel = 'toxic';
  private static zeroShotClassificationModel = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';
  /** How long translation is skipped after Google Translate fails */
  private static translateCooldownMs = 5 * 60 * 1000;
  /**
   * Above this compression ratio a transcription counts as looped. Whisper decodes
   * greedily and can get stuck repeating itself ("I, I, I…", "проблеми, проблеми…"),
   * and repetition compresses far better than speech. OpenAI's Whisper checks the
   * same way with 2.4, but Cyrillic takes two bytes a letter in UTF-8 and compresses
   * better: on our samples normal transcriptions scored up to 2.35 and looped ones
   * from 3.83.
   */
  private static loopedCompressionRatio = 3;
  private translateCooldownUntil = 0;
  private clipTokenizer: Promise<PreTrainedTokenizer> | null = null;
  private clipProcessor: Promise<Processor> | null = null;
  private clipTextModel: Promise<PreTrainedModel> | null = null;
  private clipVisionModel: Promise<PreTrainedModel> | null = null;
  private sentimentAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private toxicAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private zeroShotClassificationPipeline: Promise<ZeroShotClassificationPipeline> | null = null;
  private automaticSpeechRecognitionPipeline: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

  private disposing: Promise<void> | null = null;

  /**
   * Releases every loaded model. A repeated call returns the first one's
   * promise: onnxruntime throws "Session already disposed" on a second release.
   * The fields keep the released models, so a handler still running at
   * shutdown fails on its session instead of loading the model again.
   */
  public dispose() {
    return (this.disposing ??= this.releaseModels());
  }

  private async releaseModels() {
    const results = await Promise.allSettled(
      [
        this.clipTextModel,
        this.clipVisionModel,
        this.sentimentAnalysisPipeline,
        this.toxicAnalysisPipeline,
        this.zeroShotClassificationPipeline,
        this.automaticSpeechRecognitionPipeline,
      ].map((model) => model?.then((m) => m.dispose())),
    );
    for (const result of results) {
      if (result.status === 'rejected') console.error('Failed to dispose a model:', result.reason);
    }
  }

  private getClipTokenizer() {
    if (!this.clipTokenizer) {
      this.clipTokenizer = AutoTokenizer.from_pretrained(AIService.clipModel);
    }
    return this.clipTokenizer;
  }
  private getClipProcessor() {
    if (!this.clipProcessor) {
      this.clipProcessor = AutoProcessor.from_pretrained(AIService.clipModel, { dtype: 'fp32' });
    }
    return this.clipProcessor;
  }
  private getClipTextModel() {
    if (!this.clipTextModel) {
      this.clipTextModel = CLIPTextModelWithProjection.from_pretrained(AIService.clipModel, { dtype: 'fp32' });
    }
    return this.clipTextModel;
  }
  private getClipVisionModel() {
    if (!this.clipVisionModel) {
      this.clipVisionModel = CLIPVisionModelWithProjection.from_pretrained(AIService.clipModel, { dtype: 'fp32' });
    }
    return this.clipVisionModel;
  }
  private getSentimentAnalysisPipeline() {
    if (!this.sentimentAnalysisPipeline) {
      this.sentimentAnalysisPipeline = pipeline('sentiment-analysis', AIService.sentimentModel, { dtype: 'q8' });
    }
    return this.sentimentAnalysisPipeline;
  }
  private getToxicAnalysisPipeline() {
    if (!this.toxicAnalysisPipeline) {
      this.toxicAnalysisPipeline = pipeline('text-classification', AIService.toxicModel, { dtype: 'q8' });
    }
    return this.toxicAnalysisPipeline;
  }
  private getZeroShotClassificationPipeline() {
    if (!this.zeroShotClassificationPipeline) {
      this.zeroShotClassificationPipeline = pipeline(
        'zero-shot-classification',
        AIService.zeroShotClassificationModel,
        { dtype: 'fp32' },
      );
    }
    return this.zeroShotClassificationPipeline;
  }
  private getAutomaticSpeechRecognitionPipeline() {
    if (!this.automaticSpeechRecognitionPipeline) {
      this.automaticSpeechRecognitionPipeline = pipeline('automatic-speech-recognition', AIService.whisperModel, {
        // Not `q8` for the decoder: its q8 file quantizes weights to int8 and
        // activations to uint8 on the fly (MatMulInteger, U8S8). On x86 without
        // VNNI (the i7-6700K in production) onnxruntime computes that with
        // VPMADDUBSW, which saturates, and the transcription loops: "проблеми,
        // проблеми, проблеми…". CPUs with VNNI and ARM are not affected. The q4
        // decoder keeps int4 weights but computes in float (MatMulNBits,
        // accuracy_level 0). The q8 encoder is U8U8, which does not saturate.
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
      });
    }

    return this.automaticSpeechRecognitionPipeline;
  }

  async getRawImageFromFilePath(filePath: string): Promise<RawImage> {
    return RawImage.read(filePath);
  }

  async getRawImageFromBuffer(buffer: Buffer): Promise<RawImage> {
    const img = sharp(buffer);
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
  }

  isEnglish(text: string) {
    return /^[a-zA-Z\s\d!"#№$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/.test(text);
  }

  /**
   * Google Translate is an unofficial, undocumented endpoint and answers with
   * 5xx or 429 every now and then. It is never the point of a request — it
   * only prepares text for the English-only models — so a failure degrades the
   * caller (weaker toxicity score, weaker search hit) instead of failing it.
   *
   * This runs per text message, inside the update handler, holding its slot in
   * the update queue, so the backoff has to be paid at most once per outage
   * rather than once per message: any failure that exhausts the retries opens
   * a cooldown during which every caller skips translation outright. A 429 is
   * not retried at all — a second request against an exhausted limit only
   * spends the sleep.
   */
  async getEnglishTranslation(text: string) {
    if (this.isEnglish(text)) return text;
    if (Date.now() < this.translateCooldownUntil) return text;

    const t1 = performance.now();
    try {
      const { text: engText } = await retry(() => googleTranslate(text), {
        shouldRetry: (e) => !AIService.isRateLimit(e),
        onRetry: (e, attempt, nextDelayMs) =>
          console.warn(`googleTranslate failed (attempt ${attempt}), retrying in ${nextDelayMs} ms:`, e),
      });
      const t2 = performance.now();
      console.log(`googleTranslate(${Math.round(t2 - t1)} ms)`, '|', text, '|', engText);
      return engText;
    } catch (e) {
      this.translateCooldownUntil = Date.now() + AIService.translateCooldownMs;
      console.error(
        `googleTranslate failed, skipping translation for ${AIService.translateCooldownMs / 60000} min:`,
        e,
      );
      return text;
    }
  }

  private static isRateLimit(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 429;
  }

  async getTextClipEmbedding(text: string): Promise<number[]> {
    const tokenizer = await this.getClipTokenizer();
    const text_model = await this.getClipTextModel();
    const engText = await this.getEnglishTranslation(text);
    const t1 = performance.now();
    const textInputs = tokenizer(engText, { padding: true, truncation: true });
    const { text_embeds } = await text_model(textInputs);
    const textEmbedding = text_embeds.tolist()[0] as number[];
    const t2 = performance.now();
    console.log(`textEmbedding(${Math.round(t2 - t1)} ms)`);
    return textEmbedding;
  }

  async getImageClipEmbedding(image: RawImage): Promise<number[]> {
    const clipProcessor = await this.getClipProcessor();
    const clipVisionModel = await this.getClipVisionModel();
    const imageInputs = await clipProcessor(image);
    const { image_embeds } = await clipVisionModel(imageInputs);
    const imageEmbedding = image_embeds.tolist()[0] as number[];
    return imageEmbedding;
  }

  async sentimentAnalysis(text: string) {
    const classifier = await this.getSentimentAnalysisPipeline();
    const output = await classifier(text);
    console.log('sentimentAnalysis', text, output);
    return output as DistilBertResponse[];
  }

  async toxicAnalysis(text: string) {
    const classifier = await this.getToxicAnalysisPipeline();
    const t1 = performance.now();
    const output = await classifier(text, { top_k: null });
    const t2 = performance.now();
    console.log(`toxicAnalysis(${Math.round(t2 - t1)} ms)`, text, output);
    return output as TextClassificationResponse[];
  }

  async zeroShotClassification(text: string, labels: string[]) {
    const classifier = await this.getZeroShotClassificationPipeline();
    const t1 = performance.now();
    const output = await classifier(text.toLocaleLowerCase(), labels, { multi_label: true });
    const t2 = performance.now();
    console.log(`zeroShotClassification(${Math.round(t2 - t1)} ms)`, text, output);
    return output as ZeroShotClassificationResponse;
  }

  /**
   * The model picks the language itself, which keeps the chat's mix of Russian
   * and Ukrainian as spoken. On a hard start it may take the speech for English
   * and get stuck ("I, I, I…"). Such a transcription is redone with Russian set:
   * that never looped on our samples, though it Russifies Ukrainian speech, so it
   * is only the fallback. Ukrainian is no fallback: set on Russian speech, it
   * made up "Дякую, перегляд!".
   */
  async audio2text(audio: AudioPipelineInputs, duration: number): Promise<string> {
    const text = await this.transcribe(audio, duration, {
      // Hack to enable multi-language. `task` must be empty in this case.
      // Still honoured at runtime in v4 via `generation_config.is_multilingual`.
      is_multilingual: false,
    });
    if (!AIService.isLoopedTranscription(text)) return text;
    console.warn(
      `Transcription looped (compression ratio ${AIService.compressionRatio(text).toFixed(1)}), redoing in Russian`,
    );
    return this.transcribe(audio, duration, { is_multilingual: true, language: 'russian', task: 'transcribe' });
  }

  /** UTF-8 size of `text` over its deflated size */
  static compressionRatio(text: string): number {
    const bytes = Buffer.from(text, 'utf8');
    return bytes.length === 0 ? 0 : bytes.length / deflateSync(bytes).length;
  }

  /** Whether Whisper got stuck repeating itself (see `loopedCompressionRatio`) */
  static isLoopedTranscription(text: string): boolean {
    return AIService.compressionRatio(text) > AIService.loopedCompressionRatio;
  }

  private async transcribe(
    audio: AudioPipelineInputs,
    duration: number,
    languageOptions: { is_multilingual: boolean; language?: string; task?: string },
  ): Promise<string> {
    const transcriber = await this.getAutomaticSpeechRecognitionPipeline();
    const t1 = performance.now();
    const output = await transcriber(audio, {
      ...languageOptions,
      return_timestamps: false,
      chunk_length_s: duration >= 30 ? 30 : undefined,
      stride_length_s: duration >= 30 ? 5 : undefined,
    });
    const t2 = performance.now();
    console.log(`transcribe(${Math.round(t2 - t1)} ms)`, output);
    const { text } = output as WhisperResponse;
    return text;
  }

  /** Probability that the message is toxic (insult, obscenity, hate…), 0–1 */
  async getToxicScore(text: string): Promise<number> {
    const output = await this.toxicAnalysis(text);
    return output.find(({ label }) => label === AIService.toxicLabel)?.score ?? 0;
  }

  /**
   * CLIP embeddings of a video's frames; a frame that fails is skipped. Every path
   * that embeds a video (live, /ignoremedia, the history import) goes through here,
   * so a re-uploaded video gets the same embeddings whichever way it came in.
   */
  async getFrameEmbeddings(frames: VideoFrame[]): Promise<FrameEmbedding[]> {
    const embeddings: FrameEmbedding[] = [];
    for (const { frameIndex, buffer } of frames) {
      try {
        const rawImage = await this.getRawImageFromBuffer(buffer);
        embeddings.push({ frameIndex, embedding: JSON.stringify(await this.getImageClipEmbedding(rawImage)) });
      } catch (e) {
        console.log(`Error processing frame ${frameIndex}:`, e);
      }
    }
    return embeddings;
  }

  async getEmbeddingStringByImageBuffer(imageBuffer: Buffer): Promise<string> {
    const rawImage = await this.getRawImageFromBuffer(imageBuffer);
    const imageEmbedding = await this.getImageClipEmbedding(rawImage);
    return JSON.stringify(imageEmbedding);
  }
}
