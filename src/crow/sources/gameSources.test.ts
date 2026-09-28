import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_SOURCES } from './gameSources';
import type { FeedItem } from './feed';

const item = (title: string): FeedItem => ({ key: title, title, url: null, summary: '', publishedAt: null, imageUrl: null });
const accepts = (sourceId: string, title: string) => {
  const source = GAME_SOURCES.find((s) => s.id === sourceId)!;
  return source.accept?.(item(title)) ?? true;
};

describe('the game sources', () => {
  it('leave out the columns of Hookshot’s sites that are never news, but not the guide to the week’s releases', () => {
    assert.equal(accepts('push-square', 'Review: Ghost of Yotei - A Masterpiece'), false);
    assert.equal(accepts('push-square', 'Talking Point: What Are You Playing This Weekend?'), false);
    assert.equal(accepts('push-square', 'Guide: All PS Plus Games Available Now'), false);
    assert.equal(accepts('push-square', 'Guide: These 21+ PS5 and PS Plus Games Are Coming Out Next Week (28th-4th October)'), true);
    assert.equal(accepts('push-square', 'Sony Confirms PS5 Price Increase in Europe'), true);
  });

  it('leave out Steam’s client updates and Xbox Wire’s podcast', () => {
    assert.equal(accepts('steam-news', 'Steam Client Update - September 1st'), false);
    assert.equal(accepts('steam-news', "Steam's Party-Based RPG Fest has arrived!"), true);
    assert.equal(accepts('xbox-wire', 'Minecraft Dungeons II: The Sift, New Mechanics | Official XBOX Podcast'), false);
    assert.equal(accepts('xbox-wire', 'Next Week on XBOX: New Games for September 28 to October 2'), true);
  });

  it('leave out the press’s guides and a trailer or gameplay post of Gematsu', () => {
    assert.equal(accepts('vgc', 'Fire Emblem Fortune’s Weave: Master location, Missing Master quest guide'), false);
    assert.equal(accepts('vgc', 'Podcast: Halo under Activision'), false);
    assert.equal(accepts('vgc', 'Microsoft CEO says ‘streamlining’ of Xbox business is ‘great to see’'), true);
    assert.equal(accepts('gematsu', 'Ace Combat 8: Wings of Theve ‘101 Overview’ trailer'), false);
    assert.equal(accepts('gematsu', 'Nocturnal II for PC launches November 10'), true);
  });

  it('count the sites of one house as one publisher, and the stores’ lists as the news by itself', () => {
    const publisher = (id: string) => GAME_SOURCES.find((s) => s.id === id)?.publisher;
    assert.equal(publisher('push-square'), publisher('nintendo-life'));
    assert.equal(publisher('ign'), publisher('eurogamer'));
    assert.equal(publisher('pure-xbox'), publisher('time-extension'));
    assert.equal(publisher('rock-paper-shotgun'), publisher('ign'));
    assert.deepEqual(
      GAME_SOURCES.filter((s) => s.structured).map((s) => s.id),
      ['epic-free-games', 'gamerpower', 'game-pass-added', 'game-pass-leaving', 'ps-store-last-chance'],
    );
    assert.ok(GAME_SOURCES.filter((s) => s.id.startsWith('reddit-')).every((s) => s.publisher === 'Reddit'));
    assert.deepEqual(
      GAME_SOURCES.filter((s) => s.activeFrom).map((s) => s.id),
      ['reddit-gta6', 'reddit-chiliad-mystery', 'google-news-gta6'],
      'GTA VI’s mysteries wait for its release',
    );
  });
});
