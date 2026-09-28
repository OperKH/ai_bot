import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLastChance, leavingEntries, leavingTime, parsePlayStationBlog, psPlusArrival, psPlusGames } from './psPlus';

// Trimmed from the real answers of 27.09.2026

const BLOG = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>PlayStation Plus Monthly Games for October: Hollow Knight: Silksong, Stray, Dead Island 2</title>
<link>https://blog.playstation.com/2026/09/30/playstation-plus-monthly-games-for-october/</link>
<guid isPermaLink="false">urn:uuid:aa01</guid><pubDate>Wed, 30 Sep 2026 15:30:00 +0000</pubDate>
<content:encoded><![CDATA[<p>Available from Tuesday, October 6.</p>
<figure><img src="https://blog.playstation.com/tachyon/2026/09/silksong.jpg?fit=1024%2C1024"/><img src="https://blog.playstation.com/tachyon/2026/09/silksong.jpg"/></figure>
<p class="wp-block-paragraph"><strong>Hollow Knight: Silksong | PS5, PS4</strong></p><p>Discover a vast, haunted kingdom.</p>
<figure><img src="https://blog.playstation.com/tachyon/2026/09/stray.jpg"/></figure>
<p class="wp-block-paragraph"><br><strong>Stray | PS5</strong><strong><br></strong>A lost cat.</p>
<h2><strong>PlayStation Plus Extra and Premium | Game Catalog</strong></h2>]]></content:encoded></item>
<item><title>PlayStation Plus Game Catalog for September: RuneScape: Dragonwilds, WWE 2K26, Ball x Pit</title>
<link>https://blog.playstation.com/2026/09/09/playstation-plus-game-catalog-for-september/</link>
<guid isPermaLink="false">urn:uuid:aa02</guid><pubDate>Wed, 09 Sep 2026 15:30:00 +0000</pubDate></item>
<item><title>(For Southeast Asia) Lisa x PlayStation arrives this October</title>
<link>https://blog.playstation.com/2026/09/22/for-southeast-asia-lisa/</link>
<guid isPermaLink="false">urn:uuid:aa03</guid><pubDate>Tue, 22 Sep 2026 01:03:00 +0000</pubDate></item>
<item><title>Luma Island is coming to PS5</title>
<link>https://blog.playstation.com/2026/09/24/luma-island-is-coming-to-ps5/</link>
<guid isPermaLink="false">urn:uuid:aa04</guid><pubDate>Thu, 24 Sep 2026 13:00:00 +0000</pubDate></item>
</channel></rss>`;

/** A piece of a product page of the Ukrainian store: its prices as the page's data keeps them */
const PRODUCT_PAGE =
  '"price":{"__typename":"Price","basePrice":"UAH 1 999,00","discountedPrice":"Долучено","displayDiscountText":"Долучено",' +
  '"serviceBranding":["PS_PLUS"],"endTime":"1792483200000","displayUpsellText":"Підпишіться на PlayStation Plus Экстра"}' +
  '"price":{"__typename":"Price","basePrice":"UAH 1 999,00","serviceBranding":["NONE"],"endTime":null}';

const PRODUCTS = [
  {
    id: 'EP0101-PPSA08709_00-MAINGAME00000000',
    name: 'SILENT HILL 2',
    platforms: ['PS5'],
    media: [
      { role: 'SCREENSHOT', type: 'IMAGE', url: 'https://image.api.playstation.com/shot.png' },
      { role: 'BACKGROUND', type: 'IMAGE', url: 'https://image.api.playstation.com/background.png' },
    ],
  },
  { id: 'EP0177-PPSA02384_00-LIKEADRAGON00000', name: 'Yakuza: Like a Dragon PS4 & PS5', platforms: ['PS4', 'PS5'] },
  { id: 'EP5403-CUSA31991_00-LAKEPS4SIEEFULL0', name: 'Lake PS4 & PS5', platforms: ['PS4'] },
  { id: 'EP5403-PPSA06333_00-LAKEPS5SIEEFULL0', name: 'Lake PS4 & PS5', platforms: ['PS5'] },
];
const GRID = JSON.stringify({ data: { categoryGridRetrieve: { products: PRODUCTS } } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers the store's requests from a list of rules, and remembers what was asked */
function stubFetch(answer: (url: string) => { status: number; body: string }) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const { status, body } = answer(url);
    return new Response(body, { status });
  }) as typeof fetch;
  return asked;
}

describe('psPlusArrival', () => {
  it('brings the monthly games on the first Tuesday of their month, the catalog on the third, at the rotation', () => {
    assert.deepEqual(psPlusArrival('PlayStation Plus Monthly Games for October: Stray', new Date('2026-09-30T15:30:00Z')), {
      kind: 'available',
      at: '2026-10-06T08:00:00.000Z',
      remindAt: '2026-10-06T10:00:00.000Z',
    });
    assert.equal(
      psPlusArrival('PlayStation Plus Game Catalog for October – Avatar', new Date('2026-10-14T15:30:00Z'))?.at,
      '2026-10-20T08:00:00.000Z',
    );
    assert.equal(
      psPlusArrival('PlayStation Plus Monthly Games for January: X', new Date('2026-12-30T15:30:00Z'))?.at,
      '2027-01-05T08:00:00.000Z',
      'January announced in December is next year’s',
    );
    assert.equal(psPlusArrival('Luma Island is coming to PS5', new Date()), undefined);
  });
});

describe('parsePlayStationBlog', () => {
  it('reads the posts whole, leaves out Southeast Asia, and dates the games of PS Plus', () => {
    const items = parsePlayStationBlog(BLOG);
    assert.deepEqual(
      items.map((item) => item.key),
      ['urn:uuid:aa01', 'urn:uuid:aa02', 'urn:uuid:aa04'],
    );
    assert.equal(items[0].deadline?.at, '2026-10-06T08:00:00.000Z');
    assert.deepEqual(items[0].games, [
      { title: 'Hollow Knight: Silksong', platforms: 'PS5, PS4', image: 'https://blog.playstation.com/tachyon/2026/09/silksong.jpg?fit=1280%2C1280' },
      { title: 'Stray', platforms: 'PS5', image: 'https://blog.playstation.com/tachyon/2026/09/stray.jpg?fit=1280%2C1280' },
    ], 'every game with its picture; a section heading is none');
    assert.deepEqual(psPlusGames('<p>No games here.</p>'), []);
    assert.equal(items[1].deadline?.at, '2026-09-15T08:00:00.000Z');
    assert.equal(items[2].deadline, undefined);
  });
});

describe('the games leaving PS Plus', () => {
  it('finds the moment a game leaves on its page', () => {
    assert.deepEqual(leavingTime(PRODUCT_PAGE), new Date('2026-10-20T08:00:00Z'));
    assert.equal(leavingTime('"serviceBranding":["NONE"],"endTime":null'), null);
  });

  it('makes an entry of each day games leave on, with the two editions of a game in one line; a game of no known day waits', () => {
    const october20 = Date.parse('2026-10-20T08:00:00Z');
    const [entry, ...rest] = leavingEntries(PRODUCTS, {
      [PRODUCTS[0].id]: october20,
      [PRODUCTS[1].id]: october20,
      [PRODUCTS[2].id]: october20,
      [PRODUCTS[3].id]: october20,
    });
    assert.equal(rest.length, 0);
    assert.equal(entry.key, 'ps-plus-leaving:2026-10-20');
    assert.equal(entry.title, '3 games leave PlayStation Plus Extra and Deluxe on October 20');
    assert.equal(
      entry.summary,
      'Leaving the PlayStation Plus Game Catalog (Extra and Deluxe) of the Ukrainian PlayStation Store on October 20, 2026: ' +
        'SILENT HILL 2 (PS5); Yakuza: Like a Dragon (PS4, PS5); Lake (PS4, PS5).',
    );
    assert.deepEqual(entry.deadline, { kind: 'ends', at: '2026-10-20T08:00:00.000Z', remindAt: '2026-10-17T08:00:00.000Z' });
    assert.deepEqual(entry.games?.[0], { title: 'SILENT HILL 2', platforms: 'PS5', image: 'https://image.api.playstation.com/background.png?w=1280' });
    assert.equal(entry.games?.length, 3);
    assert.deepEqual(leavingEntries(PRODUCTS, { [PRODUCTS[0].id]: null }), []);
  });

  it('reads each new game’s page once, keeping the moments and the hash of the store’s query in the state', async () => {
    const asked = stubFetch((url) =>
      url.includes('graphql') ? { status: 200, body: GRID } : { status: 200, body: PRODUCT_PAGE },
    );
    let found = 0;
    const findHash = async () => {
      found++;
      return 'fresh-hash';
    };
    const first = await fetchLastChance({}, 0, findHash);
    assert.equal(found, 1, 'no hash kept: it is found in the store’s bundles');
    assert.equal(first.state.hash, 'fresh-hash');
    assert.ok(asked[0].includes('fresh-hash'));
    assert.equal(asked.filter((url) => url.includes('/product/')).length, 4);
    assert.equal(first.items.length, 1);
    asked.length = 0;
    await fetchLastChance(first.state, 0, findHash);
    assert.equal(found, 1, 'the kept hash is taken');
    assert.deepEqual(asked.filter((url) => url.includes('/product/')), [], 'known games are not read again');
  });

  it('finds the hash again when the store no longer takes it, and fails when it takes not even that one', async () => {
    stubFetch((url) =>
      url.includes('stale-hash') || url.includes('refused')
        ? { status: 400, body: '{"message":"Query stale-hash not whitelisted"}' }
        : url.includes('graphql')
          ? { status: 200, body: GRID }
          : { status: 200, body: PRODUCT_PAGE },
    );
    const moved = await fetchLastChance({ hash: 'stale-hash' }, 0, async () => 'new-hash');
    assert.equal(moved.state.hash, 'new-hash');
    await assert.rejects(fetchLastChance({ hash: 'stale-hash' }, 0, async () => 'refused'), /not even the hash/);
    stubFetch(() => ({ status: 503, body: 'down' }));
    await assert.rejects(fetchLastChance({ hash: 'kept' }, 0, async () => 'x'), /HTTP 503/);
  });
});
