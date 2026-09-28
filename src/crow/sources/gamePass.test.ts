import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_PASS_ADDED, gamePassEntry, gamePassSource, parseCatalogProducts, parseGamePassList } from './gamePass';

// Trimmed from the real answers of 27.09.2026

const LIST = JSON.stringify([
  { siglId: '393f05bf-e596-4ef6-9487-6d4fa0eab987', title: 'Leaving soon', description: 'Save on these games now.' },
  { id: '9MW1V43D3VZN' },
  { id: '9MWDJRQ1BXTC' },
]);
const PRODUCTS = JSON.stringify({
  Products: [
    {
      ProductId: '9MW1V43D3VZN',
      LocalizedProperties: [
        {
          ProductTitle: 'Terminull Brigade™',
          Images: [
            { ImagePurpose: 'BoxArt', Uri: '//store-images.s-microsoft.com/image/box' },
            { ImagePurpose: 'SuperHeroArt', Uri: '//store-images.s-microsoft.com/image/hero' },
          ],
        },
      ],
    },
    { ProductId: '9MWDJRQ1BXTC', LocalizedProperties: [{ ProductTitle: 'SWORN' }] },
  ],
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Game Pass', () => {
  it('reads a list’s products, and their titles and art from the display catalog', () => {
    assert.deepEqual(parseGamePassList(LIST), ['9MW1V43D3VZN', '9MWDJRQ1BXTC']);
    assert.deepEqual(parseCatalogProducts(PRODUCTS), [
      { id: '9MW1V43D3VZN', title: 'Terminull Brigade', image: 'https://store-images.s-microsoft.com/image/hero' },
      { id: '9MWDJRQ1BXTC', title: 'SWORN', image: null },
    ]);
  });

  it('makes one entry of the games that came together, keyed by them', () => {
    const entry = gamePassEntry(GAME_PASS_ADDED, parseCatalogProducts(PRODUCTS));
    assert.equal(entry?.key, 'gamepass-added:9MW1V43D3VZN,9MWDJRQ1BXTC');
    assert.equal(entry?.title, 'Added to Xbox Game Pass: Terminull Brigade, SWORN');
    assert.deepEqual(entry?.games?.map((game) => game.title), ['Terminull Brigade', 'SWORN']);
    assert.equal(gamePassEntry(GAME_PASS_ADDED, []), null);
  });

  it('asks the catalog only for the games new on the list since the last poll', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      asked.push(String(input));
      return new Response(String(input).includes('sigls') ? LIST : PRODUCTS, { status: 200 });
    }) as typeof fetch;
    const poll = gamePassSource(GAME_PASS_ADDED);
    const first = await poll({});
    assert.equal(first.items.length, 1);
    assert.deepEqual(first.state.ids, ['9MW1V43D3VZN', '9MWDJRQ1BXTC']);
    asked.length = 0;
    const second = await poll(first.state);
    assert.deepEqual(second.items, []);
    assert.equal(asked.filter((url) => url.includes('displaycatalog')).length, 0);
  });
});
