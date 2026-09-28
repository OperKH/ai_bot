import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSource } from 'typeorm';
import { OwnerAlerts } from './ownerAlerts';

describe('OwnerAlerts without an owner', () => {
  it('sends nothing, touches no table and logs each kind once', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const sendMessage = mock.fn(async () => ({}) as never);
    const dataSource = {
      query: () => {
        throw new Error('no table without an owner');
      },
    } as unknown as DataSource;
    const alerts = new OwnerAlerts({ sendMessage }, 0, dataSource);

    assert.equal(await alerts.notify('test-quota', '💸 Гроші скінчились\nподробиці'), false);
    assert.equal(await alerts.notify('test-quota', '💸 Гроші скінчились\nподробиці'), false);
    assert.equal(await alerts.notify('test-budget', '💸 Бюджет'), false);

    assert.equal(sendMessage.mock.callCount(), 0);
    const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(logged, [
      '[Alerts] Nobody to tell of test-quota, TG_OWNER_ID is not set: 💸 Гроші скінчились',
      '[Alerts] Nobody to tell of test-budget, TG_OWNER_ID is not set: 💸 Бюджет',
    ]);
  });
});
