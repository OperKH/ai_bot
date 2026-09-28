import type { MessageEntity } from 'grammy/types';
import type { CrowFact, CrowStorySource } from '../entity/CrowStory.entity';
import {
  type Attempt,
  crowPrefix,
  placeholderProblems,
  textProblems,
  writeChecked,
  writeText,
  type WrittenText,
} from './arcValidation';
import type { Priced } from './crowLlm';
import type { RumorUpdateRequest, TalkResult, ToldRequest, ToldResult } from './prompts';

const DAY = 24 * 3_600_000;

/** The crow says «я ж казала» of a story she told the chat this long ago at most */
export const TOLD_WINDOW_MS = 30 * DAY;
export const MAX_TOLD_LENGTH = 300;
export const MAX_RUMOR_UPDATE_LENGTH = 600;
/** Query parameters that only say where a click came from */
const TRACKING = /^(utm_.+|fbclid|gclid|yclid|mc_cid|mc_eid|ref|ref_src|ref_url|si|igshid)$/i;
const SCHEME = /^[a-z][\w+.-]*:\/\//i;

/**
 * A link as links are compared: the host without `www.`, the path without a
 * trailing slash, no fragment and no trackers. A link to a site's front page is
 * none: it names no news. A link a cat wrote without its scheme, `anthropic.com/news/…`, counts.
 */
export function normalizeUrl(raw: string): string | null {
  const url = URL.parse(SCHEME.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '') return null;
  const params = [...url.searchParams].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${path}${query}`;
}

/** The links of a message: those it shows and those behind its words, and the one its preview is of */
export function messageUrls(text: string, entities: readonly MessageEntity[] = [], previewUrl?: string): string[] {
  const urls = entities.flatMap((entity) => {
    if (entity.type === 'url') return [text.slice(entity.offset, entity.offset + entity.length)];
    return entity.type === 'text_link' ? [entity.url] : [];
  });
  return [...new Set([...urls, ...(previewUrl ? [previewUrl] : [])])];
}

/** A story the crow told the chat, as «я ж казала» looks for it */
export interface ToldStory {
  storyId: number;
  title: string;
  facts: CrowFact[];
  aliases: string[];
  sources: CrowStorySource[];
  /** Her first post of it in the chat: its opening, or the morning digest that told it */
  sentAt: Date;
  tgMessageId: number | null;
  /** What she said then */
  text: string;
  /** She has said «я ж казала» of it in the chat already */
  toldYou: boolean;
}

/**
 * The story a cat's forward or link brings back, if the crow told the chat of it
 * and has not said «я ж казала» of it yet: one whose source the link leads to —
 * the same news for sure — or else the latest one the message names by its
 * aliases, which the model still has to confirm.
 */
export function broughtStory(
  message: { text: string; urls: string[] },
  stories: readonly ToldStory[],
  namer: (text: string) => (aliases: readonly string[]) => boolean,
): { story: ToldStory; sameSource: boolean } | null {
  const fresh = stories.filter((story) => !story.toldYou);
  const links = new Set(message.urls.map(normalizeUrl).filter((url) => url !== null));
  const bySource = fresh.find((story) =>
    story.sources.some((source) => SCHEME.test(source.url) && links.has(normalizeUrl(source.url) ?? '')),
  );
  if (bySource) return { story: bySource, sameSource: true };
  // A link hides its words from the text: its path names the news too, «…/claude-opus-5-5»
  const names = namer([message.text, ...message.urls].join(' '));
  const named = fresh.filter((story) => names(story.aliases)).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  return named.length > 0 ? { story: named[0], sameSource: false } : null;
}

/** What is wrong with a «я ж казала», in words the model gets back when it rewrites it */
export function toldProblems(text: string, allowed: Set<string>): string[] {
  return [...placeholderProblems(text, '{when}'), ...textProblems(text, allowed, MAX_TOLD_LENGTH)];
}

export interface WrittenTold {
  /** Null when she keeps quiet: not her news after all, or the text still failed after the rewrite */
  text: string | null;
  /** The cat brought other news than hers */
  declined: boolean;
  attempts: Attempt[];
}

/** Writes a «я ж казала» as the arcs are written: an attempt, the checks, one rewrite with the problems listed */
export async function writeTold(
  write: (request: ToldRequest) => Promise<Priced<ToldResult>>,
  request: ToldRequest,
  allowed: Set<string>,
): Promise<WrittenTold> {
  const { value, problems, attempts } = await writeChecked(
    write,
    request,
    (result) => ({ same: result.sameNews || request.sameSource, text: crowPrefix(result.text.trim()).text }),
    ({ same, text }) => (same ? toldProblems(text, allowed) : []),
  );
  return { text: value.same && problems.length === 0 ? value.text : null, declined: !value.same, attempts };
}

/** What is wrong with a UPD, in words the model gets back when it rewrites it */
export function rumorUpdateProblems(text: string, allowed: Set<string>): string[] {
  return textProblems(text, allowed, MAX_RUMOR_UPDATE_LENGTH);
}

/** Writes the UPD to a confirmed rumor as the arcs are written: an attempt, the checks, one rewrite */
export function writeRumorUpdate(
  write: (request: RumorUpdateRequest) => Promise<Priced<TalkResult>>,
  request: RumorUpdateRequest,
  allowed: Set<string>,
): Promise<WrittenText> {
  return writeText(write, request, (text) => rumorUpdateProblems(text, allowed));
}
