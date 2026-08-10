import 'dotenv/config';
import type { ReasoningEffort } from 'openai/resources/shared';

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Models disagree on which efforts they accept — `minimal` is rejected by newer
 * models, `none` and `xhigh` by older ones — so this is configurable per model.
 * An unknown value is refused here rather than sent, because the API would only
 * fail at the point of use, one call at a time.
 */
function reasoningEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (!value) return fallback;
  if (!REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    console.warn(`[Config] Unknown reasoning effort "${value}", falling back to "${fallback}".`);
    return fallback;
  }
  return value as ReasoningEffort;
}

export class ConfigService {
  private static instance: ConfigService;
  private constructor() {}
  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  private static readonly config = {
    TG_TOKEN: process.env.TG_TOKEN || '',
    TG_API_ID: parseInt(process.env.TG_API_ID || '', 10),
    TG_API_HASH: process.env.TG_API_HASH || '',
    TG_API_SESSION: process.env.TG_API_SESSION || '',
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_PORT: parseInt(process.env.DB_PORT || '', 10) || 5432,
    DB_NAME: process.env.DB_NAME || 'ai_bot',
    DB_USERNAME: process.env.DB_USERNAME || 'postgres',
    DB_PASSWORD: process.env.DB_PASSWORD,
    MATCH_TEXT_THRESHOLD: parseFloat(process.env.MATCH_TEXT_THRESHOLD || '') || 0.24,
    MATCH_IMAGE_THRESHOLD: parseFloat(process.env.MATCH_IMAGE_THRESHOLD || '') || 0.96,
    MATCH_IMAGE_COUNT: parseInt(process.env.MATCH_IMAGE_COUNT || '', 10) || 3,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL || 'gpt-5.6-luna',
    OPENAI_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_REASONING_EFFORT, 'low'),
    OPENAI_VISION_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_VISION_REASONING_EFFORT, 'none'),
    OPENAI_MAX_DESCRIBE_IMAGE_TOKENS: parseInt(process.env.OPENAI_MAX_DESCRIBE_IMAGE_TOKENS || '', 10) || 3000,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || '',
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || '',
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    LANGFUSE_TRACING_ENVIRONMENT: process.env.LANGFUSE_TRACING_ENVIRONMENT,
  };

  get<K extends keyof typeof ConfigService.config>(key: K): (typeof ConfigService.config)[K] {
    return ConfigService.config[key];
  }
}
