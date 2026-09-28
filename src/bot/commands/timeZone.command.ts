import type { DataSource } from 'typeorm';
import { InlineKeyboard } from 'grammy';
import { Command } from './command.class';
import { ChatState } from '../../entity/index';
import { REGIONS, timeZoneName } from './timeZones';

const TYPE_HINT = 'ℹ️ Нема в списку? Напиши назву поясу: /timezone Pacific/Tahiti';

/** The chat's time zone, set with /timezone; null until someone does */
export async function chatTimeZone(dataSource: DataSource, chatId: number): Promise<string | null> {
  const state = await dataSource.getRepository(ChatState).findOneBy({ chatId: String(chatId) });
  return state?.timeZone ?? null;
}

/** The zone's current offset from UTC, such as "GMT+3" */
const utcOffset = (timeZone: string) =>
  new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts()
    .find((part) => part.type === 'timeZoneName')!.value;

const regionKeyboard = () =>
  InlineKeyboard.from(REGIONS.map((region, i) => [InlineKeyboard.text(region.name, `tz-r${i}`)]));

/** The region's cities, two a row, each with its offset now */
const cityKeyboard = (region: (typeof REGIONS)[number]) => {
  const buttons = region.zones.map(([zone, city]) => InlineKeyboard.text(`${city} (${utcOffset(zone)})`, `tz-z${zone}`));
  const rows = Array.from({ length: Math.ceil(buttons.length / 2) }, (_, i) => buttons.slice(i * 2, i * 2 + 2));
  return InlineKeyboard.from([...rows, [InlineKeyboard.text('⬅️ Назад', 'tz-back')]]);
};

/** What `/timezone` shows first: the chat's zone, and the regions to pick one from */
export async function timeZonePicker(dataSource: DataSource, chatId: number) {
  const current = await chatTimeZone(dataSource, chatId);
  const state = current ? `🕰 Часовий пояс чату: ${current}` : '🕰 Часовий пояс чату не задано';
  return { text: `${state}\nОбери регіон:\n\n${TYPE_HINT}`, reply_markup: regionKeyboard() };
}

/**
 * Sets the time zone a chat lives in, picked with buttons (region, then city) or
 * typed. A bot is not told its users' zones, and the chats it serves may live in
 * different ones, so it is kept per chat, in `ChatState`. The crow counts its
 * quiet hours and "today" in it; a chat that has set none is in UTC.
 */
export class TimeZoneCommand extends Command {
  public command = 'timezone';
  public description = '🕰 Часовий пояс чату';

  handle(): void {
    this.bot.command(this.command, async (ctx) => {
      const reply_parameters = { message_id: ctx.msg.message_id };
      const name = ctx.match.trim();
      if (!name) {
        const { text, reply_markup } = await timeZonePicker(this.dataSource, ctx.chat.id);
        await ctx.reply(text, { reply_parameters, reply_markup });
        return;
      }
      const timeZone = timeZoneName(name);
      const text = timeZone ? await this.save(ctx.chat.id, timeZone) : `⚠️ Не знаю такого часового поясу.\n${TYPE_HINT}`;
      await ctx.reply(text, { reply_parameters });
    });

    this.bot.callbackQuery(/^tz-r(\d+)$/, async (ctx) => {
      const region = REGIONS[Number(ctx.match[1])];
      await ctx.answerCallbackQuery();
      if (region) await ctx.editMessageText(`🕰 ${region.name}: обери місто`, { reply_markup: cityKeyboard(region) });
    });

    this.bot.callbackQuery('tz-back', async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.chat) return;
      const { text, reply_markup } = await timeZonePicker(this.dataSource, ctx.chat.id);
      await ctx.editMessageText(text, { reply_markup });
    });

    this.bot.callbackQuery(/^tz-z(.+)$/, async (ctx) => {
      const timeZone = timeZoneName(ctx.match[1]);
      if (!timeZone || !ctx.chat) {
        await ctx.answerCallbackQuery('❌ Помилка: кнопка застаріла');
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(await this.save(ctx.chat.id, timeZone), { reply_markup: { inline_keyboard: [] } });
    });
  }


  /** Stores the chat's zone and says so, with the time there now as a check */
  private async save(chatId: number, timeZone: string) {
    await this.dataSource.getRepository(ChatState).upsert({ chatId: String(chatId), timeZone }, ['chatId']);
    const now = new Date().toLocaleTimeString('uk-UA', { timeZone, hour: '2-digit', minute: '2-digit' });
    return `✅ Часовий пояс чату: ${timeZone} (зараз ${now})`;
  }
}
