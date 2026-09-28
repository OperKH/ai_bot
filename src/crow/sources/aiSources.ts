import type { FeedItem } from './feed';
import {
  parseClaudeCodeCommands,
  parseClaudeCodeWhatsNew,
  parseGeminiCliAnnouncements,
  parseHuggingFaceModels,
  parseQwenArticles,
} from './parsers';
import type { SourceDefinition } from './source';

const MINUTE = 60_000;

/** A page at the root of a site or under /news/: that is where labs put their launches */
const launchPage = (item: FeedItem) => /^\/(news\/)?[a-z0-9-]+\/?$/i.test(new URL(item.key).pathname);

/** A lab's own channel tells of its flagships, its open models and its coding tools alike; the sorting says which */
const LAB_CATEGORIES: SourceDefinition['categories'] = ['ai-enterprise', 'ai-homebrew', 'vibecoding'];

/**
 * Hugging Face organizations whose new repositories are the labs' own word on
 * their open models — for the Chinese labs often the first one, hours before
 * the catalogs (docs/crow/pipeline.md#sources).
 */
const HUGGING_FACE_ORGS: readonly { org: string; vendor: string }[] = [
  { org: 'Qwen', vendor: 'alibaba' },
  { org: 'deepseek-ai', vendor: 'deepseek' },
  { org: 'moonshotai', vendor: 'moonshot' },
  { org: 'zai-org', vendor: 'zhipu' },
  { org: 'MiniMaxAI', vendor: 'minimax' },
  { org: 'XiaomiMiMo', vendor: 'xiaomi' },
  { org: 'tencent', vendor: 'tencent' },
  { org: 'ByteDance-Seed', vendor: 'bytedance' },
  { org: 'stepfun-ai', vendor: 'stepfun' },
  { org: 'baidu', vendor: 'baidu' },
  { org: 'inclusionAI', vendor: 'ant' },
  { org: 'google', vendor: 'google' },
  { org: 'openai', vendor: 'openai' },
  { org: 'meta-llama', vendor: 'meta' },
  { org: 'mistralai', vendor: 'mistral' },
  { org: 'nvidia', vendor: 'nvidia' },
  { org: 'microsoft', vendor: 'microsoft' },
  { org: 'ibm-granite', vendor: 'ibm' },
  { org: 'allenai', vendor: 'ai2' },
  { org: 'LiquidAI', vendor: 'liquid' },
  { org: 'HuggingFaceTB', vendor: 'huggingface' },
];

/** The newest repositories of an organization; sorted by creation, since an old one edited is not news */
const huggingFace = ({ org, vendor }: { org: string; vendor: string }): SourceDefinition => ({
  id: `hf-${org.toLowerCase()}`,
  name: `Hugging Face: ${org}`,
  url: `https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=30`,
  kind: 'custom',
  parse: parseHuggingFaceModels,
  intervalMs: 15 * MINUTE,
  official: vendor,
  categories: ['ai-homebrew', 'ai-enterprise'],
});

/**
 * The AI sources: the labs' own channels first, OpenRouter as the fast common
 * signal, Hugging Face for the open models, and the changelogs of the coding
 * tools. x.ai comes later.
 */
export const AI_SOURCES: readonly SourceDefinition[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/models?use_rss=true',
    kind: 'feed',
    intervalMs: 10 * MINUTE,
    aggregator: true,
    categories: ['ai-enterprise', 'ai-homebrew'],
    // Free and batch variants, routers and aliases are not new models
    accept: (item) => !/:(free|batch)$|^~|^openrouter\//.test(item.key),
  },
  {
    id: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    kind: 'feed',
    intervalMs: 10 * MINUTE,
    official: 'openai',
    categories: LAB_CATEGORIES,
  },
  {
    id: 'claude-release-notes',
    name: 'Claude release notes',
    url: 'https://platform.claude.com/docs/en/release-notes/feed.xml',
    kind: 'feed',
    intervalMs: 15 * MINUTE,
    official: 'anthropic',
    updatesInPlace: true,
    categories: LAB_CATEGORIES,
  },
  {
    id: 'anthropic-sitemap',
    name: 'Anthropic',
    url: 'https://www.anthropic.com/sitemap.xml',
    kind: 'sitemap',
    intervalMs: 10 * MINUTE,
    official: 'anthropic',
    categories: LAB_CATEGORIES,
    accept: launchPage,
  },
  {
    id: 'google-gemini',
    name: 'Google: Gemini models',
    url: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/rss/',
    kind: 'feed',
    intervalMs: 15 * MINUTE,
    official: 'google',
    categories: LAB_CATEGORIES,
  },
  {
    id: 'deepmind',
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    kind: 'feed',
    intervalMs: 15 * MINUTE,
    official: 'google',
    categories: LAB_CATEGORIES,
  },
  {
    id: 'deepseek-news',
    name: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/sitemap.xml',
    kind: 'sitemap',
    intervalMs: 30 * MINUTE,
    official: 'deepseek',
    categories: LAB_CATEGORIES,
    accept: (item) => /\/news\/news\d{6}\/?$/.test(item.key),
  },
  {
    id: 'qwen-blog',
    name: 'Qwen blog',
    url: 'https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=en-US',
    kind: 'custom',
    parse: parseQwenArticles,
    // A megabyte a poll, gzipped: every post with its whole text
    intervalMs: 60 * MINUTE,
    official: 'alibaba',
    // The site shows nothing without JavaScript; the API gives the whole post
    selfContained: true,
    categories: ['ai-enterprise', 'ai-homebrew'],
  },
  ...HUGGING_FACE_ORGS.map(huggingFace),
  {
    id: 'claude-code-commands',
    name: 'Claude Code: commands',
    url: 'https://code.claude.com/docs/en/commands.md',
    kind: 'custom',
    parse: parseClaudeCodeCommands,
    intervalMs: 30 * MINUTE,
    official: 'anthropic',
    categories: ['vibecoding'],
  },
  {
    id: 'claude-code-whats-new',
    name: "Claude Code: What's new",
    url: 'https://code.claude.com/docs/en/whats-new/rss.xml',
    kind: 'custom',
    parse: parseClaudeCodeWhatsNew,
    intervalMs: 60 * MINUTE,
    official: 'anthropic',
    categories: ['vibecoding'],
  },
  {
    id: 'codex-changelog',
    name: 'Codex changelog',
    url: 'https://developers.openai.com/codex/changelog/rss.xml',
    kind: 'feed',
    intervalMs: 30 * MINUTE,
    official: 'openai',
    // The page is the whole changelog; a release's entry has all of its notes
    selfContained: true,
    categories: ['vibecoding'],
    // The CLI's minor versions and the product posts: a patch release only fixes bugs
    accept: (item) => !/^Codex CLI Release: \d+\.\d+\.[1-9]\d*$/.test(item.title),
  },
  {
    id: 'cursor-changelog',
    name: 'Cursor changelog',
    url: 'https://cursor.com/changelog/rss.xml',
    kind: 'feed',
    intervalMs: 60 * MINUTE,
    official: 'cursor',
    categories: ['vibecoding'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI release notes',
    url: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/changelogs/index.md',
    kind: 'custom',
    parse: parseGeminiCliAnnouncements,
    intervalMs: 60 * MINUTE,
    official: 'google',
    // A release's page on GitHub is a bare list of pull requests; the announcement is the story
    selfContained: true,
    categories: ['vibecoding'],
  },
  {
    id: 'copilot-changelog',
    name: 'GitHub Copilot changelog',
    url: 'https://github.blog/changelog/label/copilot/feed/',
    kind: 'feed',
    intervalMs: 60 * MINUTE,
    official: 'github',
    categories: ['vibecoding'],
    // About twenty entries a week; the Friday roundup of the week is the one worth a post
    accept: (item) => /^GitHub Copilot weekly releases/i.test(item.title),
  },
];
