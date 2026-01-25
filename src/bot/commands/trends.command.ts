import { message } from 'telegraf/filters';
import { Command } from './command.class.js';
import { TrendsService } from '../../services/trends.service.js';
import { OpenAIService, SummarizationResult } from '../../services/openai.service.js';
import { getLinkChatId } from '../../utils/telegram.utils.js';

const PERIOD_LABELS: Record<number, string> = {
  3: '3 години',
  6: '6 годин',
  12: '12 годин',
  24: '24 години',
  48: '2 дні',
  72: '3 дні',
};

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function formatMessageLinks(chatId: number, messageIds: string[]): string {
  if (!messageIds || messageIds.length === 0) return '';
  const linkChatId = getLinkChatId(chatId);
  const links = messageIds
    .slice(0, 3)
    .map((messageId) => `[\\#](https://t.me/c/${linkChatId}/${messageId})`)
    .join(' ');
  return ` ${links}`;
}

function formatSummary(result: SummarizationResult, periodLabel: string, chatId: number): string {
  const lines: string[] = [
    `📊 *Тренди за останні ${escapeMarkdown(periodLabel)}*`,
    '',
    '*🔥 Топ учасників:*',
    ...result.topParticipants.map(
      (p, i) =>
        `${i + 1}\\. *${escapeMarkdown(p.name)}* \\(@${escapeMarkdown(p.nickName)}\\) — ${p.messageCount} повідомлень` +
        (p.summary ? `\n   _${escapeMarkdown(p.summary)}_` : ''),
    ),
  ];

  if (result.participantSummaries && result.participantSummaries.length > 0) {
    lines.push(
      '',
      '*👥 Інтереси учасників:*',
      ...result.participantSummaries.map(
        (p) =>
          `• *${escapeMarkdown(p.name)}* \\(@${escapeMarkdown(p.nickName)}\\): ${p.interests.map((i) => escapeMarkdown(i)).join(', ')}`,
      ),
    );
  }

  lines.push(
    '',
    '*💬 Основні теми:*',
    ...result.topics.map((t) => `• ${escapeMarkdown(t.topic)}${formatMessageLinks(chatId, t.messageIds)}`),
  );

  if (result.trends && result.trends.length > 0) {
    lines.push(
      '',
      '*📈 Тренди:*',
      ...result.trends.map((t) => `• ${escapeMarkdown(t.trend)}${formatMessageLinks(chatId, t.messageIds)}`),
    );
  }

  if (result.gaming) {
    lines.push(
      '',
      '*🎮 Ігрова тематика:*',
      `${escapeMarkdown(result.gaming.summary)}${formatMessageLinks(chatId, result.gaming.messageIds)}`,
    );
  }

  if (result.memes) {
    lines.push(
      '',
      '*😂 Мем\\-тренди:*',
      `${escapeMarkdown(result.memes.summary)}${formatMessageLinks(chatId, result.memes.messageIds)}`,
    );
  }

  if (result.events && result.events.length > 0) {
    lines.push(
      '',
      '*📅 Заплановані події:*',
      ...result.events.map((e) => `• ${escapeMarkdown(e.event)}${formatMessageLinks(chatId, e.messageIds)}`),
    );
  }

  if (result.fullSummary) {
    lines.push('', '*📝 Загальний підсумок:*', escapeMarkdown(result.fullSummary));
  }

  return lines.join('\n');
}

export class TrendsCommand extends Command {
  public command = 'trends';
  public description = '📊 Показати тренди чату';
  private trendsService!: TrendsService;
  private openaiService = OpenAIService.getInstance();

  handle(): void {
    this.trendsService = TrendsService.getInstance(this.dataSource);
    this.trendsService.startCleanupJob();

    // Message listeners that call next() for non-blocking storage
    this.bot.on(message('text'), async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const textContent = ctx.message.text;

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

    this.bot.on(message('photo'), async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const caption = ctx.message.caption || '';

      try {
        // Try to get image description
        let mediaDescription: string | null = null;
        try {
          const fileId = ctx.message.photo.at(-1)?.file_id;
          if (fileId) {
            const fileUrl = await this.bot.telegram.getFileLink(fileId);
            console.log(`[Trends] Describing image with OpenAI for chat ${getLinkChatId(chatId)}`);
            mediaDescription = await this.openaiService.describeImage(fileUrl.href);
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

    this.bot.on(message('video'), async (ctx, next) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;
      const userId = ctx.from.id;
      const userName = ctx.from.username || null;
      const userFirstName = ctx.from.first_name || null;
      const userLastName = ctx.from.last_name || null;
      const caption = ctx.message.caption || '';

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
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '3г', callback_data: 'trends-3' },
            { text: '6г', callback_data: 'trends-6' },
            { text: '12г', callback_data: 'trends-12' },
          ],
          [
            { text: '24г', callback_data: 'trends-24' },
            { text: '2д', callback_data: 'trends-48' },
            { text: '3д', callback_data: 'trends-72' },
          ],
        ],
      };

      await ctx.reply('📊 Обери період для аналізу трендів:', {
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: inlineKeyboard,
      });
    });

    // Callback handler for period selection
    this.bot.action(/^trends-(\d+)$/, async (ctx) => {
      const hours = parseInt(ctx.match[1], 10);
      const periodLabel = PERIOD_LABELS[hours] || `${hours} годин`;
      const chatId = ctx.chat?.id;

      if (!chatId) {
        await ctx.answerCbQuery('❌ Помилка: чат не знайдено');
        return;
      }

      // Answer callback query immediately
      await ctx.answerCbQuery();

      // Edit original message to remove keyboard
      await ctx.editMessageText(`📊 Обрано період: ${periodLabel}`);

      // Send loading indicator
      const loadingMsg = await ctx.reply('🦙');

      console.log(
        `[Trends] Starting analysis for chat ${getLinkChatId(chatId)}, period: ${periodLabel} (${hours}h)`,
      );

      try {
        console.log(`[Trends] Calling getTrendsSummary for chat ${getLinkChatId(chatId)}, hours: ${hours}`);
        const result = await this.trendsService.getTrendsSummary(chatId, hours);

        let responseText: string;
        if (typeof result === 'string') {
          responseText = `📊 *Тренди за останні ${escapeMarkdown(periodLabel)}*\n\n${escapeMarkdown(result)}`;
        } else {
          responseText = formatSummary(result, periodLabel, chatId);
        }

        await ctx.telegram.editMessageText(chatId, loadingMsg.message_id, undefined, responseText, {
          parse_mode: 'MarkdownV2',
        });
      } catch (e) {
        console.error('Error generating trends:', e);
        await ctx.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          undefined,
          '❌ Помилка при аналізі, спробуйте пізніше',
        );
      }
    });
  }

  async dispose(): Promise<void> {
    this.trendsService?.stopCleanupJob();
  }
}
