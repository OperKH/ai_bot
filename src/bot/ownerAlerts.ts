import type { DataSource } from 'typeorm';
import type { Api } from 'grammy';

const DAY_MS = 24 * 3_600_000;
const LOG_PREFIX = '[Alerts]';
/** The kinds already logged for want of an owner, so a failing call after call logs once */
const loggedWithoutOwner = new Set<string>();

/** Where OpenAI's owner tops the balance up */
export const OPENAI_BILLING_URL = 'https://platform.openai.com/settings/organization/billing';

/** The owner's alert when OpenAI refuses the calls for an empty balance */
export const QUOTA_ALERT = [
  '💸 На рахунку OpenAI закінчилися гроші: API відповідає insufficient_quota.',
  'Тренди, опис фото й ворона стоять, доки рахунок не поповнено:',
  OPENAI_BILLING_URL,
  '',
  'Ворона пробує знову раз на годину; ▶️ «Запустити конвеєр» — одразу після поповнення.',
].join('\n');

/**
 * Messages to the bot owner (`TG_OWNER_ID`) about trouble only they can fix,
 * such as an empty OpenAI balance. Each kind goes at most once a day, and the
 * day is kept in the database: a restart, or a crash loop, does not repeat it.
 * The owner must have started a private chat with the bot, or Telegram refuses
 * the message.
 */
export class OwnerAlerts {
  constructor(
    private readonly api: Pick<Api, 'sendMessage'>,
    private readonly ownerId: number,
    private readonly dataSource: DataSource,
  ) {}

  /** Sends the alert unless one of this kind went out in the last 24 hours; whether it was sent */
  async notify(kind: string, text: string, other?: Parameters<Api['sendMessage']>[2]): Promise<boolean> {
    if (!this.ownerId) {
      // Nobody to tell, so the log is where it goes — once a run, not with every failing call
      if (!loggedWithoutOwner.has(kind)) {
        loggedWithoutOwner.add(kind);
        console.warn(`${LOG_PREFIX} Nobody to tell of ${kind}, TG_OWNER_ID is not set: ${text.split('\n')[0]}`);
      }
      return false;
    }
    // Claimed before sending, so two failing calls at once send one message
    const now = new Date();
    const claimed = await this.dataSource.query(
      `INSERT INTO owner_alert (kind, "sentAt") VALUES ($1, $2)
       ON CONFLICT (kind) DO UPDATE SET "sentAt" = EXCLUDED."sentAt" WHERE owner_alert."sentAt" <= $3
       RETURNING kind`,
      [kind, now, new Date(now.getTime() - DAY_MS)],
    );
    if (claimed.length === 0) return false;
    try {
      await this.api.sendMessage(this.ownerId, text, other);
      console.log(`${LOG_PREFIX} The owner was told of ${kind}`);
      return true;
    } catch (e) {
      console.error(`${LOG_PREFIX} Could not tell the owner of ${kind} (a private chat with the bot must be started):`, e);
      return false;
    }
  }
}
