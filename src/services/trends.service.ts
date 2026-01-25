import { DataSource, LessThan, Between, Repository } from 'typeorm';
import { ChatMessage, TrendsSummary } from '../entity/index.js';
import { OpenAIService, SummarizationResult } from './openai.service.js';

const BASE_PERIOD_HOURS = 3;
const MAX_RETENTION_HOURS = 30 * 24; // 30 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface StoreMessageParams {
  chatId: number;
  messageId: number;
  userId: number;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  textContent: string;
  hasPhoto?: boolean;
  hasVideo?: boolean;
  mediaDescription?: string | null;
}

interface SaveCacheParams {
  chatId: string;
  periodStart: Date;
  periodEnd: Date;
  periodHours: number;
  summary: string;
  resultJson: SummarizationResult | null;
}

export class TrendsService {
  private static instance: TrendsService;
  private static readonly LOG_PREFIX = '[Trends]';
  private openaiService = OpenAIService.getInstance();
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  private constructor(private dataSource: DataSource) {}

  public static getInstance(dataSource: DataSource): TrendsService {
    if (!TrendsService.instance) {
      TrendsService.instance = new TrendsService(dataSource);
    }
    return TrendsService.instance;
  }

  // Repository getters
  private get chatMessageRepo(): Repository<ChatMessage> {
    return this.dataSource.getRepository(ChatMessage);
  }

  private get trendsSummaryRepo(): Repository<TrendsSummary> {
    return this.dataSource.getRepository(TrendsSummary);
  }

  // Utility methods
  private alignToBlockBoundary(date: Date): Date {
    const aligned = new Date(date);
    aligned.setMinutes(0, 0, 0);
    const hour = aligned.getHours();
    aligned.setHours(hour - (hour % BASE_PERIOD_HOURS));
    return aligned;
  }

  private async getCachedOrInvalidate(
    chatId: string,
    periodStart: Date,
    periodHours: number,
  ): Promise<TrendsSummary | null> {
    const cached = await this.trendsSummaryRepo.findOne({
      where: { chatId, periodStart, periodHours },
    });

    if (!cached) {
      return null;
    }

    const newMessagesCount = await this.chatMessageRepo.count({
      where: {
        chatId,
        createdAt: Between(cached.createdAt, new Date()),
      },
    });

    if (newMessagesCount === 0) {
      console.log(`${TrendsService.LOG_PREFIX} ✅ Cache hit`);
      return cached;
    }

    console.log(`${TrendsService.LOG_PREFIX} Cache stale (${newMessagesCount} new messages), invalidating`);
    await this.trendsSummaryRepo.delete({ id: cached.id });
    return null;
  }

  private async saveSummaryCache(params: SaveCacheParams): Promise<TrendsSummary> {
    const summary = new TrendsSummary();
    summary.chatId = params.chatId;
    summary.periodStart = params.periodStart;
    summary.periodEnd = params.periodEnd;
    summary.periodHours = params.periodHours;
    summary.summary = params.summary;
    summary.resultJson = params.resultJson;
    return this.trendsSummaryRepo.save(summary);
  }

  // Public API
  async getTrendsSummary(chatId: number, hours: number): Promise<SummarizationResult | string> {
    if (hours <= BASE_PERIOD_HOURS) {
      return this.generateDirectSummary(chatId, hours);
    }
    return this.getAggregatedSummary(chatId, hours);
  }

  private async generateDirectSummary(chatId: number, hours: number): Promise<SummarizationResult | string> {
    const now = new Date();
    const periodStart = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const alignedStart = this.alignToBlockBoundary(periodStart);

    // Check cache
    const cached = await this.getCachedOrInvalidate(String(chatId), alignedStart, BASE_PERIOD_HOURS);
    if (cached) {
      return cached.resultJson ?? cached.summary;
    }

    // Fetch messages
    const messages = await this.chatMessageRepo.find({
      where: {
        chatId: String(chatId),
        createdAt: Between(periodStart, now),
      },
      order: { createdAt: 'ASC' },
    });

    if (messages.length === 0) {
      return 'За цей період повідомлень не знайдено';
    }

    // Generate summary
    console.log(`${TrendsService.LOG_PREFIX} Calling OpenAI for ${messages.length} messages`);
    const result = await this.openaiService.summarizeMessages(messages);

    // Cache result
    const blockEnd = new Date(alignedStart.getTime() + BASE_PERIOD_HOURS * 60 * 60 * 1000);
    await this.saveSummaryCache({
      chatId: String(chatId),
      periodStart: alignedStart,
      periodEnd: blockEnd > now ? now : blockEnd,
      periodHours: BASE_PERIOD_HOURS,
      summary: result.fullSummary,
      resultJson: result,
    });

    return result;
  }

  private async getAggregatedSummary(chatId: number, hours: number): Promise<SummarizationResult | string> {
    const now = new Date();
    const periodStart = new Date(now.getTime() - hours * 60 * 60 * 1000);

    // Calculate 3-hour blocks
    const blocks = this.calculateBlocks(periodStart, now);
    if (blocks.length === 0) {
      return 'За цей період повідомлень не знайдено';
    }

    const aggregatedPeriodStart = blocks[0].start;

    // Check aggregated cache
    const cachedAggregated = await this.getCachedOrInvalidate(String(chatId), aggregatedPeriodStart, hours);
    if (cachedAggregated) {
      return cachedAggregated.resultJson ?? cachedAggregated.summary;
    }

    // Process each block
    const { summaries, blockResults } = await this.processBlocks(chatId, blocks);

    if (summaries.length === 0) {
      return 'За цей період повідомлень не знайдено';
    }

    // Single block - cache and return directly
    if (summaries.length === 1) {
      await this.saveSummaryCache({
        chatId: String(chatId),
        periodStart: aggregatedPeriodStart,
        periodEnd: blocks[blocks.length - 1].end,
        periodHours: hours,
        summary: summaries[0],
        resultJson: blockResults[0],
      });
      return blockResults[0] ?? summaries[0];
    }

    // Aggregate multiple summaries
    console.log(`${TrendsService.LOG_PREFIX} Aggregating ${summaries.length} summaries`);
    const aggregatedText = await this.openaiService.aggregateSummaries(summaries);

    await this.saveSummaryCache({
      chatId: String(chatId),
      periodStart: aggregatedPeriodStart,
      periodEnd: blocks[blocks.length - 1].end,
      periodHours: hours,
      summary: aggregatedText,
      resultJson: null,
    });

    return aggregatedText;
  }

  private calculateBlocks(periodStart: Date, now: Date): Array<{ start: Date; end: Date }> {
    const blocks: Array<{ start: Date; end: Date }> = [];
    let blockStart = this.alignToBlockBoundary(periodStart);

    while (blockStart < now) {
      const blockEnd = new Date(blockStart.getTime() + BASE_PERIOD_HOURS * 60 * 60 * 1000);
      if (blockEnd > periodStart) {
        blocks.push({
          start: new Date(blockStart),
          end: blockEnd > now ? now : blockEnd,
        });
      }
      blockStart = blockEnd;
    }

    return blocks;
  }

  private async processBlocks(
    chatId: number,
    blocks: Array<{ start: Date; end: Date }>,
  ): Promise<{ summaries: string[]; blockResults: (SummarizationResult | null)[] }> {
    const summaries: string[] = [];
    const blockResults: (SummarizationResult | null)[] = [];

    for (const block of blocks) {
      // Check block cache (without invalidation - blocks are immutable once passed)
      const cached = await this.trendsSummaryRepo.findOne({
        where: {
          chatId: String(chatId),
          periodStart: block.start,
          periodHours: BASE_PERIOD_HOURS,
        },
      });

      if (cached) {
        summaries.push(cached.summary);
        blockResults.push(cached.resultJson);
        continue;
      }

      // Fetch messages for block
      const messages = await this.chatMessageRepo.find({
        where: {
          chatId: String(chatId),
          createdAt: Between(block.start, block.end),
        },
        order: { createdAt: 'ASC' },
      });

      if (messages.length === 0) {
        continue;
      }

      // Generate and cache block summary
      console.log(`${TrendsService.LOG_PREFIX} Calling OpenAI for block (${messages.length} messages)`);
      const result = await this.openaiService.summarizeMessages(messages);

      await this.saveSummaryCache({
        chatId: String(chatId),
        periodStart: block.start,
        periodEnd: block.end,
        periodHours: BASE_PERIOD_HOURS,
        summary: result.fullSummary,
        resultJson: result,
      });

      summaries.push(result.fullSummary);
      blockResults.push(result);
    }

    return { summaries, blockResults };
  }

  async storeMessage(params: StoreMessageParams): Promise<void> {
    const chatMessage = new ChatMessage();
    chatMessage.chatId = String(params.chatId);
    chatMessage.messageId = String(params.messageId);
    chatMessage.userId = String(params.userId);
    chatMessage.userName = params.userName;
    chatMessage.userFirstName = params.userFirstName;
    chatMessage.userLastName = params.userLastName;
    chatMessage.textContent = params.textContent;
    chatMessage.hasPhoto = params.hasPhoto ?? false;
    chatMessage.hasVideo = params.hasVideo ?? false;
    chatMessage.mediaDescription = params.mediaDescription ?? null;

    await this.chatMessageRepo.save(chatMessage);
  }

  startCleanupJob(): void {
    if (this.cleanupIntervalId) return;

    this.cleanupIntervalId = setInterval(() => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);

    console.log(`${TrendsService.LOG_PREFIX} Starting cleanup job`);
  }

  stopCleanupJob(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      console.log(`${TrendsService.LOG_PREFIX} Cleanup job stopped`);
    }
  }

  private async cleanup(): Promise<void> {
    const cutoffDate = new Date(Date.now() - MAX_RETENTION_HOURS * 60 * 60 * 1000);

    try {
      const msgResult = await this.chatMessageRepo.delete({ createdAt: LessThan(cutoffDate) });
      const summaryResult = await this.trendsSummaryRepo.delete({ periodEnd: LessThan(cutoffDate) });
      console.log(
        `${TrendsService.LOG_PREFIX} Cleanup: ${msgResult.affected} messages, ${summaryResult.affected} summaries`,
      );
    } catch (error) {
      console.error(`${TrendsService.LOG_PREFIX} Cleanup error:`, error);
    }
  }
}
