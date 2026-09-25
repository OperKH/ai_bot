import type { SummarizationResult } from '../../services/openai.service.js';
import { messageLink } from '../telegramLinks.js';

/** Telegram refuses a longer message */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Splits a long message into chunks by sections (double newlines).
 * Each chunk contains complete sections that fit within the limit.
 */
export function splitMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const sections = text.split('\n\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (const section of sections) {
    const sectionWithSeparator = currentChunk ? '\n\n' + section : section;

    if (currentChunk.length + sectionWithSeparator.length <= limit) {
      // Section fits in current chunk
      currentChunk += sectionWithSeparator;
    } else if (section.length > limit) {
      // Section itself is too long - need to split it by lines
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      // Split oversized section by lines, and a line longer than the limit into pieces
      const lines = section.split('\n').flatMap((line) => splitLongLine(line, limit));
      for (const line of lines) {
        const lineWithSeparator = currentChunk ? '\n' + line : line;
        if (currentChunk.length + lineWithSeparator.length <= limit) {
          currentChunk += lineWithSeparator;
        } else {
          if (currentChunk) {
            chunks.push(currentChunk);
          }
          currentChunk = line;
        }
      }
    } else {
      // Section doesn't fit - start new chunk
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      currentChunk = section;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Cuts a line longer than the limit — the model writes the full summary as one
 * paragraph — at the last space that fits, or at the limit if there is none,
 * but never between a MarkdownV2 escape and the character it escapes.
 */
function splitLongLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    let cut = space > 0 ? space : limit;
    if (rest[cut - 1] === '\\') cut--;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
}

/** Escapes the characters MarkdownV2 reserves, so text from the model shows as it is */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function formatMessageLinks(chatId: number, messageIds: string[]): string {
  if (!messageIds || messageIds.length === 0) return '';
  const links = messageIds.map((messageId) => `[💬](${messageLink(chatId, messageId)})`).join(' ');
  return ` ${links}`;
}

/** The trends summary as a MarkdownV2 message, with links to the messages each point is based on */
export function formatSummary(result: SummarizationResult, periodLabel: string, chatId: number): string {
  const lines: string[] = [
    `📰 *Тренди за останні ${escapeMarkdown(periodLabel)}*`,
    '',
    '*🔥 Топ учасників:*',
    ...result.topParticipants.map(
      (p, i) =>
        `${i + 1}\\. *${escapeMarkdown(p.name)}* \\(@${escapeMarkdown(p.nickName)}\\) — ${p.messageCount} повідомлень` +
        (p.summary ? `\n   _${escapeMarkdown(p.summary)}_` : ''),
    ),
  ];

  if (result.topics && result.topics.length > 0) {
    lines.push(
      '',
      '*🗣️ Основні теми:*',
      ...result.topics.map((t) => `• ${escapeMarkdown(t.topic)}${formatMessageLinks(chatId, t.messageIds)}`),
    );
  }

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
