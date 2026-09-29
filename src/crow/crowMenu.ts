import { InlineKeyboard } from 'grammy';
import type { CrowBoldness } from '../entity/CrowChat.entity';
import { BOLDNESS, BOLDNESS_ORDER, type ShooCats } from './cadence';
import { CATEGORIES, type CategoryId, categoryLabel, findCategory } from './categories';
import { formatMinutes } from './chatClock';
import { nextBudgetDay } from './budget';
import type { BudgetReport } from './pipeline';
import { OPENAI_BILLING_URL } from '../bot/ownerAlerts';
import { zoneLabel } from '../bot/commands/timeZones';
import { clip, plural } from './words';

/** A button of the crow: the `/crow` menu, or «Кш!» under a post */
export type CrowAction =
  | { type: 'sub'; categoryId: CategoryId }
  | { type: 'bold' }
  | { type: 'quiet' }
  | { type: 'snooze' }
  | { type: 'lock' }
  | { type: 'timezone' }
  // «🎯 Підколки» for the chat, and the caller's own «🙅 Не чіпай мене»
  | { type: 'jabs' }
  | { type: 'optout' }
  | { type: 'shoo'; postId: number }
  // The owner's buttons under a budget or balance alert, in the private chat with the bot
  | { type: 'reset-budget' }
  | { type: 'run-pipeline' }
  // The owner says how an unclear bet ended: an option, or null to call it off
  | { type: 'bet-outcome'; pollId: number; outcome: number | null };

/** The action behind `callback_data` of a crow button, or null for anything else */
export function parseCrowCallback(data: string): CrowAction | null {
  const match = /^crow:([a-z]+)(?::([\w-]+))?(?::([\w-]+))?$/.exec(data);
  if (!match) return null;
  const [, type, arg, second] = match;
  if (type === 'bet') {
    if (arg === undefined || !/^\d+$/.test(arg) || second === undefined || !/^(\d|x)$/.test(second)) return null;
    return { type: 'bet-outcome', pollId: Number(arg), outcome: second === 'x' ? null : Number(second) };
  }
  if (second !== undefined) return null;
  if (type === 'sub') {
    const category = arg === undefined ? undefined : findCategory(arg);
    return category ? { type: 'sub', categoryId: category.id } : null;
  }
  if (type === 'shoo') return arg !== undefined && /^\d+$/.test(arg) ? { type: 'shoo', postId: Number(arg) } : null;
  if (type === 'owner') return arg === 'reset' ? { type: 'reset-budget' } : arg === 'run' ? { type: 'run-pipeline' } : null;
  if (arg !== undefined) return null;
  if (type === 'bold' || type === 'quiet' || type === 'snooze' || type === 'lock' || type === 'jabs') return { type };
  if (type === 'tz') return { type: 'timezone' };
  if (type === 'me') return { type: 'optout' };
  return null;
}

/** The «Кш!» button under a post */
export function shooKeyboard(postId: number): InlineKeyboard {
  return new InlineKeyboard().text({ text: '🔇 Кш!', style: 'danger' }, `crow:shoo:${postId}`);
}

/** What the menu shows */
export interface MenuSettings {
  subscriptions: ReadonlySet<string>;
  /** Set with /timezone; null — none, so the quiet hours are UTC */
  timeZone: string | null;
  boldness: CrowBoldness;
  quietFrom: number | null;
  quietTo: number | null;
  snoozedUntil: Date | null;
  settingsAdminOnly: boolean;
  /** The crow may jab the cats by name */
  personalJabs: boolean;
  /** The cat who opened the menu pressed «🙅 Не чіпай мене» */
  optedOut: boolean;
}

export type QuietHours = readonly [from: number | null, to: number | null];

/** The quiet hours the button switches between: 23:00–10:00, the default, and none */
export const QUIET_PRESETS: readonly QuietHours[] = [
  [1380, 600],
  [null, null],
];

export function nextQuietHours(from: number | null, to: number | null): QuietHours {
  const index = QUIET_PRESETS.findIndex(([f, t]) => f === from && t === to);
  return QUIET_PRESETS[(index + 1) % QUIET_PRESETS.length];
}

export function nextBoldness(boldness: CrowBoldness): CrowBoldness {
  return BOLDNESS_ORDER[(BOLDNESS_ORDER.indexOf(boldness) + 1) % BOLDNESS_ORDER.length];
}

export function quietLabel(from: number | null, to: number | null): string {
  return from === null || to === null ? 'вимк.' : `${formatMinutes(from)}–${formatMinutes(to)}`;
}

/**
 * How long the crow still keeps quiet, as «2 год 15 хв», or null if it does not.
 * A duration rather than a time of day: the readers may live in different zones.
 */
export function snoozeLeft(snoozedUntil: Date | null, now: Date): string | null {
  if (!snoozedUntil || snoozedUntil <= now) return null;
  const minutes = Math.ceil((snoozedUntil.getTime() - now.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours > 0 ? `${hours} год` : '', rest > 0 ? `${rest} хв` : ''].filter(Boolean).join(' ');
}

/** The zone the quiet hours are counted in, as their button shows it: the chat's city, or UTC; none when off */
export const quietZone = (settings: Pick<MenuSettings, 'quietFrom' | 'timeZone'>): string =>
  settings.quietFrom === null ? '' : ` ${settings.timeZone ? zoneLabel(settings.timeZone) : 'UTC'}`;

/** The quiet hours are on while the chat has not said where it lives, so they are counted in UTC */
export const quietInUtc = (settings: Pick<MenuSettings, 'quietFrom' | 'timeZone'>): boolean =>
  settings.quietFrom !== null && settings.timeZone === null;

export function menuText(settings: MenuSettings, now: Date, readOnly: boolean): string {
  const lines = [
    "🐦‍⬛ Кара на зв'язку. Обирайте, про що мені каркати в цьому чаті. Не оберете нічого — сидітиму мовчки й дивитимусь.",
  ];
  const left = snoozeLeft(settings.snoozedUntil, now);
  if (left) lines.push('', `🔇 Мовчу ще ${left}.`);
  if (quietInUtc(settings)) {
    lines.push('', '🌙 Часовий пояс чату не задано, тож тиша рахується за UTC. Задайте його кнопкою нижче або командою /timezone.');
  }
  if (readOnly) lines.push('', '🔒 Підписки тут змінює тільки адмін.');
  return lines.join('\n');
}

/** The menu's buttons; the lock is shown to admins only */
export function menuKeyboard(settings: MenuSettings, now: Date, isAdmin: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of CATEGORIES) {
    const on = settings.subscriptions.has(category.id);
    const text = `${on ? '✅' : '⬜'} ${categoryLabel(category, now)}`;
    keyboard.text(on ? { text, style: 'success' } : text, `crow:sub:${category.id}`).row();
  }
  const boldness = BOLDNESS[settings.boldness];
  keyboard
    // Rows of their own: the level's crows and name overflow half a row, and so do the quiet hours with their zone
    .text(`😈 Наглість: ${'🐦‍⬛'.repeat(boldness.crows)} ${boldness.label}`, 'crow:bold')
    .row()
    .text(snoozeLeft(settings.snoozedUntil, now) ? '🔊 Досить мовчати' : '🔇 Заткнись на 3 год', 'crow:snooze')
    .row()
    .text(`🌙 Тиша: ${quietLabel(settings.quietFrom, settings.quietTo)}${quietZone(settings)}`, 'crow:quiet');
  if (quietInUtc(settings)) keyboard.row().text('🕰 Задати часовий пояс', 'crow:tz');
  keyboard
    .row()
    .text(`🎯 Підколки: ${settings.personalJabs ? 'увімк.' : 'вимк.'}`, 'crow:jabs')
    // The caller's own: the menu is theirs alone
    .text(settings.optedOut ? '🙋 Можна мене чіпати' : '🙅 Не чіпай мене', 'crow:me');
  if (isAdmin) {
    keyboard.row().text(`${settings.settingsAdminOnly ? '🔒' : '🔓'} Тільки адміни змінюють підписки`, 'crow:lock');
  }
  return keyboard;
}

/** Answers to the buttons, shown as toasts (up to 200 characters) */
export const TOASTS = {
  allOff: '🐦‍⬛ Відписались від усього? Я все одно прилітатиму. Просто мовчки. Дивитимусь.',
  boldness: {
    restrained: '🐦‍⬛ Стримана. Каркатиму тихенько. Майже.',
    bold: '😈 Нагла. Звичайний режим, коти.',
    pestering: "😈 Заєбуча. Ви самі натиснули, пам'ятайте це.",
  } satisfies Record<CrowBoldness, string>,
  quietOn: (label: string) => `🌙 Тиша: ${label}. Сплю, коли сплять коти.`,
  quietOnUtc: (label: string) => `🌙 Тиша: ${label} за UTC — часовий пояс чату не задано.`,
  timezonePicker: '🕰 Обери часовий пояс у повідомленні нижче.',
  timezoneCommand: '🕰 Не вийшло показати вибір — напиши в чаті /timezone.',
  ownerOnly: '🔒 Це кнопка власника бота.',
  budgetReset: '🔄 Бюджет на сьогодні скинуто: конвеєр продовжить за 2 хвилини.',
  pipelineRun: '▶️ Конвеєр запуститься за пів хвилини.',
  quietOff: '🌙 Без тиші. Каркатиму й о третій ночі.',
  snoozed: '🔇 Мовчу 3 години. Засікайте.',
  unsnoozed: '🔊 О, скучили? Я знала.',
  jabsOn: '🎯 Підколки увімкнено. Готуйтеся, коти: я все про вас знаю. Ну, про ігри.',
  jabsOff: '🎯 Підколки вимкнено: профіль чату забула, нікого не чіпаю.',
  optedOut: '🙅 Добре, тебе не чіпаю: у профіль не пишу, у підколках не згадую.',
  optedIn: '🙋 О, повернувся. Тепер і тебе підколюватиму.',
  lockOn: '🔒 Тепер підписки змінюють тільки адміни.',
  lockOff: '🔓 Підписки знову змінюють усі.',
  adminOnly: '🔒 Підписки тут змінює тільки адмін. Можу поскаржитись йому на тебе. Безкоштовно.',
  lockAdminOnly: '🔒 Замок вмикає тільки адмін.',
  shooMore: (left: number) => `🔇 Кш? Ще ${moreCats(left)} — і я замовкну на годину.`,
  shooAgain: (left: number) => `🐦‍⬛ Ти вже натискав «Кш!». Треба ще ${moreCats(left)}.`,
  shooDone: '🐦‍⬛ Та мовчу вже, мовчу.',
  stale: '🐦‍⬛ Ця кнопка застаріла.',
  betSettled: '🎲 Записала, зараз скажу чату.',
  betStale: '🎲 Ця ставка вже вирішена.',
  staleMenu: '🐦‍⬛ Це меню застаріло — відкрий свіже: /crow',
};

/** The cats «Кш!» still wants: one or two, as a pestering crow takes three */
function moreCats(left: number): string {
  return left === 1 ? 'один кіт' : 'двоє котів';
}

/** The crow's answer to the cats who sent her away, under the post */
export const SHOO_REPLY: Record<ShooCats, string> = {
  2: '🐦‍⬛ Двоє котів проти однієї ворони — сміливо. Добре, мовчу годину. Засікайте.',
  3: '🐦‍⬛ Троє котів проти однієї ворони — це вже зграя, з такою я не справлюся. Полетіла на годину. Засікайте.',
};

/**
 * What a press on «Кш!» comes to: `count` cats have pressed it in the chat
 * within the hour, this one among them, and the crow's boldness wants `needed`.
 * The cat who makes them enough sends her away for an hour, unless she keeps
 * quiet already; a cat who pressed before only hears how many are still wanted.
 */
export function shooOutcome(press: { added: boolean; count: number; needed: ShooCats; silent: boolean }): {
  toast: string;
  goAway: boolean;
} {
  const left = press.needed - press.count;
  if (left > 0) return { toast: press.added ? TOASTS.shooMore(left) : TOASTS.shooAgain(left), goAway: false };
  return { toast: TOASTS.shooDone, goAway: press.added && !press.silent };
}

/** `/crow` in a private chat */
export const PRIVATE_CHAT_TEXT = '🐦‍⬛ Я каркаю в групах. Додай мене в чат і напиши там /crow.';

/** A menu the bot showed a cat: ephemeral (only they see it), or the fallback message in the chat */
export interface MenuMessage {
  ephemeral: boolean;
  id: number;
}

/**
 * The /crow menus open in the chats. A cat who calls /crow again gets a new
 * menu, and the old one would go on showing the settings as they were, so the
 * new one replaces it: the command takes the old one down, and a button of a
 * replaced menu answers that it is stale. Kept in memory: after a restart a
 * menu is simply pressed as it is, and becomes the open one.
 */
export class OpenMenus {
  private readonly open = new Map<string, MenuMessage>();
  /** Replaced menus, oldest first, so their buttons can say so even if taking them down failed */
  private readonly replaced = new Set<string>();

  constructor(private readonly remembered = 1000) {}

  /** Records the cat's new menu and returns the one it replaces, to take down */
  opened(chatId: number, userId: number, menu: MenuMessage): MenuMessage | undefined {
    const key = `${chatId}:${userId}`;
    const previous = this.open.get(key);
    this.open.set(key, menu);
    if (previous) this.remember(chatId, previous);
    return previous;
  }

  /** Records a pressed ephemeral menu as the cat's open one, so the next /crow replaces it */
  pressed(chatId: number, userId: number, menu: MenuMessage): void {
    if (menu.ephemeral && !this.isReplaced(chatId, menu)) this.open.set(`${chatId}:${userId}`, menu);
  }

  isReplaced(chatId: number, menu: MenuMessage): boolean {
    return this.replaced.has(OpenMenus.messageKey(chatId, menu));
  }

  private remember(chatId: number, menu: MenuMessage) {
    this.replaced.add(OpenMenus.messageKey(chatId, menu));
    for (const oldest of this.replaced) {
      if (this.replaced.size <= this.remembered) break;
      this.replaced.delete(oldest);
    }
  }

  private static messageKey(chatId: number, menu: MenuMessage) {
    return `${chatId}:${menu.ephemeral ? 'e' : 'm'}${menu.id}`;
  }
}

/** The owner's buttons under an alert: a new budget for today (budget alerts only), and the pipeline run now */
export function ownerKeyboard(withReset: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (withReset) keyboard.text('🔄 Скинути бюджет', 'crow:owner:reset');
  return keyboard.text('▶️ Запустити конвеєр', 'crow:owner:run');
}

/** The owner's buttons under a bet the crow could not settle: an option each, or calling it off */
export function betOwnerKeyboard(pollId: number, options: readonly string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((option, i) => keyboard.text(clip(`✅ ${option}`, 60), `crow:bet:${pollId}:${i}`).row());
  return keyboard.text('🚫 Скасувати ставку', `crow:bet:${pollId}:x`);
}

/** What the owner is asked about a bet the crow could not settle */
export function betOwnerText(question: string, pollLink: string | null, reason: string): string {
  return [
    `🎲 Ставка «${question}»${pollLink ? ` (${pollLink})` : ''}: з новин не зрозуміло, чим скінчилося.`,
    `🐦‍⬛ ${reason}`,
    'Хто виграв? За тиждень без відповіді ставку скасую.',
  ].join('\n');
}

/** A duration, roughly: «5 хв», «3 год», «2 дн» */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} год` : `${Math.round(hours / 24)} дн`;
}

/** «1 пост», «3 пости», «5 постів» */
const posts = (count: number) => `${count} ${plural(count, ['пост', 'пости', 'постів'])}`;

const WAITING_SHOWN = 10;

/** The owner's alert when the day's budget is spent: what waits for money and what goes on anyway */
export function budgetAlertText(report: BudgetReport, now: Date): string {
  const lines = [
    `💸 Ворона витратила денний бюджет: $${report.spentUsd.toFixed(2)} з $${report.limitUsd.toFixed(2)}. ` +
      `Нові арки — з нового дня за UTC, за ${durationLabel(nextBudgetDay(now).getTime() - now.getTime())}.`,
  ];
  if (report.waiting.length > 0) {
    lines.push(
      '',
      `📰 Чекають на запис (${report.waiting.length}):`,
      ...report.waiting
        .slice(0, WAITING_SHOWN)
        .map((story) => `• ${story.title} — ${durationLabel(now.getTime() - story.since.getTime())}`),
    );
    if (report.waiting.length > WAITING_SHOWN) lines.push(`• і ще ${report.waiting.length - WAITING_SHOWN}`);
  }
  lines.push(
    '',
    `📬 У чатах ${posts(report.plannedPosts)} уже написаних арок — вони йдуть за графіком.`,
    '',
    '🔄 «Скинути бюджет» — ще стільки ж на сьогодні; ▶️ «Запустити конвеєр» — не чекати 2 хвилини після скидання.',
    `ℹ️ Залишок на рахунку OpenAI через API не видно: ${OPENAI_BILLING_URL}`,
  );
  return lines.join('\n');
}
