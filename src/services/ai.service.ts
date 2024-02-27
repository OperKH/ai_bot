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
} from '@xenova/transformers';
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

  private clipModel = 'Xenova/clip-vit-base-patch16';
  private clipTokenizer: Promise<PreTrainedTokenizer> | null = null;
  private clipProcessor: Promise<Processor> | null = null;
  private clipTextModel: Promise<PreTrainedModel> | null = null;
  private clipVisionModel: Promise<PreTrainedModel> | null = null;
  private sentimentAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private toxicAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
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
      this.clipTokenizer = AutoTokenizer.from_pretrained(this.clipModel, { quantized: false });
    }
    return this.clipTokenizer;
  }
  private getClipProcessor() {
    if (!this.clipProcessor) {
      this.clipProcessor = AutoProcessor.from_pretrained(this.clipModel, { quantized: false });
    }
    return this.clipProcessor;
  }
  private getClipTextModel() {
    if (!this.clipTextModel) {
      this.clipTextModel = CLIPTextModelWithProjection.from_pretrained(this.clipModel, { quantized: false });
    }
    return this.clipTextModel;
  }
  private getClipVisionModel() {
    if (!this.clipVisionModel) {
      this.clipVisionModel = CLIPVisionModelWithProjection.from_pretrained(this.clipModel, { quantized: false });
    }
    return this.clipVisionModel;
  }
  private getSentimentAnalysisPipeline() {
    if (!this.sentimentAnalysisPipeline) {
      this.sentimentAnalysisPipeline = pipeline(
        'sentiment-analysis',
        'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      );
    }
    return this.sentimentAnalysisPipeline;
  }
  private getToxicAnalysisPipeline() {
    if (!this.toxicAnalysisPipeline) {
      this.toxicAnalysisPipeline = pipeline('sentiment-analysis', 'Xenova/toxic-bert');
    }
    return this.toxicAnalysisPipeline;
  }
  private getAutomaticSpeechRecognitionPipeline() {
    if (!this.automaticSpeechRecognitionPipeline) {
      this.automaticSpeechRecognitionPipeline = pipeline('automatic-speech-recognition', 'Xenova/whisper-large-v3');
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

  async getEnglishTranslation(text: string) {
    const isEnglish = /^[a-zA-Z\s\d!"#№$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/.test(text);
    if (isEnglish) return text;
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
    const output = await classifier(text, { topk: 6 });
    const t2 = performance.now();
    console.log(`toxicAnalysis(${Math.round(t2 - t1)} ms)`, text, output);
    return output as ToxicBertResponse[];
  }

  async audio2text(audio: AudioPipelineInputs, duration: number): Promise<string> {
    const transcriber = await this.getAutomaticSpeechRecognitionPipeline();
    const t1 = performance.now();
    const output = await transcriber(audio, {
      task: 'transcribe',
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
