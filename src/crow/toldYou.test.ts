import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedNumbers } from './arcValidation';
import { storyNamer } from './conversation';
import type { RumorUpdateRequest } from './prompts';
import { broughtStory, messageUrls, normalizeUrl, type ToldStory, writeRumorUpdate } from './toldYou';

describe('normalizeUrl', () => {
  it('compares links by host without www, path without a trailing slash, and query without trackers', () => {
    assert.equal(
      normalizeUrl('https://www.Anthropic.com/news/claude-opus-5-5/?utm_source=tg&utm_medium=x#top'),
      'anthropic.com/news/claude-opus-5-5',
    );
    assert.equal(normalizeUrl('anthropic.com/news/claude-opus-5-5'), 'anthropic.com/news/claude-opus-5-5');
    assert.equal(normalizeUrl('https://youtube.com/watch?v=abc&si=track'), 'youtube.com/watch?v=abc');
  });

  it('takes no front page, no other scheme and no bare word for a link to news', () => {
    assert.equal(normalizeUrl('https://www.anthropic.com/'), null);
    assert.equal(normalizeUrl('ftp://example.com/release'), null);
    assert.equal(normalizeUrl('Qwen/Qwen3.9-27B'), null);
  });
});

describe('messageUrls', () => {
  it('reads the links a message shows, those behind its words and that of its preview, once each', () => {
    const text = 'Opus тут: anthropic.com/news/x і ось';
    const entities = [
      { type: 'url' as const, offset: 10, length: 20 },
      { type: 'text_link' as const, offset: 34, length: 3, url: 'https://blog.google/gemini' },
      { type: 'bold' as const, offset: 0, length: 4 },
    ];
    assert.deepEqual(messageUrls(text, entities, 'https://blog.google/gemini'), ['anthropic.com/news/x', 'https://blog.google/gemini']);
    assert.deepEqual(messageUrls('без посилань'), []);
  });
});

const story = (patch: Partial<ToldStory>): ToldStory => ({
  storyId: 1,
  title: 'Claude Opus 5.5',
  facts: [],
  aliases: ['claude opus 5.5', 'opus', 'опус'],
  sources: [
    { url: 'https://openrouter.ai/anthropic/claude-opus-5.5', publisher: 'OpenRouter', official: false },
    { url: 'https://www.anthropic.com/news/claude-opus-5-5', publisher: 'Anthropic', official: true },
  ],
  sentAt: new Date('2026-09-27T09:00:00Z'),
  tgMessageId: 10,
  text: '🐦‍⬛ Opus',
  toldYou: false,
  ...patch,
});

describe('broughtStory', () => {
  const gemini = story({ storyId: 2, title: 'Gemini 3.8', aliases: ['gemini', 'гемені'], sources: [], sentAt: new Date('2026-09-27T10:00:00Z') });

  it('knows a story by a link to its source for sure, and by its aliases otherwise, the latest first', () => {
    const byLink = broughtStory({ text: 'дивіться', urls: ['https://anthropic.com/news/claude-opus-5-5'] }, [gemini, story({})], storyNamer);
    assert.deepEqual([byLink?.story.storyId, byLink?.sameSource], [1, true]);
    const byName = broughtStory({ text: 'опус вийшов, а gemini теж', urls: [] }, [story({}), gemini], storyNamer);
    assert.deepEqual([byName?.story.storyId, byName?.sameSource], [2, false]);
    const bySlug = broughtStory({ text: 'ось', urls: ['https://theverge.com/2026/9/22/claude-opus-launch'] }, [story({})], storyNamer);
    assert.equal(bySlug?.story.storyId, 1, 'the words of a link count');
  });

  it('passes over a story she has said «я ж казала» of already, and news she never told', () => {
    assert.equal(broughtStory({ text: 'опус', urls: [] }, [story({ toldYou: true })], storyNamer), null);
    assert.equal(broughtStory({ text: 'шо на обід', urls: ['https://example.com/lunch'] }, [story({})], storyNamer), null);
  });
});

describe('writeRumorUpdate', () => {
  const request: RumorUpdateRequest = {
    title: 'Gemini 4',
    rumorFacts: [{ id: 'F1', text: 'Кажуть, Gemini 4 вийде восени' }],
    officialFacts: [{ id: 'F2', text: 'Google представила Gemini 4 з контекстом 2 мільйони токенів' }],
    opening: '🐦‍⬛ Сорока каже…',
    maxLength: 600,
  };

  it('checks the UPD as an arc message, and rewrites it once', async () => {
    const texts = ['🐦‍⬛🐦‍⬛ Сорока не брехала: 30 мільйонів!', '🐦‍⬛🐦‍⬛ Сорока не брехала: 2 мільйони токенів.'];
    const requests: RumorUpdateRequest[] = [];
    const written = await writeRumorUpdate(
      async (r) => {
        requests.push(r);
        return { result: { text: texts[requests.length - 1] }, costUsd: 0.0004 };
      },
      request,
      allowedNumbers(...request.rumorFacts.map((f) => f.text), ...request.officialFacts.map((f) => f.text)),
    );
    assert.equal(written.text, '🐦‍⬛🐦‍⬛ Сорока не брехала: 2 мільйони токенів.');
    assert.deepEqual(requests[1].corrections, ['числа 30 немає у фактах']);
  });
});
