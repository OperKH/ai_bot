import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headlineSimilarity, matchStory, type StoryCandidate } from './clustering';

const story = (patch: Partial<StoryCandidate> = {}): StoryCandidate => ({
  storyId: 7,
  headlines: ['Sony Confirms PS5 Price Increase in Europe Starting Next Month'],
  urls: ['https://www.pushsquare.com/news/2026/09/sony-confirms-ps5-price-increase'],
  similarity: null,
  ...patch,
});

describe('headlineSimilarity', () => {
  it('counts shared trigrams of the words as pg_trgm does, whatever the case and the punctuation', () => {
    assert.equal(headlineSimilarity('GTA 6 Delayed', 'gta 6 delayed!'), 1);
    assert.ok(headlineSimilarity('Sony Confirms PS5 Price Increase in Europe', 'Sony confirms PS5 price increase for Europe') > 0.6);
    assert.ok(headlineSimilarity('Sony Confirms PS5 Price Increase', 'Nintendo Direct Announced for Tomorrow') < 0.2);
    assert.equal(headlineSimilarity('', 'anything'), 0);
  });
});

describe('matchStory', () => {
  it('knows the story by the same link, trackers and all', () => {
    const match = matchStory(
      { url: 'https://pushsquare.com/news/2026/09/sony-confirms-ps5-price-increase/?utm_source=rss', headline: 'Whatever' },
      [story()],
    );
    assert.deepEqual(match, { kind: 'same', storyId: 7, by: 'link' });
  });

  it('knows it by nearly the same headline', () => {
    const match = matchStory({ url: null, headline: 'Sony confirms PS5 price increase in Europe starting next month' }, [story()]);
    assert.deepEqual(match, { kind: 'same', storyId: 7, by: 'headline' });
  });

  it('knows it by meaning from 0.75, asks the model from 0.6, and takes it for news of its own below', () => {
    const entry = { url: 'https://www.vgc.com/ps5-costs-more', headline: 'PlayStation 5 is getting more expensive in the EU' };
    assert.deepEqual(matchStory(entry, [story({ similarity: 0.81 }), story({ storyId: 8, similarity: 0.62 })]), {
      kind: 'same',
      storyId: 7,
      by: 'meaning',
    });
    assert.deepEqual(matchStory(entry, [story({ similarity: 0.68 })]), { kind: 'maybe', storyId: 7, similarity: 0.68 });
    assert.deepEqual(matchStory(entry, [story({ similarity: 0.55 })]), { kind: 'new' });
    assert.deepEqual(matchStory(entry, [story()]), { kind: 'new' }, 'no vectors to compare');
    assert.deepEqual(matchStory(entry, []), { kind: 'new' });
  });
});
