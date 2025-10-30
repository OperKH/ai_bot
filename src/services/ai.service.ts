import googleTranslate from '@iamtraction/google-translate';
import sharp from 'sharp';
import {
  env,
  pipeline,
  TextClassificationPipeline,
  AutomaticSpeechRecognitionPipeline,
  AudioPipelineInputs,
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
env.cacheDir = './data/models';

export type DistilBertLabel = 'NEGATIVE' | 'POSITIVE';

export type DistilBertResponse = {
  label: DistilBertLabel;
  score: number;
};

export type ToxicBertLabel = 'toxic' | 'insult' | 'obscene' | 'identity_hate' | 'threat' | 'severe_toxic';

export type ToxicBertResponse = {
  label: ToxicBertLabel;
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
  private static toxicModel = 'Xenova/toxic-bert';
  private static zeroShotClassificationModel = 'Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7';
  private clipTokenizer: Promise<PreTrainedTokenizer> | null = null;
  private clipProcessor: Promise<Processor> | null = null;
  private clipTextModel: Promise<PreTrainedModel> | null = null;
  private clipVisionModel: Promise<PreTrainedModel> | null = null;
  private sentimentAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private toxicAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private zeroShotClassificationPipeline: Promise<ZeroShotClassificationPipeline> | null = null;
  private automaticSpeechRecognitionPipeline: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

  public async dispose() {
    await Promise.all([
      this.sentimentAnalysisPipeline?.then((c) => c.dispose()),
      this.toxicAnalysisPipeline?.then((c) => c.dispose()),
      this.automaticSpeechRecognitionPipeline?.then((c) => c.dispose()),
    ]);
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
        dtype: 'q8',
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

  async getEnglishTranslation(text: string) {
    if (this.isEnglish(text)) return text;
    const t1 = performance.now();
    const { text: engText } = await googleTranslate(text);
    const t2 = performance.now();
    console.log(`googleTranslate(${Math.round(t2 - t1)} ms)`, '|', text, '|', engText);
    return engText;
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
    const output = await classifier(text, { top_k: 6 });
    const t2 = performance.now();
    console.log(`toxicAnalysis(${Math.round(t2 - t1)} ms)`, text, output);
    return output as ToxicBertResponse[];
  }

  async zeroShotClassification(text: string, labels: string[]) {
    const classifier = await this.getZeroShotClassificationPipeline();
    const t1 = performance.now();
    const output = await classifier(text.toLocaleLowerCase(), labels, { multi_label: true });
    const t2 = performance.now();
    console.log(`zeroShotClassification(${Math.round(t2 - t1)} ms)`, text, output);
    return output as ZeroShotClassificationResponse;
  }

  async audio2text(audio: AudioPipelineInputs, duration: number): Promise<string> {
    const transcriber = await this.getAutomaticSpeechRecognitionPipeline();
    const t1 = performance.now();
    const output = await transcriber(audio, {
      // task: 'transcribe',
      // @ts-expect-error Hack to enable multi-language. `task` must be empty in this case.
      is_multilingual: false,
      return_timestamps: false,
      chunk_length_s: duration >= 30 ? 30 : undefined,
      stride_length_s: duration >= 30 ? 5 : undefined,
    });
    const t2 = performance.now();
    console.log(`transcribe(${Math.round(t2 - t1)} ms)`, output);
    const { text } = output as WhisperResponse;
    return text;
  }

  async isTextToxic(text: string): Promise<boolean> {
    const toxicThreshold = 0.7;
    const engText = await this.getEnglishTranslation(text);
    const toxicResult = await this.toxicAnalysis(engText);
    return !!toxicResult.find(({ score }) => score > toxicThreshold);
  }

  async getMaxToxicScore(text: string): Promise<number> {
    const engText = await this.getEnglishTranslation(text);
    const [{ score }] = await this.toxicAnalysis(engText);
    return score;
  }
}
