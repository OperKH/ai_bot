import { InlineKeyboard } from 'grammy';
import { Command } from './command.class.js';
import { downloadUpdateFile } from '../telegramFiles.js';
import { TrendsService } from '../../services/trends.service.js';
import { OpenAIService } from '../../services/openai.service.js';
import { getLinkChatId } from '../telegramLinks.js';
import { trendsRichMessage } from './trendsMessage.js';
import { BackgroundQueue } from '../backgroundQueue.js';
import type { BotContext } from '../context/context.interface.js';

/** The periods to choose from, with the label on the button and the one in the report */
const PERIODS = [
  { hours: 3, button: '3г', label: '3 години' },
  { hours: 6, button: '6г', label: '6 годин' },
  { hours: 12, button: '12г', label: '12 годин' },
  { hours: 24, button: '24г', label: '24 години' },
  { hours: 48, button: '2д', label: '2 дні' },
  { hours: 72, button: '3д', label: '3 дні' },
];

/** Telegram keeps a message's buttons through an edit that does not replace them */
const NO_BUTTONS = { reply_markup: { inline_keyboard: [] } };

const periodKeyboard = () =>
  InlineKeyboard.from(
    [PERIODS.slice(0, 3), PERIODS.slice(3)].map((row) =>
      row.map((p) => InlineKeyboard.text(p.button, `trends-${p.hours}`)),
    ),
  );

export class TrendsCommand extends Command {
  public command = 'trends';
  public description = '📊 Показати тренди чату';
  private trendsService!: TrendsService;
  private openaiService = OpenAIService.getInstance();
  /** The analyses take the LLM tens of seconds, so they run apart from the update queue */
  private readonly analyses = new BackgroundQueue('Trends analysis');

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
      await ctx.reply('📊 Обери період для аналізу трендів:', {
        reply_parameters: { message_id: ctx.msg.message_id },
        reply_markup: periodKeyboard(),
      });
    });

    // Callback handler for period selection
    this.bot.callbackQuery(/^trends-(\d+)$/, async (ctx) => {
      const period = PERIODS.find((p) => p.hours === Number(ctx.match[1]));
      const chatId = ctx.chat?.id;
      if (!period || !chatId) {
        await ctx.answerCallbackQuery('❌ Помилка: кнопка застаріла');
        return;
      }
      const { hours, label: periodLabel } = period;
      await ctx.answerCallbackQuery();

      // The period picker becomes the report: first the loading state, then the summary itself
      await ctx.editMessageText(`📊 Обрано період: ${periodLabel}\n\n🦙 Аналізую...`, NO_BUTTONS);
      this.analyses.push(() => this.showTrends(ctx, chatId, hours, periodLabel), {
        onSkip: () => this.offerPeriods(ctx, '📛 Не встиг проаналізувати: бот перезапускається. Обери період ще раз:'),
        onError: async (e) => {
          console.error('Error generating trends:', e);
          await this.offerPeriods(ctx, '❌ Помилка при аналізі, спробуй ще раз:');
        },
      });
    });
  }

  private async showTrends(ctx: BotContext, chatId: number, hours: number, periodLabel: string) {
    console.log(`[Trends] Starting analysis for chat ${getLinkChatId(chatId)}, period: ${periodLabel} (${hours}h)`);
    const result = await this.trendsService.getTrendsSummary(chatId, hours);
    if (result) {
      await ctx.editMessageText(trendsRichMessage(result, periodLabel, chatId), NO_BUTTONS);
    } else {
      await this.offerPeriods(ctx, `🤷 За ${periodLabel} повідомлень не знайдено. Обери інший період:`);
    }
  }

  /** Turns the message back into the period picker, with `text` over the buttons */
  private async offerPeriods(ctx: BotContext, text: string) {
    await ctx.editMessageText(text, { reply_markup: periodKeyboard() });
  }

  /** Lets the analysis in progress finish; the queued ones get the periods offered again */
  async dispose(): Promise<void> {
    this.trendsService?.stopCleanupJob();
    await this.analyses.close();
  }
}
