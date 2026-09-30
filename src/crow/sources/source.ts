import type { CategoryId } from '../categories';
import type { JobState } from '../jobs';
import type { FeedItem } from './feed';

/** A place the crow gets news from (docs/crow/pipeline.md) */
export type SourceDefinition = SourceBase & SourceFormat;

interface SourceBase {
  id: string;
  /** Names the publisher in the story's sources and in prompts */
  name: string;
  url: string;
  intervalMs: number;
  /**
   * The vendor whose own channel this is: its entries confirm that vendor's stories. For the game news, any
   * platform's own channel is official for what it announces
   */
  official?: string;
  /**
   * Who stands behind the source, so a game story counts its publishers rather than its sites: the four sites
   * of Hookshot Media are one publisher. By default the source's name
   */
  publisher?: string;
  /**
   * An entry is the whole news by itself — a store's list of its free games, of the games leaving a
   * subscription — rather than a report of one: it is a story of its own at once
   */
  structured?: boolean;
  /**
   * The platform's own word on what its subscription gives and takes — PS Plus's monthly games, the games coming
   * to its catalog and leaving it: an entry of it with the day they come or go (`deadline`) is the news itself,
   * written at once and sent first, past the chat's limits, whoever else wrote of it (docs/crow/pipeline.md#game-stories)
   */
  lineup?: boolean;
  /** The source is polled from this moment on, e.g. the hunts for GTA VI's mysteries after its release */
  activeFrom?: Date;
  /** A catalog of models: a listing there means the model is out, whoever announced it */
  aggregator?: boolean;
  /** The source rewrites an entry during the day; a changed entry counts as new again */
  updatesInPlace?: boolean;
  /**
   * An entry carries the whole story, and its page is not read for the facts: the page shows
   * other entries too, or nothing without JavaScript
   */
  selfContained?: boolean;
  categories: CategoryId[];
  /** The entries worth sorting; by default all */
  accept?(item: FeedItem): boolean;
}

/**
 * How the answer is read: as a feed or a sitemap, or by the source's own `parse` — a JSON API, a Markdown page —
 * or, for a source that takes more than one request, by its own `fetch`, which keeps what it needs in the job's state
 */
type SourceFormat =
  | { kind: 'feed' | 'sitemap' }
  | { kind: 'custom'; parse(body: string): FeedItem[] }
  | { kind: 'fetch'; fetch(state: JobState): Promise<{ items: FeedItem[]; state: JobState }> };

