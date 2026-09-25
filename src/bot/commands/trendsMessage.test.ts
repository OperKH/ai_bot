import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SummarizationResult } from '../../services/openai.service.js';
import { escapeMarkdown, formatSummary, splitMessage } from './trendsMessage';

const LIMIT = 100;

describe('splitMessage', () => {
  it('leaves a message within the limit whole', () => {
    assert.deepEqual(splitMessage('коротко', LIMIT), ['коротко']);
  });

  it('keeps sections whole and every chunk within the limit', () => {
    const sections = Array.from({ length: 8 }, (_, i) => `розділ ${i}: ` + 'слово '.repeat(5));
    const chunks = splitMessage(sections.join('\n\n'), LIMIT);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= LIMIT, `${chunk.length} > ${LIMIT}`);
    assert.deepEqual(chunks.join('\n\n').split('\n\n'), sections, 'no section split or lost');
  });

  it('splits a section longer than the limit by its lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `рядок ${i} ` + 'x'.repeat(20));
    const chunks = splitMessage(lines.join('\n'), LIMIT);

    for (const chunk of chunks) assert.ok(chunk.length <= LIMIT, `${chunk.length} > ${LIMIT}`);
    assert.deepEqual(chunks.join('\n').split('\n'), lines, 'no line split or lost');
  });

  it('never sends a chunk over the limit, even for a single line longer than it', () => {
    const line = 'довгий підсумок без переносів '.repeat(12);
    const chunks = splitMessage(`заголовок\n\n${line}`, LIMIT);

    for (const chunk of chunks) assert.ok(chunk.length <= LIMIT, `${chunk.length} > ${LIMIT}`);
    assert.equal(chunks.join('').replace(/\s/g, ''), `заголовок${line}`.replace(/\s/g, ''), 'no text lost');
  });
});

describe('splitMessage on MarkdownV2', () => {
  it('does not cut a line without spaces between an escape and the character it escapes', () => {
    const line = escapeMarkdown('a.'.repeat(80));
    const chunks = splitMessage(`заголовок\n\n${line}`, LIMIT);

    for (const chunk of chunks) {
      assert.ok(chunk.length <= LIMIT, `${chunk.length} > ${LIMIT}`);
      assert.doesNotMatch(chunk, /(^|[^\\])(\\\\)*\\$/, 'a chunk ends with a lone backslash');
    }
  });
});

describe('escapeMarkdown', () => {
  it('escapes every character MarkdownV2 reserves and leaves the rest', () => {
    const reserved = '_*[]()~`>#+-=|{}.!';
    assert.equal(escapeMarkdown(reserved), [...reserved].map((c) => `\\${c}`).join(''));
    assert.equal(escapeMarkdown('Привіт, як справи?'), 'Привіт, як справи?');
  });
});

describe('formatSummary', () => {
  const result = {
    topParticipants: [{ name: 'Іван (адмін)', nickName: 'ivan_k', messageCount: 12, summary: 'Писав про ігри.' }],
    topics: [{ topic: 'Нова консоль', messageIds: ['101', '102'] }],
    trends: [],
    gaming: null,
    memes: null,
    events: [],
    fullSummary: 'Спокійний день!',
  } as unknown as SummarizationResult;

  it('escapes the model text and links each point to its messages', () => {
    const text = formatSummary(result, '24 години', -1001906889754);

    assert.match(text, /\*Іван \\\(адмін\\\)\* \\\(@ivan\\_k\\\)/);
    assert.match(text, /_Писав про ігри\\\._/);
    assert.match(
      text,
      /• Нова консоль \[💬\]\(https:\/\/t\.me\/c\/1906889754\/101\) \[💬\]\(https:\/\/t\.me\/c\/1906889754\/102\)/,
    );
    assert.match(text, /Спокійний день\\!/);
  });

  it('leaves out the sections the model returned empty', () => {
    const text = formatSummary(result, '24 години', -1001906889754);
    assert.doesNotMatch(text, /Тренди:|Ігрова тематика|Мем|Заплановані події/);
  });
});
