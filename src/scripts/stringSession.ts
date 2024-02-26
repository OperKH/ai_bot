import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
// @ts-expect-error any
import input from 'input';
import { ConfigService } from '../config/config.service.js';

const configService = ConfigService.getInstance();
const apiId = configService.get('TG_API_ID');
const apiHash = configService.get('TG_API_HASH');
const stringSession = new StringSession(configService.get('TG_API_SESSION'));

console.log('Loading interactive app...');
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: async () => await input.text('Please enter your number: '),
  password: async () => await input.text('Please enter your password: '),
  phoneCode: async () => await input.text('Please enter the code you received: '),
  onError: (err) => console.log(err),
});
console.log('SAVE THIS TO "TG_API_SESSION":');
console.log(client.session.save()); // Save this string to avoid logging in again

await client.destroy();
