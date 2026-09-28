import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gamesTable } from './scheduler';
import { crowRichMessage, type Moment, newsLinks, readableText, richText, storyUrl, withoutMarkup } from './crowMessage';

const release: Moment = { unixTime: 1795039200, format: 'r', fallback: '19.11 за Києвом' };

describe('richText', () => {
  it('keeps plain text a plain string', () => {
    assert.equal(richText('🐦‍⬛ Кар.'), '🐦‍⬛ Кар.');
  });

  it('turns **bold** spans into bold rich text', () => {
    assert.deepEqual(richText('Anthropic випустили **Claude Opus 5.5**!'), [
      'Anthropic випустили ',
      { type: 'bold', text: 'Claude Opus 5.5' },
      '!',
    ]);
  });

  it('highlights ==marked== prices and dates in colour, and the code’s ~~struck~~ price', () => {
    assert.deepEqual(richText('**Astrea** за ==0 ₴== до ==1 жовтня==, а була ~~459 ₴~~'), [
      { type: 'bold', text: 'Astrea' },
      ' за ',
      { type: 'marked', text: '0 ₴' },
      ' до ',
      { type: 'marked', text: '1 жовтня' },
      ', а була ',
      { type: 'strikethrough', text: '459 ₴' },
    ]);
    assert.equal(withoutMarkup('🐦‍⬛ Чи вийде **GTA VI** ==19 листопада==?'), '🐦‍⬛ Чи вийде GTA VI 19 листопада?', 'for a poll');
  });

  it('puts moments in as date_time, so every reader sees their own time zone', () => {
    assert.deepEqual(richText('До GTA VI — {when:release}.', { moments: { release } }), [
      'До GTA VI — ',
      { type: 'date_time', text: '19.11 за Києвом', unix_time: 1795039200, date_time_format: 'r' },
      '.',
    ]);
  });

  it('leaves out a moment that is not known instead of showing the placeholder', () => {
    assert.deepEqual(richText('Ще {when:nope}!'), ['Ще ', '!']);
  });

  it('shows `code` of the sources as code rather than as backticks', () => {
    assert.deepEqual(richText('Режим `pro` для складних задач, а ` сам не рахується'), [
      'Режим ',
      { type: 'code', text: 'pro' },
      ' для складних задач, а ` сам не рахується',
    ]);
  });

  it('names the cat of a jab: by username, by id without one, or only by name without a ping', () => {
    const cat = { userId: '42', name: 'Олег', username: 'oleg', ping: true };
    assert.deepEqual(richText('{cat}, твій Opus', { mention: cat }), [
      { type: 'mention', text: '@oleg', username: 'oleg' },
      ', твій Opus',
    ]);
    assert.deepEqual(richText('{cat}!', { mention: { ...cat, username: null } }), [
      { type: 'text_mention', text: 'Олег', user: { id: 42, is_bot: false, first_name: 'Олег' } },
      '!',
    ]);
    assert.deepEqual(richText('{cat}!', { mention: { ...cat, ping: false } }), ['Олег', '!']);
    assert.deepEqual(richText('{cat}!'), '!');
  });

  it('does not treat dollars, hashes or pipes as markup', () => {
    assert.equal(richText('$2 / $10 за 1M, #1 | топ'), '$2 / $10 за 1M, #1 | топ');
  });

  it('puts in the links and the cats the code named, and leaves out those it did not', () => {
    const anchors = { post: { label: '💬', url: 'https://t.me/c/1906889754/1366' } };
    const mentions = { a: { userId: '42', name: 'Олег', username: 'oleg', ping: true }, b: { userId: '7', name: 'Іра', username: null, ping: false } };
    assert.deepEqual(richText('Каркала {link:post}, {cat:a} і {cat:b}{link:nope}{cat:c}.', { anchors, mentions }), [
      'Каркала ',
      { type: 'url', text: '💬', url: 'https://t.me/c/1906889754/1366' },
      ', ',
      { type: 'mention', text: '@oleg', username: 'oleg' },
      ' і ',
      'Іра',
      '.',
    ]);
  });
});

describe('readableText', () => {
  it("reads the placeholders as the chat saw them, for the crow's memory", () => {
    const refs = {
      moments: { told: { unixTime: 1790000000, format: 'r' as const, fallback: '3 год тому' } },
      anchors: { post: { label: '💬', url: 'https://t.me/c/1/2' } },
      mentions: { a: { userId: '42', name: 'Олег', username: 'oleg', ping: true } },
    };
    assert.equal(
      readableText('🐦‍⬛ Я про це каркала ще {when:told} {link:post}, **{cat:a}**. {cat}', refs),
      '🐦‍⬛ Я про це каркала ще 3 год тому 💬, **Олег**. кіт',
    );
  });
});

describe('crowRichMessage', () => {
  it('makes lines paragraphs and runs of • lines a list', () => {
    const message = crowRichMessage({ text: 'Шапка\n• раз;\n• два.\nХвіст' });
    assert.deepEqual(message.blocks, [
      { type: 'paragraph', text: 'Шапка' },
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: 'раз;' }] },
          { blocks: [{ type: 'paragraph', text: 'два.' }] },
        ],
      },
      { type: 'paragraph', text: 'Хвіст' },
    ]);
  });

  it('puts the picture first and the table last, numbers aligned right', () => {
    const message = crowRichMessage({
      text: 'Цифри:',
      photos: ['file-id'],
      table: { header: ['', 'Opus 5'], rows: [['Ціна', '100%']] },
    });
    assert.deepEqual(message.blocks?.[0], { type: 'photo', photo: { type: 'photo', media: 'file-id' } });
    assert.deepEqual(message.blocks?.[2], {
      type: 'table',
      is_striped: true,
      cells: [
        [
          { text: '', align: 'left', valign: 'middle', is_header: true },
          { text: 'Opus 5', align: 'left', valign: 'middle', is_header: true },
        ],
        [
          { text: 'Ціна', align: 'left', valign: 'middle', is_header: undefined },
          { text: '100%', align: 'right', valign: 'middle', is_header: undefined },
        ],
      ],
    });
  });

  it('puts a heading above the text, and introduces the links at the end as asked', () => {
    const message = crowRichMessage({
      heading: '🗞 Воронячий дайджест',
      text: 'Тиждень',
      links: [{ label: 'youtube.com', url: 'https://www.youtube.com/watch?v=x' }],
      linksLabel: '📺 Дивитися:',
    });
    assert.deepEqual(message.blocks?.[0], { type: 'heading', text: '🗞 Воронячий дайджест', size: 3 });
    assert.deepEqual(message.blocks?.at(-1), {
      type: 'paragraph',
      text: ['📺 Дивитися: ', { type: 'url', text: 'youtube.com', url: 'https://www.youtube.com/watch?v=x' }],
    });
  });

  it('puts several pictures into a collage', () => {
    const message = crowRichMessage({ text: 'Доброго ранку', photos: ['a', 'b'] });
    assert.deepEqual(message.blocks?.[0], {
      type: 'collage',
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: 'a' } },
        { type: 'photo', photo: { type: 'photo', media: 'b' } },
      ],
    });
  });

  it('ends with the links to read the news in full, each label a link', () => {
    const message = crowRichMessage({
      text: 'Доброго ранку',
      links: [
        { label: 'Claude Opus 5.5', url: 'https://www.anthropic.com/claude-opus-5-5' },
        { label: 'Gemini 3.8 Live', url: 'https://blog.google/gemini-3-8-live' },
      ],
    });
    assert.deepEqual(message.blocks?.at(-1), {
      type: 'paragraph',
      text: [
        '🔗 Детальніше: ',
        { type: 'url', text: 'Claude Opus 5.5', url: 'https://www.anthropic.com/claude-opus-5-5' },
        ' · ',
        { type: 'url', text: 'Gemini 3.8 Live', url: 'https://blog.google/gemini-3-8-live' },
      ],
    });
    assert.equal(crowRichMessage({ text: 'Хвіст арки', links: [] }).blocks?.length, 1, 'no links, no line');
  });
});

const source = (url: string, official = false) => ({ url, publisher: 'test', official });

describe('storyUrl', () => {
  it('takes the first official page, whatever came before it', () => {
    // Claude Fable 5.1 came from OpenRouter's catalog first, then from Anthropic's own page
    const sources = [
      source('https://openrouter.ai/anthropic/claude-fable-5.1'),
      source('https://www.anthropic.com/claude-fable-and-mythos-5-1', true),
    ];
    assert.equal(storyUrl(sources)?.href, 'https://www.anthropic.com/claude-fable-and-mythos-5-1');
  });

  it('falls back to the first source, and passes over what is not a web page', () => {
    const sources = [source('Qwen/Qwen3.9-27B', true), source('https://openrouter.ai/x-ai/grok-4.7')];
    assert.equal(storyUrl(sources)?.href, 'https://openrouter.ai/x-ai/grok-4.7');
    assert.equal(storyUrl([source('ftp://example.com/release')]), null);
    assert.equal(storyUrl([]), null, 'the demo has no sources');
  });
});

describe('newsLinks', () => {
  const opus = { hero: 'Claude Opus 5.5', sources: [source('https://www.anthropic.com/claude-opus-5-5', true)] };
  const gemini = { hero: 'Gemini 3.8 Live', sources: [source('https://blog.google/gemini-3-8-live', true)] };

  it('names the site in an opening, and each story by its hero in a morning digest', () => {
    assert.deepEqual(newsLinks([opus]), [{ label: 'anthropic.com', url: 'https://www.anthropic.com/claude-opus-5-5' }]);
    assert.deepEqual(
      newsLinks([opus, gemini]).map((link) => link.label),
      ['Claude Opus 5.5', 'Gemini 3.8 Live'],
    );
  });

  it('names a story without a hero by its site, and leaves out a story without a page', () => {
    const demo = { hero: 'Claude Opus 5.5', sources: [] };
    assert.deepEqual(
      newsLinks([{ ...opus, hero: null }, gemini, demo]).map((link) => link.label),
      ['anthropic.com', 'Gemini 3.8 Live'],
    );
    assert.deepEqual(newsLinks([demo]), []);
  });
});

describe('a gallery', () => {
  it('shows the games of a list as a slideshow, a picture each with its name, in place of the story’s picture', () => {
    const message = crowRichMessage({
      text: '🐦‍⬛🐦‍⬛ PS Plus на жовтень.',
      photos: ['file-id'],
      gallery: [
        { url: 'https://blog.playstation.com/silksong.jpg', caption: 'Hollow Knight: Silksong' },
        { url: 'https://blog.playstation.com/stray.jpg', caption: 'Stray' },
      ],
      table: gamesTable([
        { title: 'Hollow Knight: Silksong', platforms: 'PS5, PS4', image: null },
        { title: 'Stray', platforms: 'PS5', image: null },
      ]).table,
    });
    const [slideshow] = message.blocks ?? [];
    assert.deepEqual(slideshow, {
      type: 'slideshow',
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: 'https://blog.playstation.com/silksong.jpg' }, caption: { text: 'Hollow Knight: Silksong' } },
        { type: 'photo', photo: { type: 'photo', media: 'https://blog.playstation.com/stray.jpg' }, caption: { text: 'Stray' } },
      ],
    });
    assert.equal(message.blocks?.filter((block) => block.type === 'photo').length, 0, 'no picture of its own besides');
  });

  it('lists the games of a list whole, with their platforms when it names them', () => {
    assert.deepEqual(gamesTable([{ title: 'SWORN', platforms: '', image: null }]), { table: { header: ['Гра'], rows: [['SWORN']] }, anchors: {} });
    assert.deepEqual(gamesTable([{ title: 'Stray', platforms: 'PS5', image: null }]).table.header, ['Гра', 'Платформи']);
  });

  it('links a giveaway’s games to the store and shows the price before struck out and the one now in bold, none for a free game', () => {
    const { table, anchors } = gamesTable([
      { title: 'Astrea', platforms: 'PC', image: null, url: 'https://store.epicgames.com/en-US/p/astrea', price: { was: '459 ₴', now: '0 ₴' } },
      { title: 'Fortnite', platforms: 'PC', image: null, url: 'https://store.epicgames.com/en-US/p/fortnite', price: null },
    ]);
    assert.deepEqual(table, {
      header: ['Гра', 'Платформи', 'Ціна'],
      rows: [
        ['{link:g1}', 'PC', '~~459 ₴~~ **0 ₴**'],
        ['{link:g2}', 'PC', ''],
      ],
    });
    const message = crowRichMessage({ text: '🐦‍⬛ Халява.', table, anchors });
    const cells = message.blocks?.find((block) => block.type === 'table')?.cells ?? [];
    assert.deepEqual(cells[1][0].text, { type: 'url', text: 'Astrea', url: 'https://store.epicgames.com/en-US/p/astrea' });
    assert.deepEqual(cells[1][2], {
      text: [{ type: 'strikethrough', text: '459 ₴' }, ' ', { type: 'bold', text: '0 ₴' }],
      align: 'right',
      valign: 'middle',
      is_header: undefined,
    });
  });
});
