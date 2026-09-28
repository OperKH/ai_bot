import type { InputFile } from 'grammy';
import type { InputRichBlock, InputRichMessage, RichBlockTableCell, RichText } from 'grammy/types';
import type { CrowLink, CrowMention, CrowMoment } from '../entity/CrowPost.entity';
import type { CrowStory, CrowStorySource } from '../entity/CrowStory.entity';
import type { CrowTable } from '../entity/CrowStoryMessage.entity';

export type Moment = CrowMoment;
export type PostLink = CrowLink;

/** What the placeholders of a text stand for */
export interface TextRefs {
  /** Of `{when:<id>}` */
  moments?: Record<string, Moment>;
  /** Of `{link:<id>}` */
  anchors?: Record<string, PostLink>;
  /** Of `{cat}`: the cat of a jab */
  mention?: CrowMention | null;
  /** Of `{cat:<id>}` */
  mentions?: Record<string, CrowMention>;
}

export interface PostContent extends TextRefs {
  text: string;
  /** A heading above the text */
  heading?: string;
  table?: CrowTable | null;
  /** The pictures of the post, each a file_id or a file to upload; more than one make a collage */
  photos?: (InputFile | string)[];
  /** A gallery to swipe instead: a picture a game of a list, by its web address, with its name */
  gallery?: { url: string; caption: string }[];
  /** Where to read the news in full, at the end: the first post of a story has them, the rest do not */
  links?: PostLink[];
  /** What the links at the end are introduced with */
  linksLabel?: string;
}

/** A source's address if it is a web page: a source may keep only an entry's key */
function webPage(url: string): URL | null {
  const parsed = URL.parse(url);
  return parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed : null;
}

/**
 * Where to read a story in full: its first official page, or its first source
 * when none is official — a model known only from OpenRouter; null for a story
 * with no web page among its sources.
 */
export function storyUrl(sources: readonly CrowStorySource[]): URL | null {
  const pages = sources.flatMap((source) => {
    const url = webPage(source.url);
    return url ? [{ url, official: source.official }] : [];
  });
  return (pages.find((page) => page.official) ?? pages[0])?.url ?? null;
}

/**
 * The links the news of `stories` ends with. An opening names the site its link
 * leads to, «anthropic.com»; a morning digest, which tells several stories,
 * names each by its hero, «Claude Opus 5.5 · Gemini 3.8 Live».
 */
export function newsLinks(stories: readonly Pick<CrowStory, 'hero' | 'sources'>[]): PostLink[] {
  return stories.flatMap((story) => {
    const url = storyUrl(story.sources);
    if (!url) return [];
    const site = url.hostname.replace(/^www\./, '');
    return [{ label: stories.length > 1 && story.hero ? story.hero : site, url: url.href }];
  });
}

/** «🔗 Детальніше: anthropic.com», each label a link */
function linksBlock(links: readonly PostLink[], label = '🔗 Детальніше:'): InputRichBlock {
  const parts: RichText[] = [`${label} `];
  links.forEach((link, i) => {
    if (i > 0) parts.push(' · ');
    parts.push({ type: 'url', text: link.label, url: link.url });
  });
  return { type: 'paragraph', text: parts };
}

/**
 * `**bold**` (a name), `==marked==` (a price, a date — highlighted in colour) and
 * `{when:<id>}` — the only markup the crow's texts may carry — and `` `code` ``,
 * which the facts keep from the sources (`reasoning.mode`) and the models copy;
 * `{cat}`, `{cat:<id>}`, `{link:<id>}` and `~~struck~~` (a price before a giveaway)
 * are put in by the code
 */
const MARKUP =
  /\*\*(?<bold>.+?)\*\*|==(?<marked>.+?)==|~~(?<struck>.+?)~~|\{when:(?<moment>[\w-]+)\}|`(?<code>[^`\n]+)`|\{(?<cat>cat)(?::(?<catId>[\w-]+))?\}|\{link:(?<link>[\w-]+)\}/g;
/** A line of a list */
const BULLET = /^[•\-–]\s+/;
/** A cell that holds a number, a price or a percentage: aligned right */
const NUMERIC = /^[\d\s.,:%×x$€₴+−-]+$/;

/**
 * A cat named in a jab: a mention by username, or by id for a cat who has none,
 * so they get a notification — or only the name, when the crow is restrained.
 */
function mentionText(mention: CrowMention): RichText {
  if (!mention.ping) return mention.name;
  if (mention.username) return { type: 'mention', text: `@${mention.username}`, username: mention.username };
  return { type: 'text_mention', text: mention.name, user: { id: Number(mention.userId), is_bot: false, first_name: mention.name } };
}

/** The piece of rich text a placeholder stands for, or null when nothing is known of it */
function placeholder(groups: Record<string, string | undefined>, refs: TextRefs): RichText | null {
  if (groups.cat !== undefined) {
    const mention = groups.catId === undefined ? refs.mention : refs.mentions?.[groups.catId];
    return mention ? mentionText(mention) : null;
  }
  if (groups.link !== undefined) {
    const anchor = refs.anchors?.[groups.link];
    return anchor ? { type: 'url', text: anchor.label, url: anchor.url } : null;
  }
  const moment = groups.moment === undefined ? undefined : refs.moments?.[groups.moment];
  return moment ? { type: 'date_time', text: moment.fallback, unix_time: moment.unixTime, date_time_format: moment.format } : null;
}

/**
 * The text as rich text. It goes in as data, so nothing needs escaping — and
 * nothing else is markup: a model's `$2 / $10` in rich Markdown would turn into
 * a formula. A placeholder of something that is not known — a moment, a link,
 * a cat — is left out.
 */
export function richText(text: string, refs: TextRefs = {}): RichText {
  const parts: RichText[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKUP)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const groups = match.groups ?? {};
    if (groups.bold !== undefined) parts.push({ type: 'bold', text: richText(groups.bold, refs) });
    else if (groups.marked !== undefined) parts.push({ type: 'marked', text: richText(groups.marked, refs) });
    else if (groups.struck !== undefined) parts.push({ type: 'strikethrough', text: richText(groups.struck, refs) });
    else if (groups.code !== undefined) parts.push({ type: 'code', text: groups.code });
    else {
      const piece = placeholder(groups, refs);
      if (piece !== null) parts.push(piece);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts;
}

/** The text without its emphasis — bold, marked, struck — for what takes no markup, such as a poll */
export function withoutMarkup(text: string): string {
  return text.replace(/\*\*(.+?)\*\*|==(.+?)==|~~(.+?)~~/g, (_, bold, marked, struck) => bold ?? marked ?? struck);
}

/**
 * The text as the chat read it, for the crow's memory: the placeholders in words —
 * a moment as its fallback, a link as its label, a cat by name; the markup kept
 */
export function readableText(text: string, refs: TextRefs = {}): string {
  return text.replace(MARKUP, (whole, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.bold !== undefined) return `**${readableText(groups.bold, refs)}**`;
    if (groups.marked !== undefined) return `==${readableText(groups.marked, refs)}==`;
    if (groups.struck !== undefined) return `~~${readableText(groups.struck, refs)}~~`;
    if (groups.code !== undefined) return whole;
    if (groups.cat !== undefined) {
      return (groups.catId === undefined ? refs.mention : refs.mentions?.[groups.catId])?.name ?? 'кіт';
    }
    if (groups.link !== undefined) return refs.anchors?.[groups.link]?.label ?? '';
    return (groups.moment === undefined ? undefined : refs.moments?.[groups.moment])?.fallback ?? '';
  });
}

/** Lines become paragraphs, and runs of `•` lines a list */
function textBlocks(text: string, refs: TextRefs): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  let items: string[] = [];
  const flushList = () => {
    if (items.length === 0) return;
    blocks.push({
      type: 'list',
      items: items.map((item) => ({ blocks: [{ type: 'paragraph', text: richText(item, refs) }] })),
    });
    items = [];
  };
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (line === '') {
      flushList();
    } else if (BULLET.test(line)) {
      items.push(line.replace(BULLET, ''));
    } else {
      flushList();
      blocks.push({ type: 'paragraph', text: richText(line, refs) });
    }
  }
  flushList();
  return blocks;
}

const cell = (text: string, refs: TextRefs, is_header?: true): RichBlockTableCell => ({
  text: richText(text, refs),
  // A price cell, «~~459 ₴~~ **0 ₴**», is a number all the same
  align: !is_header && NUMERIC.test(withoutMarkup(text)) ? 'right' : 'left',
  valign: 'middle',
  is_header,
});

const photoBlock = (media: InputFile | string): InputRichBlock & { type: 'photo' } => ({ type: 'photo', photo: { type: 'photo', media } });

/** Telegram takes 50 media a rich message; a gallery of more is no longer looked through */
const MAX_GALLERY = 30;

/** A post of the crow as one rich message: the picture (a collage of several), the text, the table, the links */
export function crowRichMessage(content: PostContent): InputRichMessage {
  const refs: TextRefs = {
    moments: content.moments,
    anchors: content.anchors,
    mention: content.mention,
    mentions: content.mentions,
  };
  const blocks: InputRichBlock[] = [];
  const photos = content.photos ?? [];
  if (content.gallery && content.gallery.length > 0) {
    blocks.push({
      type: 'slideshow',
      blocks: content.gallery.slice(0, MAX_GALLERY).map(({ url, caption }) => ({
        ...photoBlock(url),
        caption: { text: caption },
      })),
    });
  } else if (photos.length === 1) blocks.push(photoBlock(photos[0]));
  else if (photos.length > 1) blocks.push({ type: 'collage', blocks: photos.map(photoBlock) });
  if (content.heading) blocks.push({ type: 'heading', text: richText(content.heading, refs), size: 3 });
  blocks.push(...textBlocks(content.text, refs));
  if (content.table) {
    blocks.push({
      type: 'table',
      is_striped: true,
      cells: [
        content.table.header.map((text) => cell(text, refs, true)),
        ...content.table.rows.map((row) => row.map((text) => cell(text, refs))),
      ],
    });
  }
  if (content.links && content.links.length > 0) blocks.push(linksBlock(content.links, content.linksLabel));
  return { blocks };
}
