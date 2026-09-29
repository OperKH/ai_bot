import { type FeedItem, htmlToText, parseFeed, SUMMARY_MAX } from './feed';
import { clip } from '../words';

const CLAUDE_CODE_CHANGELOG = 'https://code.claude.com/docs/en/changelog';

/** Markdown as plain text: links as their text, no emphasis, table pipes unescaped */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\\\|/g, '|')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

interface HuggingFaceModel {
  id: string;
  pipeline_tag?: string;
  tags?: string[];
}

/**
 * The models of a Hugging Face organization, newest first, as the models API
 * lists them: a new repository is the news. What the sorting model reads is the
 * repository's name, which carries the family, the version and the size
 * (`Qwen/Qwen3.9-27B-Instruct`), and its tags. No date: a repository is often
 * created privately weeks before it is published, so a new name counts, not its
 * `createdAt`.
 */
export function parseHuggingFaceModels(json: string): FeedItem[] {
  const models = JSON.parse(json) as HuggingFaceModel[];
  return models.map((model) => {
    const tags = (model.tags ?? []).filter((tag) => !tag.startsWith('region:') && !tag.startsWith('endpoints_'));
    return {
      key: model.id,
      title: model.id,
      url: `https://huggingface.co/${model.id}`,
      // Said outright, so the sorting sees open weights rather than a bare name
      summary:
        `A new open-weights model repository on Hugging Face` +
        (model.pipeline_tag ? `, for ${model.pipeline_tag}` : '') +
        (tags.length > 0 ? `. Tags: ${tags.join(', ')}` : ''),
      publishedAt: null,
      imageUrl: null,
    };
  });
}

interface QwenArticle {
  id: string;
  title: string;
  /** The whole post as an HTML page */
  content: string;
  path: string;
  extra?: { tags?: string[]; date?: string; cover_small?: string };
}

/**
 * The posts of Qwen's blog from its undocumented JSON API: the 40 latest, not in
 * order, each with its whole text. Research papers are left out — only releases
 * and open-source models are news.
 */
export function parseQwenArticles(json: string): FeedItem[] {
  const articles = (JSON.parse(json) as { data: { articles: QwenArticle[] } }).data.articles;
  return articles
    .filter((article) => article.extra?.tags?.some((tag) => /^(release|open-?source)$/i.test(tag)))
    .map((article) => {
      const date = article.extra?.date;
      return {
        key: article.id,
        title: article.title,
        url: `https://qwen.ai/blog?id=${encodeURIComponent(article.path)}`,
        // The post without the site's navigation around it
        summary: clip(htmlToText(/<article\b[\s\S]*?<\/article>/i.exec(article.content)?.[0] ?? article.content), SUMMARY_MAX),
        publishedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date) : null,
        imageUrl: article.extra?.cover_small ?? null,
      };
    });
}

/**
 * The commands in the reference table of Claude Code (`commands.md`). A name that
 * was not there before is a new command — the changelog alone is not enough to
 * tell: its «Added `/x`» often names a command that already existed. The entry
 * points at the changelog, whose latest notes tell what the command came with.
 */
export function parseClaudeCodeCommands(markdown: string): FeedItem[] {
  return markdown.split('\n').flatMap((line) => {
    const match = /^\|\s*`(\/[\w:-]+)[^`]*`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!match) return [];
    const [, name, purpose] = match;
    return [
      {
        key: name,
        title: `New Claude Code command ${name}`,
        url: CLAUDE_CODE_CHANGELOG,
        summary: clip(markdownToText(purpose), SUMMARY_MAX),
        publishedAt: null,
        imageUrl: null,
      },
    ];
  });
}

/**
 * Claude Code's weekly «What's new»: an entry per week, linked to that week's
 * digest page rather than to the page of all weeks, so the facts are the week's.
 */
export function parseClaudeCodeWhatsNew(xml: string): FeedItem[] {
  const digests = new Map<string, string>();
  for (const entry of xml.split('</item>')) {
    const guid = /<guid[^>]*>([^<]+)<\/guid>/.exec(entry)?.[1].trim();
    const digest = /https:\/\/code\.claude\.com\/docs\/en\/whats-new\/\d{4}-w\d+/.exec(entry)?.[0];
    if (guid && digest) digests.set(guid, digest);
  }
  return parseFeed(xml).map((item) => ({ ...item, url: digests.get(item.key) ?? item.url }));
}

/**
 * The announcements of stable Gemini CLI releases (`docs/changelogs/index.md`):
 * the highlights of a version, which its GitHub release lacks — that is a bare
 * list of pull requests.
 */
export function parseGeminiCliAnnouncements(markdown: string): FeedItem[] {
  return markdown.split(/^## /m).flatMap((section) => {
    const match = /^Announcements: (v\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})\s*\n([\s\S]*)$/.exec(section);
    if (!match) return [];
    const [, version, day, body] = match;
    return [
      {
        key: version,
        title: `Gemini CLI ${version}`,
        url: `https://github.com/google-gemini/gemini-cli/releases/tag/${version}`,
        summary: clip(
          markdownToText(body)
            .replace(/\n(?!- )/g, ' ')
            .replace(/\s*\((?:#\d+|@)[^()]*\)/g, ''),
          SUMMARY_MAX,
        ),
        publishedAt: new Date(`${day}T00:00:00Z`),
        imageUrl: null,
      },
    ];
  });
}
