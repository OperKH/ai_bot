import { InlineKeyboard } from 'grammy';
import { Command } from './command.class.js';
import { downloadUpdateFile } from '../telegramFiles.js';
import { TrendsService } from '../../services/trends.service.js';
import { OpenAIService } from '../../services/openai.service.js';
import { getLinkChatId } from '../telegramLinks.js';
import { escapeMarkdown, formatSummary, splitMessage } from './trendsMessage.js';

const PERIOD_LABELS: Record<number, string> = {
  3: '3 години',
  6: '6 годин',
  12: '12 годин',
  24: '24 години',
  48: '2 дні',
  72: '3 дні',
};

export class TrendsCommand extends Command {
  public command = 'trends';
  public description = '📊 Показати тренди чату';
  private trendsService!: TrendsService;
  private openaiService = OpenAIService.getInstance();

  handle(): void {
    this.trendsService = TrendsService.getInstance(this.dataSource);
    this.trendsService.startCleanupJob();

    // Message listeners that call next() for non-blocking storage
    this.bot.on('message:text', async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.msg.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const textContent = ctx.msg.text;

      // Don't store command messages
      if (!textContent.startsWith('/')) {
        try {
          await this.trendsService.storeMessage({
            chatId,
            messageId,
            userId,
            userName,
            userFirstName,
            userLastName,
            textContent,
          });
        } catch (e) {
          console.error('Error storing text message:', e);
        }
      }

      return next();
    });

    this.bot.on('message:photo', async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.msg.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const caption = ctx.msg.caption || '';

      try {
        // Try to get image description
        let mediaDescription: string | null = null;
        try {
          const fileId = ctx.msg.photo.at(-1)?.file_id;
          if (fileId) {
            const image = await downloadUpdateFile(this.bot.api, ctx.update, fileId);
            console.log(`[Trends] Describing image with OpenAI for chat ${getLinkChatId(chatId)}`);
            // Sent as data, not as a link: a Telegram file link carries the bot
            // token, and the request is kept in OpenAI's and Langfuse's logs.
            // Telegram re-encodes every photo as JPEG.
            mediaDescription = await this.openaiService.describeImage(
              `data:image/jpeg;base64,${image.toString('base64')}`,
            );
          }
        } catch (e) {
          console.error('Error getting image description:', e);
        }

        await this.trendsService.storeMessage({
          chatId,
          messageId,
          userId,
          userName,
          userFirstName,
          userLastName,
          textContent: caption,
          hasPhoto: true,
          mediaDescription,
        });
      } catch (e) {
        console.error('Error storing photo message:', e);
      }

      return next();
    });

    this.bot.on('message:video', async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.msg.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const caption = ctx.msg.caption || '';

      try {
        await this.trendsService.storeMessage({
          chatId,
          messageId,
          userId,
          userName,
          userFirstName,
          userLastName,
          textContent: caption,
          hasVideo: true,
        });
      } catch (e) {
        console.error('Error storing video message:', e);
      }

      return next();
    });

    // /trends command handler
    this.bot.command(this.command, async (ctx) => {
      const inlineKeyboard = new InlineKeyboard()
        .text('3г', 'trends-3')
        .text('6г', 'trends-6')
        .text('12г', 'trends-12')
        .row()
        .text('24г', 'trends-24')
        .text('2д', 'trends-48')
        .text('3д', 'trends-72');

      await ctx.reply('📊 Обери період для аналізу трендів:', {
        reply_parameters: { message_id: ctx.msg.message_id },
        reply_markup: inlineKeyboard,
      });
    });

    // Callback handler for period selection
    this.bot.callbackQuery(/^trends-(\d+)$/, async (ctx) => {
      const hours = parseInt(ctx.match[1], 10);
      const periodLabel = PERIOD_LABELS[hours] || `${hours} годин`;
      const chatId = ctx.chat?.id;

      if (!chatId) {
        await ctx.answerCallbackQuery('❌ Помилка: чат не знайдено');
        return;
      }

      // Answer callback query immediately
      await ctx.answerCallbackQuery();

      // Edit original message to show loading state
      await ctx.editMessageText(`📊 Обрано період: ${periodLabel}\n\n🦙 Аналізую...`);

      console.log(`[Trends] Starting analysis for chat ${getLinkChatId(chatId)}, period: ${periodLabel} (${hours}h)`);

      try {
        console.log(`[Trends] Calling getTrendsSummary for chat ${getLinkChatId(chatId)}, hours: ${hours}`);
        const result = await this.trendsService.getTrendsSummary(chatId, hours);

        // Remove loading indicator
        await ctx.editMessageText(`📊 Обрано період: ${periodLabel}`);

        let responseText: string;
        if (typeof result === 'string') {
          responseText = `📊 *Тренди за останні ${escapeMarkdown(periodLabel)}*\n\n${escapeMarkdown(result)}`;
        } else {
          responseText = formatSummary(result, periodLabel, chatId);
        }

        // No pause between chunks: the API client paces sends to Telegram's limits
        for (const chunk of splitMessage(responseText)) {
          await ctx.api.sendMessage(chatId, chunk, {
            parse_mode: 'MarkdownV2',
          });
        }
      } catch (e) {
        console.error('Error generating trends:', e);
        await ctx.reply('❌ Помилка при аналізі, спробуйте пізніше');
      }
    });
  }

  async dispose(): Promise<void> {
    this.trendsService?.stopCleanupJob();
  }
}
