import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InputRichBlock, RichText } from 'grammy/types';
import type { SummarizationResult } from '../../services/openai.service.js';
import { trendsRichMessage } from './trendsMessage';

const CHAT_ID = -1001906889754;

/** The text a reader sees in a piece of rich text, links shown by their label */
const plain = (text: RichText): string => {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(plain).join('');
  return 'text' in text ? plain(text.text) : '';
};

/** Every URL in a piece of rich text */
const urls = (text: RichText): string[] => {
  if (typeof text === 'string') return [];
  if (Array.isArray(text)) return text.flatMap(urls);
  return text.type === 'url' ? [text.url] : 'text' in text ? urls(text.text) : [];
};

/**
 * The message as a reader goes through it, one line per block: headings as `#`,
 * list items as `-`, folded blocks as `[+]` with their content under them
 */
const outline = (blocks: InputRichBlock[]): string[] =>
  blocks.flatMap((b): string[] => {
    switch (b.type) {
      case 'heading':
        return [`# ${plain(b.text)}`];
      case 'paragraph':
        return [plain(b.text)];
      case 'blockquote':
        return outline(b.blocks).map((line) => `> ${line}`);
      case 'list':
        return b.items.flatMap((item) => outline(item.blocks).map((line) => `- ${line}`));
      case 'table':
        return b.cells.map((row) => row.map((c) => plain(c.text ?? '')).join(' | '));
      case 'details':
        return [`[${b.is_open ? '-' : '+'}] ${plain(b.summary)}`, ...outline(b.blocks).map((line) => `  ${line}`)];
      default:
        return [];
    }
  });

/** Every link in the message, in reading order */
const links = (blocks: InputRichBlock[]): string[] =>
  blocks.flatMap((b): string[] => {
    if (b.type === 'paragraph') return urls(b.text);
    if (b.type === 'list') return b.items.flatMap((item) => links(item.blocks));
    if (b.type === 'details') return links(b.blocks);
    return [];
  });

const result: SummarizationResult = {
  topParticipants: [{ name: 'Іван (адмін)', nickName: 'ivan_k', messageCount: 12, summary: 'Писав про ігри.' }],
  topics: [{ topic: 'Нова консоль', messageIds: ['101', '102'] }],
  trends: [],
  gaming: { summary: 'Чекають на реліз.', messageIds: ['103'] },
  memes: null,
  events: [],
  fullSummary: 'Спокійний день!',
};

describe('trendsRichMessage', () => {
  it('reads as the period, the overview, then the points; empty sections left out, side topics folded', () => {
    assert.deepEqual(outline(trendsRichMessage(result, '24 години', CHAT_ID).blocks!), [
      '# 📰 Тренди за 24 години',
      '> Спокійний день!',
      '# 🔥 Топ учасників',
      'Учасник | Повідомлень',
      'Іван (адмін) @ivan_k | 12',
      '[+] Хто про що писав',
      '  - Іван (адмін) — Писав про ігри.',
      '# 🗣️ Основні теми',
      '- Нова консоль 💬 💬',
      '[+] 🎮 Ігрова тематика',
      '  Чекають на реліз. 💬',
    ]);
  });

  it('links each point to the messages it is based on', () => {
    assert.deepEqual(links(trendsRichMessage(result, '24 години', CHAT_ID).blocks!), [
      'https://t.me/c/1906889754/101',
      'https://t.me/c/1906889754/102',
      'https://t.me/c/1906889754/103',
    ]);
  });

});
