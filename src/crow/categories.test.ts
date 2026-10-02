import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_CATEGORY_IDS, isGameStory, ownCategories, publishersNeeded } from './categories';

describe('the game categories', () => {
  it('tells game news from AI news by its categories', () => {
    assert.deepEqual(GAME_CATEGORY_IDS, ['playstation', 'ps-plus', 'nintendo', 'xbox', 'pc', 'freebies', 'gta6', 'releases', 'hacking']);
    assert.equal(isGameStory(['playstation']), true);
    assert.equal(isGameStory(['ai-enterprise', 'vibecoding']), false);
    assert.equal(isGameStory([]), false);
  });

  it('asks the fewest publishers its categories ask: GTA VI, the freebies and PS Plus two, a platform three', () => {
    assert.equal(publishersNeeded(['playstation']), 3);
    assert.equal(publishersNeeded(['ps-plus']), 2);
    assert.equal(publishersNeeded(['playstation', 'gta6']), 2);
    assert.equal(publishersNeeded(['freebies']), 2);
    assert.equal(publishersNeeded(['xbox', 'releases']), 2, 'a delay of an Xbox game');
    assert.equal(publishersNeeded(['hacking']), 1, 'the scene is niche');
    assert.equal(publishersNeeded([]), 3);
  });
});

describe('ownCategories', () => {
  it("lets an exclusive category take a news whole: PS Plus's lists are not Плойка's or the freebies", () => {
    assert.deepEqual(ownCategories(['playstation', 'ps-plus', 'freebies']), ['ps-plus']);
    assert.deepEqual(ownCategories(['playstation', 'xbox', 'playstation']), ['playstation', 'xbox']);
    assert.deepEqual(ownCategories([]), []);
  });
});
