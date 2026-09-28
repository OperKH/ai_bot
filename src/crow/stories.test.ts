import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type GameSignal, gameStoryVerdict, storyVerdict } from './stories';

const NOW = new Date('2026-09-26T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const official = { sourceId: 'openai-news', official: true, aggregator: false };
const openRouter = { sourceId: 'openrouter', official: false, aggregator: true };
const press = (sourceId: string) => ({ sourceId, official: false, aggregator: false });

describe('storyVerdict', () => {
  it('writes at once what an official source has', () => {
    assert.equal(storyVerdict(ago(0), [official], NOW), 'write');
    assert.equal(storyVerdict(ago(1), [openRouter, official], NOW), 'write');
  });

  it('writes a model listed in a catalog after an hour without an announcement', () => {
    assert.equal(storyVerdict(ago(59), [openRouter], NOW), 'wait');
    assert.equal(storyVerdict(ago(60), [openRouter], NOW), 'write');
  });

  it('makes a rumor of two sources that agree, after 45 minutes', () => {
    assert.equal(storyVerdict(ago(44), [press('vgc'), press('ign')], NOW), 'wait');
    assert.equal(storyVerdict(ago(45), [press('vgc'), press('ign')], NOW), 'write-rumor');
  });

  it('counts sources, not entries', () => {
    assert.equal(storyVerdict(ago(90), [press('vgc'), press('vgc')], NOW), 'wait');
  });

  it('drops what nobody confirmed in six hours', () => {
    assert.equal(storyVerdict(ago(359), [press('vgc')], NOW), 'wait');
    assert.equal(storyVerdict(ago(360), [press('vgc')], NOW), 'drop');
  });
});

describe('gameStoryVerdict', () => {
  const at = (minutes: number) => new Date(ago(90).getTime() + minutes * 60_000);
  const from = (publisher: string, minute: number, patch: Partial<GameSignal> = {}): GameSignal => ({
    publisher,
    official: false,
    structured: false,
    firstSeenAt: at(minute),
    ...patch,
  });

  it('writes a store’s own list, and a platform’s post of a notable news, at once', () => {
    const story = ago(0);
    assert.equal(gameStoryVerdict(story, [{ ...from('Epic', 90), structured: true }], 3, 2, NOW).verdict, 'write');
    assert.equal(gameStoryVerdict(story, [{ ...from('Sony', 90), official: true }], 3, 2, NOW).verdict, 'write');
    assert.equal(gameStoryVerdict(story, [{ ...from('Sony', 90), official: true }], 3, 1, NOW).verdict, 'wait', 'a trifle waits for the press');
  });

  it('writes the press once enough publishers wrote of it, after twenty minutes; the sites of one publisher count once', () => {
    const three = [from('VGC', 0), from('Hookshot Media', 5), from('IGN Entertainment', 10)];
    assert.deepEqual(gameStoryVerdict(at(0), three, 3, 2, at(19)), { verdict: 'wait', importance: 2 }, 'the others may still come');
    assert.deepEqual(gameStoryVerdict(at(0), three, 3, 2, at(20)), { verdict: 'write', importance: 2 });
    const oneHouse = [from('VGC', 0), from('Hookshot Media', 5), from('Hookshot Media', 10)];
    assert.equal(gameStoryVerdict(at(0), oneHouse, 3, 2, at(30)).verdict, 'wait');
    assert.equal(gameStoryVerdict(at(0), oneHouse, 2, 2, at(30)).verdict, 'write', 'GTA VI takes two');
  });

  it('counts only the publishers of its first six hours, and drops a story that never got enough', () => {
    const late = [from('VGC', 0), from('Gematsu', 5), from('IGN Entertainment', 6 * 60 + 1)];
    assert.equal(gameStoryVerdict(at(0), late, 3, 2, at(6 * 60 + 2)).verdict, 'drop');
    assert.equal(gameStoryVerdict(at(0), [from('VGC', 0)], 3, 2, at(5 * 60)).verdict, 'wait');
  });

  it('makes a mega news of five publishers within three hours, or of a platform’s post and three publishers', () => {
    const five = ['VGC', 'Hookshot Media', 'IGN Entertainment', 'Gematsu', 'Kotaku'].map((p, i) => from(p, i * 30));
    assert.deepEqual(gameStoryVerdict(at(0), five, 3, 1, at(150)), { verdict: 'write', importance: 3 });
    const slow = ['VGC', 'Hookshot Media', 'IGN Entertainment', 'Gematsu', 'Kotaku'].map((p, i) => from(p, i * 50));
    assert.equal(gameStoryVerdict(at(0), slow, 3, 2, at(210)).importance, 2, 'the fifth came after three hours');
    const official = [from('Sony', 0, { official: true }), from('VGC', 10), from('Hookshot Media', 12)];
    assert.deepEqual(gameStoryVerdict(at(0), official, 3, 2, at(15)), { verdict: 'write', importance: 3 });
  });
});
