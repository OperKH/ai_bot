import { getLinkChatId } from '../bot/telegramLinks';
import type { CrowSourceItem } from '../entity/CrowSourceItem.entity';
import type { CrowDeadline, CrowFact, CrowStory } from '../entity/CrowStory.entity';
import { isQuotaError } from '../services/openai.service';
import { budgetDay, type BudgetState, spend, today, withinBudget } from './budget';
import { allowedNumbers } from './arcValidation';
import { MAX_FACTS } from './arcOutline';
import { arcRequest, writeArc } from './arcWriter';
import type { Random } from './cadence';
import {
  type Category,
  type CategoryId,
  categoryLabel,
  findCategory,
  GTA6_RELEASE,
  type Importance,
  isGameStory,
  publishersNeeded,
} from './categories';
import { localDate } from './chatClock';
import { matchStory } from './clustering';
import { cleanSnippets, storyAliases } from './conversation';
import type { CrowLlm, SortableItem } from './crowLlm';
import { type Embedder, embedOrNone, entryText, postFacts } from './embeddings';
import { MAX_REMINDER_LENGTH, reminderPost, reminderWindow, writeReminder } from './deadlines';
import { saveStoryImage } from './images';
import { withQuiz, writeQuiz } from './quiz';
import type { CrowJobDefinition, JobState } from './jobs';
import { normalizeTopicKey, normalizeVendor } from './modelKey';
import { cadenceCategory, JAB_MIN_POSTS, planArc, type PlannedJab, withJabs } from './planning';
import type { JabWriter } from './profile';
import { mergeRoster } from './roster';
import type { CrowStore, ItemPlacement, SubscribedChat } from './store';
import { gameStoryVerdict, storyVerdict, type StoryVerdict } from './stories';
import { MAX_RUMOR_UPDATE_LENGTH, writeRumorUpdate } from './toldYou';
import { BETS_PER_WEEK, MAX_BET_DAYS, MIN_BET_DAYS, withBet, writeBet } from './bets';
import { clip, yearDateLabel } from './words';
import { type ConditionalState, type FeedItem, fetchText, parseFeed, parseSitemap, readPage } from './sources/feed';
import type { SourceDefinition } from './sources/source';

const LOG_PREFIX = '[Crow]';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Entries sorted per call */
const SORT_BATCH = 25;
/** What the sorting model reads of an entry */
const SORT_SUMMARY_MAX = 1200;
/** What the model that matches a game news to a story reads of the entry */
const MATCH_SUMMARY_MAX = 300;
/** Entries of one topic within this time are one story */
const TOPIC_WINDOW_MS = 72 * HOUR;
/** An entry dated older than this when first seen is not news */
const STALE_ITEM_MS = 48 * HOUR;
/** Sources read per story, official ones first */
const MATERIAL_SOURCES = 4;
const MATERIALS_MAX = 16_000;
const PIPELINE_INTERVAL_MS = 2 * MINUTE;
/** The UPD to a confirmed rumor waits this long for a chat that keeps the crow quiet */
const RUMOR_UPDATE_TTL_MS = 12 * HOUR;
/** How long the pipeline waits after OpenAI said the balance is empty, unless the owner runs it */
const QUOTA_PAUSE_MS = HOUR;

const clampImportance = (value: number): Importance => (value >= 3 ? 3 : value <= 1 ? 1 : 2);

/** What the owner hears when the day's budget is spent */
export interface BudgetReport {
  limitUsd: number;
  spentUsd: number;
  /** The stories waiting to be written */
  waiting: { title: string; since: Date }[];
  /** Posts of arcs already written, still to go out in the chats */
  plannedPosts: number;
}

/** The pipeline's limit of spending a day, and who hears when it is reached */
export interface PipelineBudget {
  limitUsd: number;
  /** Told when stories wait for money; the pipeline asks at most once a day, the owner alert throttles too */
  onSpent?: (report: BudgetReport) => Promise<unknown>;
}

/**
 * Turns the entries of the news sources into arcs in the chats
 * (docs/crow/pipeline.md): every source is a job that remembers what it
 * lists, and the pipeline job sorts the new entries, gathers them into
 * stories, writes the arc of a story once it is confirmed and plans it into
 * the subscribed chats.
 */
export class CrowPipeline {
  private readonly sourceById: Map<string, SourceDefinition>;
  /** The day the spent budget was last reported, so the warning comes once a day, not every run */
  private budgetWarnedOn?: string;

  constructor(
    private readonly store: CrowStore,
    private readonly llm: CrowLlm,
    private readonly sources: readonly SourceDefinition[],
    private readonly budget: PipelineBudget,
    /** Writes the personal jabs of each chat's arc, from its profile; none without it */
    private readonly jabWriter: JabWriter | null = null,
    /** EmbeddingGemma: the vectors of the entries, the details and the posts; none without it */
    private readonly embed: Embedder | null = null,
    private readonly random: Random = Math.random,
  ) {
    this.sourceById = new Map(sources.map((source) => [source.id, source]));
  }

  jobs(): CrowJobDefinition[] {
    return [...this.sources.map((source) => this.sourceJob(source)), this.pipelineJob()];
  }

  private sourceJob(source: SourceDefinition): CrowJobDefinition {
    return {
      name: `source:${source.id}`,
      nextRun: (startedAt) => new Date(startedAt.getTime() + source.intervalMs),
      run: async (state) => {
        if (source.activeFrom && new Date() < source.activeFrom) return;
        const read = await this.read(source, state);
        if (!read) return;
        const items = read.items.filter((item) => source.accept?.(item) ?? true);
        const baseline = state.seeded !== true;
        const news = await this.store.addSourceItems(source, items, baseline, new Date(), STALE_ITEM_MS);
        if (baseline) {
          console.log(`${LOG_PREFIX} Source ${source.id}: ${items.length} entries remembered, news from now on`);
        } else if (news > 0) {
          console.log(`${LOG_PREFIX} Source ${source.id}: ${news} new entries`);
          await this.store.setJobDue('pipeline', new Date());
        }
        return { ...read.state, seeded: true };
      },
    };
  }

  /** A poll of a source: its entries and what the next poll needs, or null when nothing changed since */
  private async read(source: SourceDefinition, state: JobState): Promise<{ items: FeedItem[]; state: JobState } | null> {
    if (source.kind === 'fetch') return source.fetch(state);
    const fetched = await fetchText(source.url, state as ConditionalState);
    if (fetched.notModified) return null;
    const items =
      source.kind === 'custom'
        ? source.parse(fetched.body)
        : source.kind === 'feed'
          ? parseFeed(fetched.body)
          : parseSitemap(fetched.body);
    return { items, state: { ...fetched.state } };
  }

  private pipelineJob(): CrowJobDefinition {
    return {
      name: 'pipeline',
      nextRun: (startedAt) => new Date(startedAt.getTime() + PIPELINE_INTERVAL_MS),
      run: async (state) => {
        const started = new Date();
        // After an empty balance the pipeline waits, unless the owner resumed it (`resumeJob`)
        if (typeof state.pausedUntil === 'string' && new Date(state.pausedUntil) > started) return;
        let budget = state.budget as BudgetState | undefined;
        const pay = (costUsd: number) => {
          budget = spend(budget, new Date(), costUsd);
        };
        const canPay = () => withinBudget(budget, new Date(), this.budget.limitUsd);
        const spent = () => today(budget, new Date()).spentUsd;
        const next: JobState = { ...state, budget };
        delete next.pausedUntil;
        try {
          if (canPay()) await this.sortNewItems(pay);
          await this.promoteStories(pay, canPay, spent);
          await this.confirmRumors(pay, canPay);
        } catch (e) {
          if (isQuotaError(e)) {
            // The owner hears of it from OpenAIService; the stories stay pending for the next try
            console.warn(`${LOG_PREFIX} OpenAI has no money left; the pipeline waits an hour, or for the owner to run it`);
            return { ...next, budget, pausedUntil: new Date(started.getTime() + QUOTA_PAUSE_MS).toISOString() };
          }
          // What a failed run spent still counts
          await this.store.saveJob('pipeline', { state: { ...state, budget } });
          throw e;
        }
        return { ...next, budget } satisfies JobState;
      },
    };
  }

  /**
   * Sorts the new entries into stories: the AI news by their topic, the game news by their meaning. Entries of
   * categories no chat wants are not sorted at all: that would only spend money.
   */
  private async sortNewItems(pay: (costUsd: number) => void) {
    const items = await this.store.newItems(SORT_BATCH);
    if (items.length === 0) return;
    const wanted = await this.store.subscribedCategories();
    const unwanted = items.filter((item) => !this.sourceById.get(item.sourceId)?.categories.some((c) => wanted.has(c)));
    await this.store.markItems(
      unwanted.map((item) => item.id),
      'seen',
    );
    const sortable = items.filter((item) => !unwanted.includes(item));
    const games = sortable.filter((item) => this.isGameSource(item.sourceId));
    const ai = sortable.filter((item) => !games.includes(item));
    if (ai.length > 0) await this.sortAiItems(ai, wanted, pay);
    if (games.length > 0) await this.sortGameItems(games, wanted, pay);
  }

  private isGameSource(sourceId: string): boolean {
    return isGameStory(this.sourceById.get(sourceId)?.categories ?? []);
  }

  /** An entry as a sorting model reads it */
  private sortable(item: CrowSourceItem, index: number): SortableItem {
    const source = this.sourceById.get(item.sourceId);
    return {
      index,
      source: source?.name ?? item.sourceId,
      official: source?.official !== undefined,
      title: item.title,
      summary: clip(item.summary, SORT_SUMMARY_MAX),
      url: item.url,
    };
  }

  /** The AI news: a story is its topic, a model's family and version, within 72 hours */
  private async sortAiItems(sortable: CrowSourceItem[], wanted: Set<string>, pay: (costUsd: number) => void) {
    const { result, costUsd } = await this.llm.sort(sortable.map((item, index) => this.sortable(item, index)));
    pay(costUsd);

    for (const [index, item] of sortable.entries()) {
      const verdict = result.items.find((v) => v.index === index);
      const source = this.sourceById.get(item.sourceId);
      // A source of one category brings that category's news, whatever the model called it: GPT-6 in Codex's
      // changelog is news of the coding tools, not an entry to drop
      const category = !verdict?.relevant
        ? undefined
        : source?.categories.length === 1
          ? findCategory(source.categories[0])
          : findCategory(verdict.category);
      if (!verdict || !source || !category || !source.categories.includes(category.id) || !wanted.has(category.id)) {
        await this.store.markItems([item.id], 'irrelevant');
        continue;
      }
      const vendor = normalizeVendor(verdict.vendor);
      const { story, created } = await this.store.attachToStory(
        item,
        {
          topicKey: normalizeTopicKey(verdict.topicKey, vendor),
          vendor,
          hero: verdict.model,
          title: verdict.title,
          categories: [category.id],
          importance: clampImportance(verdict.importance),
          isRumor: verdict.isRumor,
          // An AI news is its topic: its entries need no vector
          embedding: null,
        },
        { url: item.url ?? item.key, publisher: source.name, official: source.official === vendor },
        new Date(),
        TOPIC_WINDOW_MS,
      );
      console.log(`${LOG_PREFIX} ${created ? 'New story' : 'Story'} ${story.id} «${story.title}» ← ${source.id}`);
    }
  }

  /**
   * The game news (docs/crow/pipeline.md#game-stories): an entry joins the story of the last 72 hours with its
   * link, nearly its headline, or its meaning; one close in meaning but not surely the same is the model's to
   * say, all of a run in one call. A store's own list is a story of its own.
   */
  private async sortGameItems(sortable: CrowSourceItem[], wanted: Set<string>, pay: (costUsd: number) => void) {
    const now = new Date();
    const { result, costUsd } = await this.llm.sortGames(
      sortable.map((item, index) => this.sortable(item, index)),
      now >= GTA6_RELEASE,
    );
    pay(costUsd);
    const placed = sortable.flatMap((item, index) => {
      const verdict = result.items.find((v) => v.index === index);
      const source = this.sourceById.get(item.sourceId);
      const categories = (verdict?.relevant ? verdict.categories : [])
        .filter((id): id is CategoryId => source?.categories.includes(id as CategoryId) === true && wanted.has(id));
      return verdict && source && categories.length > 0 ? [{ item, verdict, source, categories: [...new Set(categories)] }] : [];
    });
    const unplaced = sortable.filter((item) => !placed.some((p) => p.item === item));
    // The title the sorting gave, which reads the same whoever wrote the news, for the left-out entries too
    const sortedTitle = (item: CrowSourceItem) => result.items.find((v) => v.index === sortable.indexOf(item))?.title ?? item.title;
    const vectors = await embedOrNone(
      this.embed,
      [...placed.map(({ item, verdict }) => entryText(item.title, verdict.title)), ...unplaced.map((item) => entryText(item.title, sortedTitle(item)))],
      'similarity',
    );
    const since = new Date(now.getTime() - TOPIC_WINDOW_MS);
    const recent = await this.store.recentGameStories(since);
    const doubtful: { entry: (typeof placed)[number]; placement: ItemPlacement; storyId: number }[] = [];
    const attach = async (
      { item, source }: { item: CrowSourceItem; source: SourceDefinition },
      placement: ItemPlacement,
      storyId: number | null,
      by: string,
    ) => {
      const { story, created } = await this.store.attachToGameStory(
        item,
        storyId,
        placement,
        { url: item.url ?? item.key, publisher: source.publisher ?? source.name, official: source.official !== undefined },
        new Date(),
      );
      // Later entries of the run find it too
      const known = recent.find((r) => r.storyId === story.id);
      if (known) {
        known.headlines.push(item.title);
        if (item.url) known.urls.push(item.url);
      } else {
        recent.push({ storyId: story.id, title: story.title, headlines: [item.title], urls: item.url ? [item.url] : [] });
      }
      console.log(`${LOG_PREFIX} ${created ? 'New game story' : `Game story (${by})`} ${story.id} «${story.title}» ← ${source.id}`);
    };

    const matchOf = async (item: CrowSourceItem, vector: number[] | null) => {
      const scores = vector ? await this.store.gameStoryScores(vector, since) : [];
      return matchStory(
        { url: item.url, headline: item.title },
        recent.map((story) => ({ ...story, similarity: scores.find((s) => s.storyId === story.storyId)?.similarity ?? null })),
      );
    };

    for (const [i, entry] of placed.entries()) {
      const { item, verdict, source, categories } = entry;
      const placement: ItemPlacement = {
        topicKey: null,
        vendor: null,
        hero: verdict.game,
        title: verdict.title,
        categories,
        importance: clampImportance(verdict.importance),
        isRumor: verdict.isRumor,
        eventType: verdict.eventType,
        embedding: vectors[i],
      };
      if (source.structured) {
        await attach(entry, placement, null, 'new');
        continue;
      }
      const match = await matchOf(item, vectors[i]);
      if (match.kind === 'maybe') doubtful.push({ entry, placement, storyId: match.storyId });
      else await attach(entry, placement, match.kind === 'same' ? match.storyId : null, match.kind === 'same' ? match.by : 'new');
    }

    // An entry the sorting left out may still be another publisher's word on a news the others made relevant — one
    // batch's sorting is not another's — so one that is surely of a story counts for its publishers, and changes
    // nothing else of it; the rest is irrelevant
    const irrelevant: number[] = [];
    for (const [i, item] of unplaced.entries()) {
      const source = this.sourceById.get(item.sourceId);
      const match = source && !source.structured ? await matchOf(item, vectors[placed.length + i]) : { kind: 'new' as const };
      if (!source || match.kind !== 'same') {
        irrelevant.push(item.id);
        continue;
      }
      const coverage: ItemPlacement = {
        topicKey: null,
        vendor: null,
        hero: '',
        title: item.title,
        categories: [],
        importance: 1,
        isRumor: true,
        embedding: vectors[placed.length + i],
      };
      await attach({ item, source }, coverage, match.storyId, `coverage by ${match.by}`);
    }
    await this.store.markItems(irrelevant, 'irrelevant');
    if (doubtful.length === 0) return;

    const storyText = (storyId: number) => {
      const story = recent.find((r) => r.storyId === storyId);
      return story ? [story.title, ...story.headlines.slice(0, 4)].join(' | ') : '';
    };
    const { result: matched, costUsd: matchCost } = await this.llm.matchStories(
      doubtful.map(({ entry, storyId }, index) => ({
        index,
        entry: `${entry.item.title}. ${clip(entry.item.summary, MATCH_SUMMARY_MAX)}`,
        story: storyText(storyId),
      })),
    );
    pay(matchCost);
    for (const [index, { entry, placement, storyId }] of doubtful.entries()) {
      const same = matched.matches.find((m) => m.index === index)?.same === true;
      await attach(entry, placement, same ? storyId : null, 'the model');
    }
  }

  /** Writes the pending stories that are confirmed, and drops those nobody confirmed */
  private async promoteStories(pay: (costUsd: number) => void, canPay: () => boolean, spent: () => number) {
    for (const story of await this.store.pendingStories()) {
      const items = await this.store.storyItems(story.id);
      const now = new Date();
      const verdict = isGameStory(story.categories)
        ? await this.gameVerdict(story, items, now)
        : storyVerdict(
            story.createdAt,
            items.map((item) => ({
              sourceId: item.sourceId,
              official: this.isOfficial(story, item),
              aggregator: this.sourceById.get(item.sourceId)?.aggregator === true,
            })),
            now,
          );
      if (verdict === 'wait') continue;
      if (verdict === 'drop') {
        console.log(`${LOG_PREFIX} Story ${story.id} «${story.title}» dropped: nobody confirmed it`);
        await this.store.setStoryStatus(story.id, 'dropped');
        continue;
      }
      const chats = await this.store.subscribedChats(story.categories);
      if (chats.length === 0) {
        await this.store.setStoryStatus(story.id, 'dropped');
        continue;
      }
      if (!canPay()) {
        const day = budgetDay(new Date());
        if (this.budgetWarnedOn !== day) {
          this.budgetWarnedOn = day;
          console.warn(`${LOG_PREFIX} The daily budget is spent; stories wait for tomorrow`);
          await this.reportBudget(spent());
        }
        return;
      }
      try {
        await this.writeStory(story, items, chats, verdict === 'write-rumor', pay);
      } catch (e) {
        // An empty balance is not the story's fault: it waits for the money
        if (isQuotaError(e)) throw e;
        console.error(`${LOG_PREFIX} Story ${story.id} «${story.title}» could not be written:`, e);
        await this.store.setStoryStatus(story.id, 'failed');
      }
    }
  }

  /**
   * The rumors the vendor confirmed since they were told (docs/crow/behavior.md#i-told-you-so): an official
   * entry joined the story within its topic's 72 hours. The vendor's facts join the story's, and the crow
   * says UPD in the chats that heard the rumor. A story that cannot be confirmed is not tried again
   */
  private async confirmRumors(pay: (costUsd: number) => void, canPay: () => boolean) {
    for (const story of await this.store.unconfirmedRumors(new Date(Date.now() - TOPIC_WINDOW_MS))) {
      const official = (await this.store.storyItems(story.id)).filter((item) => this.isOfficial(story, item));
      if (official.length === 0) continue;
      if (!canPay()) return;
      try {
        await this.confirmRumor(story, official, pay);
      } catch (e) {
        if (isQuotaError(e)) throw e;
        console.error(`${LOG_PREFIX} Story ${story.id} «${story.title}»: the confirmed rumor could not be told:`, e);
        await this.store.confirmRumor(story.id, story.facts, null, new Date());
      }
    }
  }

  private async confirmRumor(story: CrowStory, official: CrowSourceItem[], pay: (costUsd: number) => void) {
    const { text: materials } = await this.materials(story, official);
    const factsReply = await this.llm.facts(story.title, materials, yearDateLabel(localDate(new Date(), 'UTC')));
    pay(factsReply.costUsd);
    const officialFacts: CrowFact[] = factsReply.result
      .slice(0, MAX_FACTS)
      .map((text, i) => ({ id: `F${story.facts.length + i + 1}`, text }));
    const request = {
      title: story.title,
      rumorFacts: story.facts,
      officialFacts,
      opening: await this.store.storyOpening(story.id),
      maxLength: MAX_RUMOR_UPDATE_LENGTH,
    };
    const allowed = allowedNumbers(story.title, request.opening, ...[...story.facts, ...officialFacts].map((fact) => fact.text));
    const written =
      officialFacts.length === 0
        ? null
        : await writeRumorUpdate((r) => this.priced(this.llm.rumorUpdate(r), pay), request, allowed);
    const now = new Date();
    const chats = await this.store.confirmRumor(
      story.id,
      [...story.facts, ...officialFacts],
      written?.text
        ? { text: written.text, importance: story.importance, expiresAt: new Date(now.getTime() + RUMOR_UPDATE_TTL_MS) }
        : null,
      now,
    );
    if (written && written.text === null) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: the UPD failed its checks:\n  ${written.attempts.at(-1)!.problems.join('\n  ')}`);
    }
    console.log(`${LOG_PREFIX} Story ${story.id} «${story.title}»: the rumor came true, UPD planned in ${chats} chats`);
  }

  /** Tells the owner what waits for money; a failure to tell is logged, the pipeline goes on */
  private async reportBudget(spentUsd: number) {
    if (!this.budget.onSpent) return;
    try {
      const pending = await this.store.pendingStories();
      await this.budget.onSpent({
        limitUsd: this.budget.limitUsd,
        spentUsd,
        waiting: pending.map((story) => ({ title: story.title, since: story.createdAt })),
        plannedPosts: await this.store.plannedPostCount(),
      });
    } catch (e) {
      console.error(`${LOG_PREFIX} Could not report the spent budget:`, e);
    }
  }

  /**
   * Whether the entry comes from the story's vendor itself rather than from a catalog or the press; for a game
   * news, from a platform's or a store's own channel, which is its own word on what it announces
   */
  private isOfficial(story: CrowStory, item: CrowSourceItem): boolean {
    const official = this.sourceById.get(item.sourceId)?.official;
    if (isGameStory(story.categories)) return official !== undefined;
    return story.vendor !== null && official === story.vendor;
  }

  /**
   * Whether a game story is written now, by its publishers (`gameStoryVerdict`): the importance they give it is
   * the story's from then on
   */
  private async gameVerdict(story: CrowStory, items: CrowSourceItem[], now: Date): Promise<StoryVerdict> {
    const { verdict, importance } = gameStoryVerdict(
      story.createdAt,
      items.map((item) => {
        const source = this.sourceById.get(item.sourceId);
        return {
          publisher: source?.publisher ?? source?.name ?? item.sourceId,
          official: source?.official !== undefined,
          structured: source?.structured === true,
          firstSeenAt: item.firstSeenAt,
        };
      }),
      publishersNeeded(story.categories),
      story.importance,
      now,
    );
    if (verdict === 'write' && importance !== story.importance) {
      await this.store.setStoryImportance(story.id, importance);
      story.importance = importance;
    }
    return verdict;
  }

  /** What the sources say of a story, official ones first, with the pages they link where readable */
  private async materials(story: CrowStory, items: CrowSourceItem[]) {
    const isOfficial = (item: CrowSourceItem) => this.isOfficial(story, item);
    // After the official ones, the entries with the most to read: a game news has a dozen of the press
    const ordered = [...items]
      .sort((a, b) => Number(isOfficial(b)) - Number(isOfficial(a)) || b.summary.length - a.summary.length)
      .slice(0, MATERIAL_SOURCES);
    let imageUrl = items.find((item) => item.imageUrl)?.imageUrl ?? null;
    const parts: string[] = [];
    for (const item of ordered) {
      const source = this.sourceById.get(item.sourceId);
      let text = item.summary;
      if (item.url && isOfficial(item) && !source?.selfContained) {
        const page = await readPage(item.url);
        if (page?.text) text = page.text;
        imageUrl = page?.image ?? imageUrl;
      }
      parts.push(
        [
          `Джерело: ${source?.name ?? item.sourceId}${isOfficial(item) ? ' (офіційне)' : ''}`,
          `Заголовок: ${item.title}`,
          item.url ? `URL: ${item.url}` : '',
          text,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return { text: clip(parts.join('\n\n---\n\n'), MATERIALS_MAX), imageUrl };
  }

  private async writeStory(
    story: CrowStory,
    items: CrowSourceItem[],
    chats: SubscribedChat[],
    isRumor: boolean,
    pay: (costUsd: number) => void,
  ) {
    // The arc is written for the chat that hears the most of it: an open flagship is a day of AI Enterprise
    // for one chat and a post or two of AI Homebrew for another
    const category = chats
      .map((chat) => cadenceCategory(story.categories, chat.subscriptions))
      .filter((c) => c !== undefined)
      .sort((a, b) => b.cadence.hardMax - a.cadence.hardMax)[0];
    if (!category) throw new Error(`no chat hears the categories ${story.categories}`);
    const { importance } = story;
    const rumor = isRumor || story.isRumor;
    const now = new Date();

    const { text: materials, imageUrl } = await this.materials(story, items);
    const factsReply = await this.llm.facts(story.title, materials, yearDateLabel(localDate(now, 'UTC')));
    pay(factsReply.costUsd);
    const facts: CrowFact[] = factsReply.result.slice(0, MAX_FACTS).map((text, i) => ({ id: `F${i + 1}`, text }));
    if (facts.length === 0) throw new Error('no facts in the sources');

    // The labs' models are the AI news' competitors; a game arc has none, and so no comparison
    const rosterEntries = isGameStory(story.categories) ? [] : await this.store.roster();
    const roster = rosterEntries.map((entry) => `${entry.provider}: ${entry.flagship}`);
    const { request, outline } = arcRequest(
      { title: story.title, category, importance, isRumor: rumor, facts },
      roster,
      {
        recentPosts: await this.store.recentOpenings(8),
        previousStances: await this.store.recentStances(story.categories, 5, now),
      },
      now,
    );
    const arc = await writeArc((r) => this.priced(this.llm.arc(r), pay), request, outline);
    const [first, last = first] = arc.attempts;
    if (arc.attempts.length > 1) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: rewrote the arc:\n  ${first.problems.join('\n  ')}`);
    }
    if (arc.failed) throw new Error(`the opening is invalid: ${last.problems.join('; ')}`);
    if (arc.dropped.length > 0) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: dropped after the rewrite:\n  ${last.problems.join('\n  ')}`);
    }

    // Each post's vector, of the facts it tells, so a talk about them finds it before its turn; a comparison has none
    const told = arc.messages.map((message) => postFacts(message.factIds, facts));
    const vectors = await embedOrNone(this.embed, told.filter(Boolean), 'document');
    let nextVector = 0;
    const postVectors = told.map((text) => (text ? vectors[nextVector++] : null));
    const saved = await this.store.completeStory(
      story.id,
      {
        facts,
        messages: arc.messages.map((message, i) => ({ ...message, embedding: postVectors[i] })),
        stance: arc.stance,
        imageUrl,
        isRumor: rumor,
        // A list is shown whole by the code, whatever the arc names of it
        games: items.find((item) => item.games && item.games.length > 0)?.games ?? null,
      },
      now,
    );
    if (imageUrl) {
      await saveStoryImage(imageUrl, story.id).catch((e) =>
        console.warn(`${LOG_PREFIX} Story ${story.id}: no picture from ${imageUrl}:`, e),
      );
    }
    await this.storeSnippets(story, facts, materials, pay);
    const bet = rumor ? null : await this.proposeBet(story, facts, now, pay);
    // A quiz for the long arcs of a mega story, on what every chat hears first: its opening
    const quiz =
      importance === 3 && !rumor ? await this.proposeQuiz(story, category, facts.filter((f) => saved[0].factIds.includes(f.id)), now, pay) : null;
    const deadline = await this.storyDeadline(story, items, category, facts, now, pay);
    // Only the lab's own word: OpenRouter's reasoning mode of GPT-6 Luna, sorted as a new flagship, once
    // took the place of all of OpenAI's models
    if (
      story.categories.includes('ai-enterprise') &&
      importance === 3 &&
      !rumor &&
      story.vendor &&
      story.hero &&
      items.some((item) => this.isOfficial(story, item))
    ) {
      const vendor = story.vendor;
      const entry = mergeRoster(rosterEntries.find((e) => e.provider === vendor)?.flagship ?? null, story.hero);
      if (entry) {
        await this.store.updateRoster(vendor, entry, now.toISOString().slice(0, 10));
        console.log(`${LOG_PREFIX} Roster of ${vendor}: ${entry}`);
      }
    }

    let planned = 0;
    let jabbed = 0;
    let bets = 0;
    for (const chat of await this.store.subscribedChats(story.categories)) {
      const cadence = cadenceCategory(story.categories, chat.subscriptions);
      if (!cadence) continue;
      let posts = planArc(saved, cadence.cadence, importance, chat.boldness, now, this.random);
      if (chat.personalJabs && posts.length >= JAB_MIN_POSTS) {
        const jabs = await this.chatJabs(chat, story, category, facts, saved[0].text, now, pay);
        posts = withJabs(posts, jabs, this.random);
        jabbed += jabs.length;
      }
      // One bet going at a time in a chat, two a week at most
      if (bet) {
        const limits = await this.store.betLimits(chat.chatId, now);
        if (!limits.open && limits.lastWeek < BETS_PER_WEEK) {
          posts = withBet(posts, bet, this.random);
          bets++;
        }
      }
      if (quiz) posts = withQuiz(posts, quiz.question, this.random);
      await this.store.planPosts(chat.chatId, story.id, posts);
      // The reminder of the story's moment comes apart from the chain, at its own time
      const window = deadline?.text ? reminderWindow(deadline, now) : null;
      if (deadline?.text && window) {
        await this.store.planDue(chat.chatId, story.id, { ...reminderPost(deadline.text, deadline), importance, ...window });
      }
      planned++;
    }
    console.log(
      `${LOG_PREFIX} Story ${story.id} «${story.title}» written: ${saved.length} messages, planned in ${planned} chats` +
        (jabbed > 0 ? `, ${jabbed} jabs` : '') +
        (bets > 0 ? `, a bet in ${bets}` : ''),
    );
  }

  /**
   * A bet on the story's dated event (docs/crow/behavior.md#bets), kept with the story for the chats that
   * hear it, or none. A rumor gets none: it may never happen at all. A failure costs the story its bet — an
   * empty balance too: the arc is saved by then, and the chats must still get it
   */
  private async proposeBet(story: CrowStory, facts: CrowFact[], now: Date, pay: (costUsd: number) => void) {
    try {
      // The bot's day: a story is shared by chats of every zone, and a bet is days ahead
      const today = localDate(now, 'UTC');
      const written = await writeBet(
        (request) => this.priced(this.llm.bet(request), pay),
        { title: story.title, facts, today: yearDateLabel(today), minDays: MIN_BET_DAYS, maxDays: MAX_BET_DAYS },
        facts,
        today,
      );
      if (!written.bet) {
        const problems = written.attempts.at(-1)?.problems ?? [];
        if (problems.length > 0) {
          console.warn(`${LOG_PREFIX} Story ${story.id}: no bet, it failed its checks:\n  ${problems.join('\n  ')}`);
        }
        return null;
      }
      await this.store.saveBet(story.id, written.bet);
      console.log(`${LOG_PREFIX} Story ${story.id}: a bet on ${written.bet.resolvesOn} — ${written.bet.question}`);
      return written.bet;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: no bet:`, e);
      return null;
    }
  }

  /**
   * A quiz on the facts of the story's opening, kept with the story for the chats whose chains are long enough.
   * A failure costs the story its quiz, never the arc
   */
  private async proposeQuiz(story: CrowStory, category: Category, facts: CrowFact[], now: Date, pay: (costUsd: number) => void) {
    if (facts.length === 0) return null;
    try {
      const written = await writeQuiz(
        (request) => this.priced(this.llm.quiz(request), pay),
        { title: story.title, categoryName: categoryLabel(category, now), facts },
        allowedNumbers(story.title, ...facts.map((fact) => fact.text)),
      );
      if (!written.quiz) {
        const problems = written.attempts.at(-1)?.problems ?? [];
        console.log(`${LOG_PREFIX} Story ${story.id}: no quiz` + (problems.length > 0 ? `, it failed its checks:\n  ${problems.join('\n  ')}` : ''));
        return null;
      }
      await this.store.saveQuiz(story.id, written.quiz);
      console.log(`${LOG_PREFIX} Story ${story.id}: a quiz — ${written.quiz.question}`);
      return written.quiz;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: no quiz:`, e);
      return null;
    }
  }

  /**
   * The moment the story's games come or go, as the store's own list or the platform's post states it, with the
   * crow's reminder of it for every chat. A reminder that cannot be written costs the story its reminder only
   */
  private async storyDeadline(
    story: CrowStory,
    items: CrowSourceItem[],
    category: Category,
    facts: CrowFact[],
    now: Date,
    pay: (costUsd: number) => void,
  ): Promise<CrowDeadline | null> {
    const found = items.find((item) => item.deadline)?.deadline;
    if (!found || !reminderWindow(found, now)) return null;
    try {
      const written = await writeReminder(
        (request) => this.priced(this.llm.reminder(request), pay),
        { title: story.title, categoryName: categoryLabel(category, now), facts, kind: found.kind, maxLength: MAX_REMINDER_LENGTH },
        allowedNumbers(story.title, ...facts.map((fact) => fact.text)),
      );
      if (!written.text) {
        console.warn(`${LOG_PREFIX} Story ${story.id}: no reminder, it failed its checks:\n  ${written.attempts.at(-1)!.problems.join('\n  ')}`);
        return null;
      }
      const deadline: CrowDeadline = { ...found, text: written.text };
      await this.store.saveDeadline(story.id, deadline);
      console.log(`${LOG_PREFIX} Story ${story.id}: a reminder at ${found.remindAt} — ${written.text}`);
      return deadline;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: no reminder:`, e);
      return null;
    }
  }

  /**
   * The crow's store for talks about the story: details of the sources the arc did not tell, and the aliases a
   * talk about it is heard by. A failure costs the story its store, not the story; its hero's name still names it
   */
  private async storeSnippets(story: CrowStory, facts: CrowFact[], materials: string, pay: (costUsd: number) => void) {
    try {
      const { result, costUsd } = await this.llm.snippets(story.title, facts, materials);
      pay(costUsd);
      const { details, aliases } = cleanSnippets(result, story.hero);
      await this.store.saveSnippets(story.id, details, aliases, await embedOrNone(this.embed, details, 'document'));
      console.log(`${LOG_PREFIX} Story ${story.id}: ${details.length} details and ${aliases.length} aliases for talks`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: no store for talks:`, e);
      await this.store
        .saveSnippets(story.id, [], storyAliases([], story.hero))
        .catch((e2) => console.warn(`${LOG_PREFIX} Story ${story.id}: no aliases either:`, e2));
    }
  }

  /**
   * A chat's jabs at its cats. A failure costs the chat its jabs, not the story — an empty balance too: the
   * arc is saved by then, and the other chats must still get it
   */
  private async chatJabs(
    chat: SubscribedChat,
    story: CrowStory,
    category: Category,
    facts: CrowFact[],
    opening: string,
    now: Date,
    pay: (costUsd: number) => void,
  ): Promise<PlannedJab[]> {
    if (!this.jabWriter) return [];
    try {
      const { jabs, costUsd } = await this.jabWriter.jabs(
        chat.chatId,
        chat.boldness,
        { title: story.title, categoryName: categoryLabel(category, now), facts, opening },
        now,
      );
      pay(costUsd);
      return jabs;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Story ${story.id}: no jabs for chat ${getLinkChatId(Number(chat.chatId))}:`, e);
      return [];
    }
  }

  private async priced<T>(call: Promise<{ result: T; costUsd: number }>, pay: (costUsd: number) => void) {
    const reply = await call;
    pay(reply.costUsd);
    return reply;
  }
}
