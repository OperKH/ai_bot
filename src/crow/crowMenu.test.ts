import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOLDNESS } from './cadence';
import { CATEGORIES } from './categories';
import {
  budgetAlertText,
  durationLabel,
  type MenuSettings,
  menuKeyboard,
  menuText,
  ownerKeyboard,
  nextBoldness,
  nextQuietHours,
  OpenMenus,
  parseCrowCallback,
  shooKeyboard,
  shooOutcome,
  snoozeLeft,
} from './crowMenu';

const NOW = new Date('2026-09-26T12:00:00Z');

const settings = (patch: Partial<MenuSettings> = {}): MenuSettings => ({
  subscriptions: new Set(['ai-enterprise']),
  timeZone: 'Europe/Kyiv',
  boldness: 'bold',
  quietFrom: 1380,
  quietTo: 600,
  snoozedUntil: null,
  settingsAdminOnly: false,
  personalJabs: true,
  optedOut: false,
  ...patch,
});

type Button = { text: string; callback_data?: string; style?: string };
const buttons = (keyboard: { inline_keyboard: Button[][] }) => keyboard.inline_keyboard.flat();

describe('parseCrowCallback', () => {
  it('reads the menu buttons', () => {
    assert.deepEqual(parseCrowCallback('crow:sub:gta6'), { type: 'sub', categoryId: 'gta6' });
    assert.deepEqual(parseCrowCallback('crow:bold'), { type: 'bold' });
    assert.deepEqual(parseCrowCallback('crow:quiet'), { type: 'quiet' });
    assert.deepEqual(parseCrowCallback('crow:snooze'), { type: 'snooze' });
    assert.deepEqual(parseCrowCallback('crow:lock'), { type: 'lock' });
    assert.deepEqual(parseCrowCallback('crow:shoo:42'), { type: 'shoo', postId: 42 });
    assert.deepEqual(parseCrowCallback('crow:tz'), { type: 'timezone' });
    assert.deepEqual(parseCrowCallback('crow:owner:reset'), { type: 'reset-budget' });
    assert.deepEqual(parseCrowCallback('crow:owner:run'), { type: 'run-pipeline' });
    assert.deepEqual(parseCrowCallback('crow:jabs'), { type: 'jabs' });
    assert.deepEqual(parseCrowCallback('crow:me'), { type: 'optout' });
    assert.deepEqual(parseCrowCallback('crow:sub:ai-homebrew'), { type: 'sub', categoryId: 'ai-homebrew' });
  });

  it('rejects unknown categories and malformed data', () => {
    assert.equal(parseCrowCallback('crow:sub:neuroslop'), null);
    assert.equal(parseCrowCallback('crow:sub'), null);
    assert.equal(parseCrowCallback('crow:shoo:x'), null);
    assert.equal(parseCrowCallback('crow:bold:1'), null);
    assert.equal(parseCrowCallback('crow:owner:delete'), null);
    assert.equal(parseCrowCallback('crow:tz:1'), null);
    assert.equal(parseCrowCallback('islm-5'), null);
  });

  it('reads back the data of every button the crow draws', () => {
    const all = [
      ...buttons(menuKeyboard(settings(), NOW, true)),
      ...buttons(shooKeyboard(123456789)),
    ];
    for (const button of all) {
      assert.ok(button.callback_data, button.text);
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
      assert.notEqual(parseCrowCallback(button.callback_data), null, button.callback_data);
    }
  });
});

describe('menuKeyboard', () => {
  it('has a button per category, green when subscribed', () => {
    const categoryButtons = buttons(menuKeyboard(settings(), NOW, false)).filter((b) =>
      b.callback_data?.startsWith('crow:sub:'),
    );
    assert.equal(categoryButtons.length, CATEGORIES.length);
    const [aiEnterprise, homebrew] = categoryButtons;
    assert.match(aiEnterprise.text, /^✅ 🤖 AI Enterprise — флагманські моделі$/);
    assert.equal(aiEnterprise.style, 'success');
    assert.equal(homebrew.text, '⬜ 🦙 AI Homebrew — відкриті моделі');
    assert.equal(homebrew.style, undefined);
  });

  it('switches the jabs for the chat, and lets the cat who opened the menu opt out', () => {
    const text = (patch: Partial<MenuSettings>, data: string) =>
      buttons(menuKeyboard(settings(patch), NOW, false)).find((b) => b.callback_data === data)?.text;
    assert.equal(text({}, 'crow:jabs'), '🎯 Підколки: увімк.');
    assert.equal(text({ personalJabs: false }, 'crow:jabs'), '🎯 Підколки: вимк.');
    assert.equal(text({}, 'crow:me'), '🙅 Не чіпай мене');
    assert.equal(text({ optedOut: true }, 'crow:me'), '🙋 Можна мене чіпати');
  });

  it('shows the lock to admins only', () => {
    const hasLock = (isAdmin: boolean) =>
      buttons(menuKeyboard(settings(), NOW, isAdmin)).some((b) => b.callback_data === 'crow:lock');
    assert.equal(hasLock(true), true);
    assert.equal(hasLock(false), false);
  });

  it('shows the boldness as crows, the way the prototype drew it', () => {
    const bold = (boldness: MenuSettings['boldness']) =>
      buttons(menuKeyboard(settings({ boldness }), NOW, false)).find((b) => b.callback_data === 'crow:bold')?.text;
    assert.equal(bold('restrained'), '😈 Наглість: 🐦‍⬛ Стримана');
    assert.equal(bold('bold'), '😈 Наглість: 🐦‍⬛🐦‍⬛ Нагла');
    assert.equal(bold('pestering'), '😈 Наглість: 🐦‍⬛🐦‍⬛🐦‍⬛ Заєбуча');
    // Half a row cut «Заєбуча» off
    const row = menuKeyboard(settings({ boldness: 'pestering' }), NOW, false).inline_keyboard.find((r) =>
      r.some((b) => 'callback_data' in b && b.callback_data === 'crow:bold'),
    );
    assert.equal(row?.length, 1);
  });

  it('offers to end the silence while snoozed', () => {
    const snooze = (snoozedUntil: Date | null) =>
      buttons(menuKeyboard(settings({ snoozedUntil }), NOW, false)).find((b) => b.callback_data === 'crow:snooze')
        ?.text;
    assert.equal(snooze(null), '🔇 Заткнись на 3 год');
    assert.equal(snooze(new Date(NOW.getTime() + 60_000)), '🔊 Досить мовчати');
  });

  it('offers to set the chat’s zone while the quiet hours run on UTC', () => {
    const zoneButton = (patch: Partial<MenuSettings>) =>
      buttons(menuKeyboard(settings(patch), NOW, false)).find((b) => b.callback_data === 'crow:tz');
    const quietButton = (patch: Partial<MenuSettings>) =>
      buttons(menuKeyboard(settings(patch), NOW, false)).find((b) => b.callback_data === 'crow:quiet')?.text;
    assert.ok(zoneButton({ timeZone: null }));
    assert.equal(quietButton({ timeZone: null }), '🌙 Тиша: 23:00–10:00 UTC');
    assert.equal(zoneButton({ timeZone: 'Europe/Kyiv' }), undefined);
    assert.equal(quietButton({ timeZone: 'Europe/Kyiv' }), '🌙 Тиша: 23:00–10:00 Київ', 'the city of the chat’s zone');
    assert.equal(quietButton({ timeZone: 'Pacific/Tahiti' }), '🌙 Тиша: 23:00–10:00 Tahiti');
    assert.equal(quietButton({ timeZone: null, quietFrom: null, quietTo: null }), '🌙 Тиша: вимк.');
    assert.equal(zoneButton({ timeZone: null, quietFrom: null, quietTo: null }), undefined, 'no quiet hours, nothing to count');
  });

  it('names the GTA VI category after its phase', () => {
    const gta = (now: Date) =>
      buttons(menuKeyboard(settings(), now, false)).find((b) => b.callback_data === 'crow:sub:gta6')?.text;
    assert.match(gta(NOW)!, /відлік до 19\.11$/);
    assert.match(gta(new Date('2026-11-19T10:00:00Z'))!, /таємниці та пасхалки$/);
  });
});

describe('shooOutcome', () => {
  const press = (count: number, needed: 2 | 3, added = true, silent = false) =>
    shooOutcome({ added, count, needed, silent });

  it('sends the crow away with two cats, and with three when she is pestering', () => {
    assert.equal(BOLDNESS.restrained.shooCats, 2);
    assert.equal(BOLDNESS.bold.shooCats, 2);
    assert.equal(BOLDNESS.pestering.shooCats, 3);
    assert.deepEqual(press(1, 2), { toast: '🔇 Кш? Ще один кіт — і я замовкну на годину.', goAway: false });
    assert.deepEqual(press(2, 2), { toast: '🐦‍⬛ Та мовчу вже, мовчу.', goAway: true });
    assert.deepEqual(press(1, 3), { toast: '🔇 Кш? Ще двоє котів — і я замовкну на годину.', goAway: false });
    assert.deepEqual(press(2, 3), { toast: '🔇 Кш? Ще один кіт — і я замовкну на годину.', goAway: false });
    assert.equal(press(3, 3).goAway, true);
  });

  it('tells a cat who pressed before how many cats are still wanted', () => {
    assert.deepEqual(press(1, 3, false), { toast: '🐦‍⬛ Ти вже натискав «Кш!». Треба ще двоє котів.', goAway: false });
    assert.deepEqual(press(2, 3, false), { toast: '🐦‍⬛ Ти вже натискав «Кш!». Треба ще один кіт.', goAway: false });
    assert.deepEqual(press(2, 2, false), { toast: '🐦‍⬛ Та мовчу вже, мовчу.', goAway: false });
  });

  it('does not send away again a crow that keeps quiet already', () => {
    assert.equal(press(3, 2, true, true).goAway, false, 'a third cat after the two who sent her away');
    assert.equal(press(2, 2, true, true).goAway, false, 'two cats while «Заткнись» holds');
    // More cats than wanted, but the hour of the last «Кш!» is over: they send her away again
    assert.equal(press(3, 2).goAway, true);
  });
});

describe('menuText', () => {
  it('tells how long the crow keeps quiet and that the menu is read-only', () => {
    const text = menuText(settings({ snoozedUntil: new Date(NOW.getTime() + 135 * 60_000) }), NOW, true);
    assert.match(text, /Мовчу ще 2 год 15 хв/);
    assert.match(text, /тільки адмін/);
  });

  it('says the quiet hours run on UTC while the chat has no zone', () => {
    assert.match(menuText(settings({ timeZone: null }), NOW, false), /не задано, тож тиша рахується за UTC/);
    assert.doesNotMatch(menuText(settings(), NOW, false), /UTC/);
  });
});

describe('the owner’s alerts', () => {
  const report = {
    limitUsd: 1,
    spentUsd: 1.0234,
    waiting: [
      { title: 'Anthropic Releases Claude Fable 5.1', since: new Date(NOW.getTime() - 2 * 3_600_000) },
      { title: 'xAI Releases Grok 4.7', since: new Date(NOW.getTime() - 5 * 60_000) },
    ],
    plannedPosts: 21,
  };

  it('tell what was spent, what waits for money and what goes on anyway', () => {
    const text = budgetAlertText(report, NOW);
    assert.match(text, /^💸 /);
    assert.match(text, /\$1\.02 з \$1\.00/);
    assert.match(text, /з нового дня за UTC, за 12 год/);
    assert.match(text, /Чекають на запис \(2\)/);
    assert.match(text, /• Anthropic Releases Claude Fable 5\.1 — 2 год/);
    assert.match(text, /• xAI Releases Grok 4\.7 — 5 хв/);
    assert.match(text, /21 пост уже написаних арок/);
    assert.doesNotMatch(budgetAlertText({ ...report, waiting: [] }, NOW), /Чекають/);
  });

  it('declines the posts', () => {
    const planned = (plannedPosts: number) => /У чатах (\d+ \S+)/.exec(budgetAlertText({ ...report, plannedPosts }, NOW))![1];
    assert.equal(planned(1), '1 пост');
    assert.equal(planned(3), '3 пости');
    assert.equal(planned(12), '12 постів');
    assert.equal(planned(25), '25 постів');
  });

  it('offer the budget reset under a budget alert only', () => {
    const data = (withReset: boolean) => buttons(ownerKeyboard(withReset)).map((b) => b.callback_data);
    assert.deepEqual(data(true), ['crow:owner:reset', 'crow:owner:run']);
    assert.deepEqual(data(false), ['crow:owner:run']);
    for (const callback of data(true)) assert.notEqual(parseCrowCallback(callback!), null);
  });

  it('round how long a story has waited', () => {
    assert.equal(durationLabel(20_000), '1 хв');
    assert.equal(durationLabel(90 * 60_000), '2 год');
    assert.equal(durationLabel(3 * 24 * 3_600_000), '3 дн');
  });
});

describe('menu steps', () => {
  it('steps the boldness around', () => {
    assert.equal(nextBoldness('restrained'), 'bold');
    assert.equal(nextBoldness('bold'), 'pestering');
    assert.equal(nextBoldness('pestering'), 'restrained');
  });

  it('steps the quiet hours through the presets, from unknown ones to the first', () => {
    assert.deepEqual(nextQuietHours(1380, 600), [null, null]);
    assert.deepEqual(nextQuietHours(null, null), [1380, 600]);
    assert.deepEqual(nextQuietHours(1410, 540), [1380, 600], 'the old default steps into the preset');
    assert.deepEqual(nextQuietHours(60, 120), [1380, 600]);
  });

  it('writes what is left of a snooze as a duration', () => {
    assert.equal(snoozeLeft(null, NOW), null);
    assert.equal(snoozeLeft(new Date(NOW.getTime() - 1), NOW), null);
    assert.equal(snoozeLeft(new Date(NOW.getTime() + 3 * 3_600_000), NOW), '3 год');
    assert.equal(snoozeLeft(new Date(NOW.getTime() + 30_000), NOW), '1 хв');
  });
});

describe('OpenMenus', () => {
  const first = { ephemeral: true, id: 11 };
  const second = { ephemeral: true, id: 12 };

  it('hands back the menu a new /crow replaces, and marks it stale', () => {
    const menus = new OpenMenus();
    assert.equal(menus.opened(-100, 7, first), undefined);
    assert.deepEqual(menus.opened(-100, 7, second), first);
    assert.equal(menus.isReplaced(-100, first), true);
    assert.equal(menus.isReplaced(-100, second), false);
  });

  it('keeps the menus of each cat and each chat apart', () => {
    const menus = new OpenMenus();
    menus.opened(-100, 7, first);
    assert.equal(menus.opened(-100, 8, second), undefined, 'another cat');
    assert.equal(menus.opened(-200, 7, second), undefined, 'another chat');
    assert.equal(menus.isReplaced(-200, first), false);
  });

  it('takes a menu pressed after a restart as the open one, so the next /crow replaces it', () => {
    const menus = new OpenMenus();
    menus.pressed(-100, 7, first);
    assert.deepEqual(menus.opened(-100, 7, second), first);
  });

  it('does not reopen a replaced menu by a press, nor take a fallback menu in the chat as a cat’s own', () => {
    const menus = new OpenMenus();
    menus.opened(-100, 7, first);
    menus.opened(-100, 7, second);
    menus.pressed(-100, 7, first);
    assert.equal(menus.opened(-100, 7, { ephemeral: true, id: 13 })?.id, 12);
    menus.pressed(-100, 9, { ephemeral: false, id: 50 });
    assert.equal(menus.opened(-100, 9, first), undefined);
  });

  it('forgets the oldest replaced menus past its limit', () => {
    const menus = new OpenMenus(2);
    for (let id = 1; id <= 4; id++) menus.opened(-100, 7, { ephemeral: true, id });
    assert.equal(menus.isReplaced(-100, { ephemeral: true, id: 1 }), false);
    assert.equal(menus.isReplaced(-100, { ephemeral: true, id: 3 }), true);
  });
});
