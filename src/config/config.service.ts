import { config as loadEnvFiles } from 'dotenv';
import type { ReasoningEffort } from 'openai/resources/shared';

// `.env.local` (gitignored) holds what differs on this machine, such as the port
// of a local database, over the shared `.env`. The first file to set a variable
// wins, and a variable already set in the environment wins over both files.
loadEnvFiles({ path: ['.env.local', '.env'], quiet: true });

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

/**
 * A Telegram user id, or 0 when the variable is not set. Anything but digits —
 * a @username, a stray letter — is refused with a warning rather than read as
 * part of a number.
 */
function userId(name: string, value: string | undefined): number {
  if (!value?.trim()) return 0;
  if (!/^\d+$/.test(value.trim())) {
    console.warn(`[Config] ${name} must be a numeric Telegram user id, not "${value}"; it is ignored.`);
    return 0;
  }
  return Number(value.trim());
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
    TG_UPDATE_CONCURRENCY: parseInt(process.env.TG_UPDATE_CONCURRENCY || '', 10) || 1,
    TG_OWNER_ID: userId('TG_OWNER_ID', process.env.TG_OWNER_ID),
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_PORT: parseInt(process.env.DB_PORT || '', 10) || 5432,
    DB_NAME: process.env.DB_NAME || 'ai_bot',
    DB_USERNAME: process.env.DB_USERNAME || 'postgres',
    DB_PASSWORD: process.env.DB_PASSWORD,
    MATCH_TEXT_THRESHOLD: parseFloat(process.env.MATCH_TEXT_THRESHOLD || '') || 0.24,
    MATCH_IMAGE_THRESHOLD: parseFloat(process.env.MATCH_IMAGE_THRESHOLD || '') || 0.96,
    MATCH_IMAGE_COUNT: parseInt(process.env.MATCH_IMAGE_COUNT || '', 10) || 3,
    CROW_TALK_THRESHOLD: parseFloat(process.env.CROW_TALK_THRESHOLD || '') || 0.35,
    CROW_FORWARD_THRESHOLD: parseFloat(process.env.CROW_FORWARD_THRESHOLD || '') || 0.78,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-6-luna',
    OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL || 'gpt-6-luna',
    OPENAI_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_REASONING_EFFORT, 'low'),
    OPENAI_VISION_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_VISION_REASONING_EFFORT, 'none'),
    OPENAI_MAX_DESCRIBE_IMAGE_TOKENS: parseInt(process.env.OPENAI_MAX_DESCRIBE_IMAGE_TOKENS || '', 10) || 3000,
    OPENAI_CROW_MODEL: process.env.OPENAI_CROW_MODEL || 'gpt-6-luna',
    OPENAI_CROW_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_CROW_REASONING_EFFORT, 'low'),
    OPENAI_CROW_ARC_MODEL: process.env.OPENAI_CROW_ARC_MODEL || 'gpt-6.1-sol',
    OPENAI_CROW_ARC_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_CROW_ARC_REASONING_EFFORT, 'medium'),
    OPENAI_CROW_TALK_MODEL: process.env.OPENAI_CROW_TALK_MODEL || 'gpt-6-luna',
    OPENAI_CROW_TALK_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_CROW_TALK_REASONING_EFFORT, 'low'),
    OPENAI_CROW_TEXT_MODEL: process.env.OPENAI_CROW_TEXT_MODEL || 'gpt-6.1-sol',
    OPENAI_CROW_TEXT_REASONING_EFFORT: reasoningEffort(process.env.OPENAI_CROW_TEXT_REASONING_EFFORT, 'low'),
    OPENAI_CROW_DAILY_BUDGET_USD: parseFloat(process.env.OPENAI_CROW_DAILY_BUDGET_USD || '') || 1,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || '',
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || '',
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    LANGFUSE_TRACING_ENVIRONMENT: process.env.LANGFUSE_TRACING_ENVIRONMENT,
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
  };

  get<K extends keyof typeof ConfigService.config>(key: K): (typeof ConfigService.config)[K] {
    return ConfigService.config[key];
  }
}
