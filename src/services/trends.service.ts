import { DataSource, LessThan, Between, Repository } from 'typeorm';
import { ChatMessage, TrendsSummary } from '../entity/index.js';
import { OpenAIService, SummarizationResult } from './openai.service.js';

const BASE_PERIOD_HOURS = 3;
const MAX_RETENTION_HOURS = 30 * 24; // 30 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const MAX_MESSAGES_PER_REQUEST = 1000;

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
    const alignedStart = this.alignToBlockBoundary(periodStart);

    // Check cache
    const cached = await this.getCachedOrInvalidate(String(chatId), alignedStart, hours);
    if (cached) {
      return cached.resultJson ?? cached.summary;
    }

    // Fetch all messages for the period
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

    let result: SummarizationResult;

    if (messages.length <= MAX_MESSAGES_PER_REQUEST) {
      // Single request for all messages
      console.log(`${TrendsService.LOG_PREFIX} Calling OpenAI for ${messages.length} messages`);
      result = await this.openaiService.summarizeMessages(messages);
    } else {
      // Split into batches and aggregate
      const batches: ChatMessage[][] = [];
      for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
        batches.push(messages.slice(i, i + MAX_MESSAGES_PER_REQUEST));
      }

      console.log(`${TrendsService.LOG_PREFIX} Processing ${messages.length} messages in ${batches.length} batches`);

      const batchResults: SummarizationResult[] = [];
      for (const batch of batches) {
        console.log(`${TrendsService.LOG_PREFIX} Calling OpenAI for batch (${batch.length} messages)`);
        const batchResult = await this.openaiService.summarizeMessages(batch);
        batchResults.push(batchResult);
      }

      console.log(`${TrendsService.LOG_PREFIX} Aggregating ${batchResults.length} batch results`);
      result = await this.openaiService.aggregateSummarizationResults(batchResults);
    }

    // Cache result
    await this.saveSummaryCache({
      chatId: String(chatId),
      periodStart: alignedStart,
      periodEnd: now,
      periodHours: hours,
      summary: result.fullSummary,
      resultJson: result,
    });

    return result;
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

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.cleanup();
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
