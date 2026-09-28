import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicFreeGames, parseGamerPowerGiveaways } from './freebies';

// Trimmed from the real answers of 27.09.2026

const offer = (startDate: string, endDate: string, discountPercentage: number) => ({
  promotionalOffers: [{ startDate, endDate, discountSetting: { discountPercentage } }],
});
/** A game of the store; `free` — given away now, its price cut to nothing */
const game = (title: string, slug: string, price: string, promotions: object | null, free = false) => {
  const minor = Math.round(Number(price.replace(/[^\d.]/g, '')) * 100);
  return {
    title,
    productSlug: null,
    catalogNs: { mappings: [{ pageSlug: slug, pageType: 'productHome' }] },
    keyImages: [{ type: 'OfferImageWide', url: `https://cdn1.epicgames.com/${slug}.jpg` }],
    price: { totalPrice: { originalPrice: minor, discountPrice: free ? 0 : minor, currencyCode: 'UAH', fmtPrice: { originalPrice: price } } },
    promotions,
  };
};

const EPIC = JSON.stringify({
  data: {
    Catalog: {
      searchStore: {
        elements: [
          game(
            'Astrea Six Sided Oracles',
            'astrea-six-sided-oracles-33c949',
            'UAH 459.00',
            {
              promotionalOffers: [offer('2026-09-24T15:00:00.000Z', '2026-10-01T15:00:00.000Z', 0)],
              upcomingPromotionalOffers: [offer('2026-10-19T15:00:00.000Z', '2026-11-02T16:00:00.000Z', 60)],
            },
            true,
          ),
          game('Ghostrunner 2', 'ghostrunner-2', 'UAH 999.00', null),
          game('LISA: The Definitive Edition', 'lisa-the-definitive-edition', 'UAH 499.00', {
            promotionalOffers: [offer('2026-09-17T15:00:00.000Z', '2026-10-02T05:59:00.000Z', 50)],
            upcomingPromotionalOffers: [],
          }),
          game('System Shock 2: 25th Anniversary Remaster', 'system-shock-2-25th-anniversary-remaster-cb94d9', 'UAH 549.00', {
            promotionalOffers: [],
            upcomingPromotionalOffers: [offer('2026-10-01T15:00:00.000Z', '2026-10-08T15:00:00.000Z', 0)],
          }),
          game(
            'Mechabellum',
            'mechabellum-88a843',
            'UAH 325.00',
            { promotionalOffers: [offer('2026-09-24T15:00:00.000Z', '2026-10-01T15:00:00.000Z', 0)], upcomingPromotionalOffers: [] },
            true,
          ),
        ],
      },
    },
  },
});

const GAMERPOWER = JSON.stringify([
  {
    id: 3778,
    title: 'FOR HONOR (Ubisoft) Giveaway',
    worth: '$29.99',
    image: 'https://www.gamerpower.com/offers/1b/for-honor.jpg',
    description: 'Grab FOR HONOR for free on Ubisoft Connect and keep it forever!',
    platforms: 'PC, Ubisoft Connect',
    end_date: '2026-09-28 23:59:00',
    published_date: '2026-09-15 09:49:57',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/for-honor-ubisoft-giveaway',
  },
  {
    id: 3790,
    title: 'Mechabellum (Epic Games) Giveaway',
    worth: '$14.99',
    platforms: 'PC, Epic Games Store',
    end_date: '2026-10-01 23:59:00',
    published_date: '2026-09-24 11:08:31',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/mechabellum-epic-games-giveaway',
  },
  {
    id: 3716,
    title: 'Dwarven Realms (Steam) Key Giveaway',
    worth: '$19.99',
    platforms: 'PC, Steam',
    end_date: 'N/A',
    published_date: '2026-07-16 13:15:06',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/dwarven-realms-steam-key-giveaway',
  },
  {
    id: 3324,
    title: 'Battle Ram (IndieGala) Giveaway',
    worth: '$29.99',
    platforms: 'PC, DRM-Free',
    end_date: 'N/A',
    published_date: '2026-09-02 09:51:31',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/battle-ram-indiegala-giveaway',
  },
  {
    id: 3801,
    title: 'Tiny Tale (GOG) Giveaway',
    worth: '$4.99',
    platforms: 'PC, GOG',
    end_date: 'N/A',
    published_date: '2026-09-26 10:00:00',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/tiny-tale-gog-giveaway',
  },
  {
    id: 3802,
    title: 'Deus Ex (GOG) Giveaway',
    worth: '$9.99+',
    platforms: 'PC, GOG',
    end_date: 'N/A',
    published_date: '2026-09-26 11:00:00',
    type: 'Game',
    status: 'Active',
    gamerpower_url: 'https://www.gamerpower.com/deus-ex-gog-giveaway',
  },
]);

describe('parseEpicFreeGames', () => {
  it('makes one entry of the week’s giveaway, with its prices, the next week’s games and when it ends', () => {
    const [entry, ...rest] = parseEpicFreeGames(EPIC);
    assert.equal(rest.length, 0);
    assert.equal(entry.key, 'epic:2026-09-24T15:00:00.000Z', 'the next giveaway is new news');
    assert.equal(entry.title, 'Epic Games Store gives away Astrea Six Sided Oracles and Mechabellum');
    assert.equal(entry.url, 'https://store.epicgames.com/en-US/free-games');
    assert.equal(
      entry.summary,
      'Free to keep on the Epic Games Store until Thu, 01 Oct 2026 15:00 UTC: Astrea Six Sided Oracles (usually UAH 459.00), ' +
        'Mechabellum (usually UAH 325.00). Next free games, from Thu, 01 Oct 2026 15:00 UTC: System Shock 2: 25th Anniversary Remaster.',
    );
    assert.equal(entry.imageUrl, 'https://cdn1.epicgames.com/astrea-six-sided-oracles-33c949.jpg');
    assert.deepEqual(entry.games, [
      {
        title: 'Astrea Six Sided Oracles',
        platforms: 'PC',
        image: 'https://cdn1.epicgames.com/astrea-six-sided-oracles-33c949.jpg',
        url: 'https://store.epicgames.com/en-US/p/astrea-six-sided-oracles-33c949',
        price: { was: '459 ₴', now: '0 ₴' },
      },
      {
        title: 'Mechabellum',
        platforms: 'PC',
        image: 'https://cdn1.epicgames.com/mechabellum-88a843.jpg',
        url: 'https://store.epicgames.com/en-US/p/mechabellum-88a843',
        price: { was: '325 ₴', now: '0 ₴' },
      },
    ]);
    assert.deepEqual(entry.deadline, {
      kind: 'ends',
      at: '2026-10-01T15:00:00.000Z',
      remindAt: '2026-09-30T15:00:00.000Z',
    });
  });

  it('links a lone free game to its own page, and gives nothing when nothing is free', () => {
    const lone = JSON.parse(EPIC);
    lone.data.Catalog.searchStore.elements = lone.data.Catalog.searchStore.elements.filter(
      (element: { title: string }) => element.title === 'Mechabellum',
    );
    assert.equal(parseEpicFreeGames(JSON.stringify(lone))[0].url, 'https://store.epicgames.com/en-US/p/mechabellum-88a843');
    lone.data.Catalog.searchStore.elements[0].price.totalPrice.originalPrice = 0;
    assert.equal(parseEpicFreeGames(JSON.stringify(lone))[0].games?.[0].price, null, 'a game free anyway has no price');
    lone.data.Catalog.searchStore.elements = [];
    assert.deepEqual(parseEpicFreeGames(JSON.stringify(lone)), []);
  });
});

describe('parseGamerPowerGiveaways', () => {
  it('keeps the giveaways of the chat’s stores worth ten dollars, and leaves out Epic, key giveaways and small fry', () => {
    const entries = parseGamerPowerGiveaways(GAMERPOWER);
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['gamerpower:3778'],
    );
    const [honor] = entries;
    assert.equal(honor.title, 'FOR HONOR (Ubisoft)');
    assert.equal(honor.url, 'https://www.gamerpower.com/for-honor-ubisoft-giveaway', 'the attribution GamerPower asks for');
    assert.equal(
      honor.summary,
      'Grab FOR HONOR for free on Ubisoft Connect and keep it forever! Worth $29.99, on PC, Ubisoft Connect. Until Mon, 28 Sep 2026 23:59 UTC.',
    );
    assert.deepEqual(honor.deadline, { kind: 'ends', at: '2026-09-28T23:59:00.000Z', remindAt: '2026-09-27T23:59:00.000Z' });
    assert.deepEqual(honor.publishedAt, new Date('2026-09-15T09:49:57Z'));
    assert.deepEqual(honor.games, [
      {
        title: 'FOR HONOR',
        platforms: 'PC, Ubisoft Connect',
        image: 'https://www.gamerpower.com/offers/1b/for-honor.jpg',
        url: 'https://www.gamerpower.com/for-honor-ubisoft-giveaway',
        price: { was: '$29.99', now: '$0' },
      },
    ]);
  });
});
