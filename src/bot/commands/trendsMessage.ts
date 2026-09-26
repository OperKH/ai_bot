import type { InputRichBlock, InputRichMessage, RichBlockTableCell, RichText } from 'grammy/types';
import type { SummarizationResult } from '../../services/openai.service.js';
import { messageLink } from '../telegramLinks.js';

const heading = (text: string, size: 2 | 3 = 3): InputRichBlock => ({ type: 'heading', text, size });

const cell = (text: RichText, align: 'left' | 'right', is_header?: true): RichBlockTableCell => ({
  text,
  align,
  valign: 'middle',
  is_header,
});

/** A paragraph followed by links to the messages it is based on, one 💬 each */
const linkedParagraph = (chatId: number, text: RichText, messageIds: string[] = []): InputRichBlock => ({
  type: 'paragraph',
  text: [
    text,
    ...messageIds.flatMap((id) => [' ', { type: 'url' as const, text: '💬', url: messageLink(chatId, id) }]),
  ],
});

const pointList = (chatId: number, points: { text: RichText; messageIds?: string[] }[]): InputRichBlock => ({
  type: 'list',
  items: points.map((p) => ({ blocks: [linkedParagraph(chatId, p.text, p.messageIds)] })),
});

/**
 * The trends summary as one rich message: the overview first, the main points
 * open, the side topics folded away. Text goes in as data, so nothing needs escaping.
 */
export function trendsRichMessage(result: SummarizationResult, periodLabel: string, chatId: number): InputRichMessage {
  const blocks = [heading(`📰 Тренди за ${periodLabel}`, 2)];

  if (result.fullSummary) {
    blocks.push({ type: 'blockquote', blocks: [{ type: 'paragraph', text: result.fullSummary }] });
  }

  if (result.topParticipants.length > 0) {
    blocks.push(heading('🔥 Топ учасників'), {
      type: 'table',
      is_striped: true,
      cells: [
        [cell('Учасник', 'left', true), cell('Повідомлень', 'right', true)],
        ...result.topParticipants.map((p) => [
          cell([{ type: 'bold', text: p.name }, p.nickName ? ` @${p.nickName}` : ''], 'left'),
          cell(String(p.messageCount), 'right'),
        ]),
      ],
    });
    const described = result.topParticipants.filter((p) => p.summary);
    if (described.length > 0) {
      blocks.push({
        type: 'details',
        summary: 'Хто про що писав',
        blocks: [
          pointList(
            chatId,
            described.map((p) => ({ text: [{ type: 'bold', text: p.name }, ` — ${p.summary}`] })),
          ),
        ],
      });
    }
  }

  const sections = [
    ['🗣️ Основні теми', result.topics.map((t) => ({ text: t.topic, messageIds: t.messageIds }))],
    ['📈 Тренди', result.trends.map((t) => ({ text: t.trend, messageIds: t.messageIds }))],
    ['📅 Заплановані події', result.events.map((e) => ({ text: e.event, messageIds: e.messageIds }))],
  ] as const;
  for (const [label, points] of sections) {
    if (points.length > 0) blocks.push(heading(label), pointList(chatId, points));
  }

  const folded = [
    ['🎮 Ігрова тематика', result.gaming],
    ['😂 Мем-тренди', result.memes],
  ] as const;
  for (const [label, section] of folded) {
    if (!section) continue;
    blocks.push({
      type: 'details',
      summary: { type: 'bold', text: label },
      blocks: [linkedParagraph(chatId, section.summary, section.messageIds)],
    });
  }

  return { blocks };
}
