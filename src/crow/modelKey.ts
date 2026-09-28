/** Names of a lab that point at one company, so its stories share a key */
const VENDOR_ALIASES: Record<string, string> = {
  'open-ai': 'openai',
  chatgpt: 'openai',
  claude: 'anthropic',
  'google-deepmind': 'google',
  deepmind: 'google',
  gemini: 'google',
  'x-ai': 'xai',
  grok: 'xai',
  spacexai: 'xai',
  'deepseek-ai': 'deepseek',
  'meta-llama': 'meta',
  facebook: 'meta',
  mistralai: 'mistral',
  qwen: 'alibaba',
  'alibaba-cloud': 'alibaba',
  moonshotai: 'moonshot',
  kimi: 'moonshot',
  'z-ai': 'zhipu',
  zai: 'zhipu',
  glm: 'zhipu',
  minimaxai: 'minimax',
  xiaomimimo: 'xiaomi',
  'microsoft-ai': 'microsoft',
  // The names of the Hugging Face organizations and the tools' makers
  'zai-org': 'zhipu',
  'bytedance-seed': 'bytedance',
  'stepfun-ai': 'stepfun',
  inclusionai: 'ant',
  'ant-group': 'ant',
  'ibm-granite': 'ibm',
  allenai: 'ai2',
  liquidai: 'liquid',
  'hugging-face': 'huggingface',
  huggingfacetb: 'huggingface',
  anysphere: 'cursor',
};

/**
 * Tiers of one release: GPT-6 Sol and Luna, Claude Opus and Sonnet 5.5 come out
 * together and make one story, so the tier is left out of the topic.
 */
const TIERS = new Set([
  'sol',
  'luna',
  'astra',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'mythos',
  'flash',
  'pro',
  'ultra',
  'nano',
  'mini',
  'lite',
  'max',
  'turbo',
  'large',
  'medium',
  'small',
]);

/** Suffixes of builds of one model rather than new models: quantizations and formats among them */
const VARIANTS = new Set([
  'latest',
  'preview',
  'instruct',
  'gguf',
  'fp8',
  'mlx',
  'awq',
  'free',
  'batch',
  'exp',
  'bf16',
  'fp16',
  'nvfp4',
  'mxfp4',
  'mxfp8',
  'int4',
  'int8',
  'gptq',
  'onnx',
]);

/**
 * A size in the name — `27b`, `35b-a3b` (active parameters), `e4b`, `100m`: the
 * sizes of one release come out together and make one story.
 */
const SIZE = /^[ae]?\d+(?:\.\d+)?[bm]$/;

export function normalizeVendor(vendor: string): string {
  const slug = vendor
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-');
  return VENDOR_ALIASES[slug] ?? slug;
}

/**
 * The topic of a story as `vendor/slug`: lowercase, `.`, `_`, `:` and spaces
 * as `-`, without dates, snapshots, build variants, tiers and sizes, and a
 * name glued to its version however it was written, as `qwen3.9` and `qwen-3.9`
 * are — `Google/Gemini-3.8-Flash-Preview-2026-09-02` → `google/gemini3-8`.
 */
export function normalizeTopicKey(key: string, vendor: string): string {
  const parts = key.trim().toLowerCase().split('/');
  const slug = (parts.length > 1 ? parts.slice(1).join('-') : parts[0])
    .replace(/[\s_.:]+/g, '-')
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})(?=-|$)/g, '')
    .split('-')
    .filter((word) => word !== '' && !TIERS.has(word) && !VARIANTS.has(word) && !SIZE.test(word))
    .join('-')
    .replace(/([a-z])-(?=\d)/g, '$1');
  return `${normalizeVendor(vendor || parts[0])}/${slug}`;
}
