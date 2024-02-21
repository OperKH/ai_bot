import googleTranslate from '@iamtraction/google-translate';
import {
  env,
  pipeline,
  TextClassificationPipeline,
  AutomaticSpeechRecognitionPipeline,
  AudioPipelineInputs,
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

  public async sentimentAnalysis(text: string) {
    const classifier = await this.getSentimentAnalysisPipeline();
    const output = await classifier(text);
    console.log('sentimentAnalysis', text, output);
    return output as DistilBertResponse[];
  }

  public async toxicAnalysis(text: string) {
    const classifier = await this.getToxicAnalysisPipeline();
    const t1 = performance.now();
    const output = await classifier(text, { topk: 6 });
    const t2 = performance.now();
    console.log(`toxicAnalysis(${Math.round(t2 - t1)} ms)`, text, output);
    return output as ToxicBertResponse[];
  }

  async audio2text(audio: AudioPipelineInputs): Promise<string> {
    const transcriber = await this.getAutomaticSpeechRecognitionPipeline();
    const t1 = performance.now();
    const output = await transcriber(audio, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const t2 = performance.now();
    console.log(`transcribe(${Math.round(t2 - t1)} ms)`, output);
    const { text } = output as WhisperResponse;
    return text;
  }

  async isTextToxic(text: string): Promise<boolean> {
    const toxicThreshold = 0.7;
    const { text: engText } = await googleTranslate(text);
    console.log('googleTranslate', '|', text, '|', engText);
    const toxicResult = await this.toxicAnalysis(engText);
    return !!toxicResult.find(({ score }) => score > toxicThreshold);
  }

  async getMaxToxicScore(text: string): Promise<number> {
    const t1 = performance.now();
    const { text: engText } = await googleTranslate(text);
    const t2 = performance.now();
    console.log(`googleTranslate(${Math.round(t2 - t1)} ms)`, '|', text, '|', engText);
    const [{ score }] = await this.toxicAnalysis(engText);
    return score;
  }
}
