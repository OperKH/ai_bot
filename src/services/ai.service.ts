import { env, pipeline } from '@xenova/transformers';
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

  public async sentimentAnalysis(text: string) {
    const classifier = await pipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english');
    const output = await classifier(text);
    await classifier.dispose();
    console.log('sentimentAnalysis', text, output);
    return output as DistilBertResponse[];
  }

  public async toxicAnalysis(text: string) {
    const classifier = await pipeline('sentiment-analysis', 'Xenova/toxic-bert');
    const output = await classifier(text, { topk: 6 });
    await classifier.dispose();
    console.log('toxicAnalysis', text, output);
    return output as ToxicBertResponse[];
  }

  public async translate(text: string) {
    const translator = await pipeline('translation', 'Xenova/nllb-200-distilled-600M');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await translator(text, { src_lang: 'rus_Cyrl', tgt_lang: 'eng_Latn' } as any);
    await translator.dispose();
    console.log('translate', text, output);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ translation_text }] = output as TranslatorResponse[];
    return translation_text;
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
