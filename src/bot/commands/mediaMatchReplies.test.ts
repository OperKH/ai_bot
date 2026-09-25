import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaMatch } from '../../dataSource/vectorSearch';
import {
  MatchReplyPort,
  MorePressPort,
  parseMoreCallback,
  PressedSearch,
  pressMore,
  replyWithDuplicates,
  showSearchPage,
} from './mediaMatchReplies';

type Sent = { id: number; text: string; replyTo?: number; attached?: boolean };

/** A chat where replies to `deleted` messages arrive unattached, as Telegram does for deleted ones */
class FakeChat implements MatchReplyPort {
  readonly deleted = new Set<string>();
  readonly sent: Sent[] = [];
  readonly takenBack = new Set<number>();
  readonly forgotten: string[] = [];
  readonly buttons = new Map<number, string>();
  failFor = new Set<string>();
  private nextId = 5000;

  async send(text: string, replyToId?: number) {
    const id = this.nextId++;
    this.sent.push({ id, text, replyTo: replyToId });
    return id;
  }

  async replyToEarlier(replyToId: number, text: string, moreCallbackData?: string) {
    if (this.failFor.has(String(replyToId))) throw new Error('Bad Request');
    const id = this.nextId++;
    const attached = !this.deleted.has(String(replyToId));
    this.sent.push({ id, text, replyTo: replyToId, attached });
    if (moreCallbackData !== undefined) this.buttons.set(id, moreCallbackData);
    return { messageId: id, attached };
  }

  /** A deleted message takes its button along */
  async delete(messageId: number) {
    this.takenBack.add(messageId);
    this.buttons.delete(messageId);
  }

  async forget(messageId: string) {
    this.forgotten.push(messageId);
  }

  /** What stays in the chat: sent and not taken back */
  visible() {
    return this.sent.filter((m) => !this.takenBack.has(m.id));
  }

  /** Ids of the earlier messages the visible replies point at */
  shownMatches() {
    return this.visible()
      .filter((m) => m.attached)
      .map((m) => String(m.replyTo));
  }
}

/** `count` matches, best first, the way the SQL orders them (similarity DESC, messageId DESC) */
const ranking = (count: number, similarity = (i: number) => 0.5 - i * 0.01): MediaMatch[] =>
  Array.from({ length: count }, (_, i) => ({ messageId: String(1000 - i), similarity: similarity(i) }));

/** The keyset query over `matches`: strictly after the cursor, without messages the chat forgot */
const finder = (matches: MediaMatch[], chat: FakeChat) => {
  const calls: { cursor: MediaMatch | null; count: number }[] = [];
  const find = async (cursor: MediaMatch | null, count: number) => {
    calls.push({ cursor, count });
    return matches
      .filter((m) => !chat.forgotten.includes(m.messageId))
      .filter(
        (m) =>
          cursor === null ||
          m.similarity < cursor.similarity ||
          (m.similarity === cursor.similarity && BigInt(m.messageId) < BigInt(cursor.messageId)),
      )
      .slice(0, count);
  };
  return { find, calls };
};

describe('replyWithDuplicates', () => {
  it('sends nothing without matches', async () => {
    const chat = new FakeChat();
    await replyWithDuplicates(chat, 777, [], 3);
    assert.deepEqual(chat.sent, []);
  });

  it('replies to the best matches under a header, up to the limit', async () => {
    const chat = new FakeChat();
    await replyWithDuplicates(
      chat,
      777,
      ranking(5, () => 0.975),
      3,
    );

    const [header, ...replies] = chat.visible();
    assert.equal(header.replyTo, 777);
    assert.match(header.text, /Здається, я це вже десь бачив/);
    assert.deepEqual(chat.shownMatches(), ['1000', '999', '998']);
    assert.deepEqual(
      replies.map((r) => r.text),
      ['ось тут (97.5%)', 'ще тут (97.5%)', 'і ось (97.5%)'],
    );
  });

  it('drops deleted matches and fills their places from the next ones', async () => {
    const chat = new FakeChat();
    chat.deleted.add('1000').add('998');
    await replyWithDuplicates(chat, 777, ranking(6), 3);

    assert.deepEqual(chat.shownMatches(), ['999', '997', '996']);
    assert.deepEqual(chat.forgotten, ['1000', '998']);
    // The stray replies to the deleted ones are gone, the header stays
    assert.equal(chat.visible().filter((m) => m.attached === false).length, 0);
    assert.equal(chat.visible()[0].replyTo, 777);
    // Variants count the replies that stayed
    assert.match(chat.visible()[1].text, /^ось тут /);
  });

  it('takes the header back when every match is deleted', async () => {
    const chat = new FakeChat();
    chat.deleted.add('1000').add('999');
    await replyWithDuplicates(chat, 777, ranking(2), 3);

    assert.deepEqual(chat.visible(), []);
    assert.deepEqual(chat.forgotten, ['1000', '999']);
  });
});

describe('showSearchPage', () => {
  /** Shows one page of search 7 over `matches`; returns where it stopped and the queries made */
  const page = async (
    chat: FakeChat,
    matches: MediaMatch[],
    extra: { cursor?: MediaMatch | null; firstMessageId?: number } = {},
  ) => {
    const { find, calls } = finder(matches, chat);
    const end = await showSearchPage(chat, {
      text: 'кіт',
      cursor: extra.cursor ?? null,
      firstMessageId: extra.firstMessageId,
      limit: 3,
      searchId: 7,
      find,
    });
    return { ...end, calls };
  };

  it('first page: a header, the results, and the button on the last one', async () => {
    const chat = new FakeChat();
    const matches = ranking(10);
    const { cursor, buttonMessageId, calls } = await page(chat, matches, { firstMessageId: 42 });

    const [header, ...results] = chat.visible();
    assert.equal(header.replyTo, 42);
    assert.match(header.text, /Ось, що мені вдалось знайти/);
    assert.deepEqual(chat.shownMatches(), ['1000', '999', '998']);
    assert.equal(results[0].text, 'кіт (0.5000)');
    assert.deepEqual([...chat.buttons], [[results[2].id, 'islm-7']]);
    assert.equal(buttonMessageId, results[2].id);
    assert.deepEqual(cursor, matches[2]);
    // One more than the page tells whether a next page exists
    assert.deepEqual(calls, [{ cursor: null, count: 4 }]);
  });

  it('next page: continues after the cursor, without a header', async () => {
    const chat = new FakeChat();
    const matches = ranking(10);
    const { cursor } = await page(chat, matches, { cursor: matches[2] });

    assert.deepEqual(chat.shownMatches(), ['997', '996', '995']);
    assert.equal(chat.visible().length, 3);
    assert.deepEqual(cursor, matches[5]);
  });

  it('fills the page from further down when results turn out deleted', async () => {
    const chat = new FakeChat();
    chat.deleted.add('999');
    const matches = ranking(10);
    const { cursor, buttonMessageId, calls } = await page(chat, matches);

    assert.deepEqual(chat.shownMatches(), ['1000', '998', '997']);
    assert.deepEqual(chat.forgotten, ['999']);
    assert.deepEqual(calls, [
      { cursor: null, count: 4 },
      { cursor: matches[2], count: 2 },
    ]);
    // The button goes on the last result shown, the cursor past it
    const lastShown = chat.visible().at(-1)!;
    assert.equal(lastShown.replyTo, 997);
    assert.deepEqual([...chat.buttons], [[lastShown.id, 'islm-7']]);
    assert.equal(buttonMessageId, lastShown.id);
    assert.deepEqual(cursor, matches[3]);
  });

  it('takes the button back with a stray last result and gives it to the one that fills the page', async () => {
    const chat = new FakeChat();
    chat.deleted.add('998');
    const { buttonMessageId } = await page(chat, ranking(10));

    assert.deepEqual(chat.shownMatches(), ['1000', '999', '997']);
    const lastShown = chat.visible().at(-1)!;
    assert.equal(lastShown.replyTo, 997);
    assert.deepEqual([...chat.buttons], [[lastShown.id, 'islm-7']]);
    assert.equal(buttonMessageId, lastShown.id);
  });

  it('last page: says it is over, no button', async () => {
    const chat = new FakeChat();
    const matches = ranking(5);
    const { cursor, buttonMessageId } = await page(chat, matches, { cursor: matches[2] });

    assert.deepEqual(chat.shownMatches(), ['997', '996']);
    assert.equal(chat.visible().at(-1)!.text, '💃 Це все!');
    assert.equal(chat.buttons.size, 0);
    assert.equal(buttonMessageId, null);
    assert.deepEqual(cursor, matches[4]);
  });

  it('a full last page: says it is over, no button', async () => {
    const chat = new FakeChat();
    const matches = ranking(6);
    const { buttonMessageId } = await page(chat, matches, { cursor: matches[2] });

    assert.deepEqual(chat.shownMatches(), ['997', '996', '995']);
    assert.equal(chat.visible().at(-1)!.text, '💃 Це все!');
    assert.equal(chat.buttons.size, 0);
    assert.equal(buttonMessageId, null);
  });

  it('nothing found: answers the command', async () => {
    const chat = new FakeChat();
    const { cursor } = await page(chat, [], { firstMessageId: 42 });

    assert.deepEqual(chat.visible(), [{ id: 5000, text: '🤷‍♂️ Нічого нема.', replyTo: 42 }]);
    assert.equal(cursor, null);
  });

  it('first page of deleted results only: takes the header back and says nothing was found', async () => {
    const chat = new FakeChat();
    chat.deleted.add('1000').add('999');
    await page(chat, ranking(2), { firstMessageId: 42 });

    assert.deepEqual(
      chat.visible().map((m) => m.text),
      ['🤷‍♂️ Нічого нема.'],
    );
    assert.deepEqual(chat.forgotten, ['1000', '999']);
  });

  it('a later page of deleted results only: says it is over', async () => {
    const chat = new FakeChat();
    chat.deleted.add('997');
    const matches = ranking(4);
    await page(chat, matches, { cursor: matches[2] });

    assert.deepEqual(
      chat.visible().map((m) => m.text),
      ['💃 Це все!'],
    );
  });

  it('skips a result whose reply fails and carries on', async (t) => {
    t.mock.method(console, 'log', () => {});
    const chat = new FakeChat();
    chat.failFor.add('999');
    const matches = ranking(10);
    const { cursor } = await page(chat, matches);

    assert.deepEqual(chat.shownMatches(), ['1000', '998', '997']);
    assert.deepEqual(chat.forgotten, []);
    assert.deepEqual(cursor, matches[3]);
  });

  it('walking every page shows each result once, in ranking order, even with equal scores', async () => {
    const chat = new FakeChat();
    // Reposts score exactly the same: groups of four equal similarities
    const matches = ranking(20, (i) => 0.5 - Math.floor(i / 4) * 0.01);
    chat.deleted.add('998').add('993').add('985');
    const { find } = finder(matches, chat);

    let cursor: MediaMatch | null = null;
    for (let pages = 0; pages < 10; pages++) {
      chat.buttons.clear();
      const end = await showSearchPage(chat, { text: 'кіт', cursor, limit: 3, searchId: 7, find });
      // The one button of the page is on the reply it reports
      assert.deepEqual([...chat.buttons.keys()], end.buttonMessageId === null ? [] : [end.buttonMessageId]);
      cursor = end.cursor;
      if (end.buttonMessageId === null) break;
    }

    const expected = matches.map((m) => m.messageId).filter((id) => !chat.deleted.has(id));
    assert.deepEqual(chat.shownMatches(), expected);
  });
});

describe('parseMoreCallback', () => {
  it('reads the search id', () => {
    assert.equal(parseMoreCallback('islm-42'), 42);
  });

  it('rejects the JSON payload of buttons from before searches were stored', () => {
    assert.equal(parseMoreCallback('islm-{"t":"кіт","o":3}'), null);
  });

  it('rejects anything else', () => {
    assert.equal(parseMoreCallback('himp-r'), null);
    assert.equal(parseMoreCallback('islm-'), null);
  });
});

/** A search in the store, and a chat that logs what a press on its button did, in order */
class FakePress implements MorePressPort<PressedSearch> {
  readonly log: string[] = [];
  readonly search: PressedSearch = { buttonMessageId: '100' };

  async answer(text?: string) {
    this.log.push(text === undefined ? 'answer' : `answer: ${text}`);
  }

  async removeKeyboard() {
    this.log.push('removeKeyboard');
  }

  async releaseButton(search: PressedSearch) {
    search.buttonMessageId = null;
    this.log.push('releaseButton');
  }

  showNextPage() {
    this.log.push('showNextPage');
  }
}

describe('pressMore', () => {
  const EXPIRED = '🙈 Цей пошук застарів';

  it('takes the button off before the next page goes out, and releases it first', async () => {
    const chat = new FakePress();
    await pressMore(chat, chat.search, 100, EXPIRED);
    assert.deepEqual(chat.log, ['answer', 'removeKeyboard', 'releaseButton', 'showNextPage']);
    assert.equal(chat.search.buttonMessageId, null);
  });

  it('shows one page for a double tap on the same button', async () => {
    const chat = new FakePress();
    // The second tap is handled once the first one has handed its page over
    await pressMore(chat, chat.search, 100, EXPIRED);
    await pressMore(chat, chat.search, 100, EXPIRED);
    assert.equal(chat.log.filter((step) => step === 'showNextPage').length, 1);
    assert.deepEqual(chat.log.slice(4), ['answer', 'removeKeyboard'], 'the second tap only loses its keyboard');
  });

  it('ignores a button from an earlier page of the search', async () => {
    const chat = new FakePress();
    chat.search.buttonMessageId = '200';
    await pressMore(chat, chat.search, 100, EXPIRED);
    assert.deepEqual(chat.log, ['answer', 'removeKeyboard']);
    assert.equal(chat.search.buttonMessageId, '200', 'the live button stays live');
  });

  it('tells that a search is gone and takes its button off', async () => {
    const chat = new FakePress();
    await pressMore(chat, null, 100, EXPIRED);
    assert.deepEqual(chat.log, [`answer: ${EXPIRED}`, 'removeKeyboard']);
  });
});
