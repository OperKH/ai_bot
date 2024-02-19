import {
  env,
  pipeline,
  TextClassificationPipeline,
  TranslationPipeline,
  AutomaticSpeechRecognitionPipeline,
  AudioPipelineInputs,
} from '@xenova/transformers';
env.cacheDir = './data/models';

export type TranslatorResponse = {
  translation_text: string;
};

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

  private sentimentAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private toxicAnalysisPipeline: Promise<TextClassificationPipeline> | null = null;
  private translationPipeline: Promise<TranslationPipeline> | null = null;
  private automaticSpeechRecognitionPipeline: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

  public async dispose() {
    await Promise.all([
      this.sentimentAnalysisPipeline?.then((c) => c.dispose()),
      this.toxicAnalysisPipeline?.then((c) => c.dispose()),
      this.translationPipeline?.then((c) => c.dispose()),
      this.automaticSpeechRecognitionPipeline?.then((c) => c.dispose()),
    ]);
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
  private getTranslationPipeline() {
    if (!this.translationPipeline) {
      this.translationPipeline = pipeline('translation', 'Xenova/nllb-200-distilled-600M');
    }
    return this.translationPipeline;
  }
  private getAutomaticSpeechRecognitionPipeline() {
    if (!this.automaticSpeechRecognitionPipeline) {
      this.automaticSpeechRecognitionPipeline = pipeline('automatic-speech-recognition', 'Xenova/whisper-large-v3');
    }
    return this.automaticSpeechRecognitionPipeline;
  }

  public async sentimentAnalysis(text: string) {
    const classifier = await this.getSentimentAnalysisPipeline();
    const output = await classifier(text);
    console.log('sentimentAnalysis', text, output);
    return output as DistilBertResponse[];
  }

  public async toxicAnalysis(text: string) {
    const classifier = await this.getToxicAnalysisPipeline();
    const output = await classifier(text, { topk: 6 });
    console.log('toxicAnalysis', text, output);
    return output as ToxicBertResponse[];
  }

  public async translate(text: string) {
    const translator = await this.getTranslationPipeline();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await translator(text, { src_lang: 'rus_Cyrl', tgt_lang: 'eng_Latn' } as any);
    console.log('translate', text, output);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ translation_text }] = output as TranslatorResponse[];
    return translation_text;
  }

  async audio2text(audio: AudioPipelineInputs): Promise<string> {
    const transcriber = await this.getAutomaticSpeechRecognitionPipeline();
    const output = await transcriber(audio, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    console.log(output);
    const { text } = output as WhisperResponse;
    return text;
  }

  async isTextToxic(text: string): Promise<boolean> {
    const toxicThreshold = 0.7;
    const engText = await this.translate(text);
    const toxicResult = await this.toxicAnalysis(engText);
    return !!toxicResult.find(({ score }) => score > toxicThreshold);
  }

  async getMaxToxicScore(text: string): Promise<number> {
    const engText = await this.translate(text);
    const [{ score }] = await this.toxicAnalysis(engText);
    return score;
  }
}
