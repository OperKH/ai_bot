import { shutdownTracing } from './tracing';
import dataSource from './dataSource/dataSource';
import { checkVectorExtensions } from './dataSource/vectorExtensions';
import { ConfigService } from './config/config.service';
import { Bot } from './bot/bot.class';
import {
  StartCommand,
  ClassifyMessageCommand,
  IgnoreMediaCommand,
  MediaTrackerCommand,
  RecognizeSpeechCommand,
  TrendsCommand,
} from './bot/commands/index';

const configService = ConfigService.getInstance();

await dataSource.initialize();
// Only logs, so the bot does not wait for it
// eslint-disable-next-line @typescript-eslint/no-floating-promises
checkVectorExtensions(dataSource);

const bot = new Bot(configService, dataSource);

bot.registerCommands([
  StartCommand,
  MediaTrackerCommand,
  IgnoreMediaCommand,
  ClassifyMessageCommand,
  RecognizeSpeechCommand,
  TrendsCommand,
]);
bot.start();

// `bot.catch` only sees rejections that travel back up the middleware chain.
// Work started without await on purpose — the history import, the trends
// cleanup interval — has no handler left on the stack, and an unhandled
// rejection there is what killed the process mid-import. Keep the bot running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Enable graceful stop
process.once('SIGINT', async () => {
  await bot.stop('SIGINT');
  await shutdownTracing();
});
process.once('SIGTERM', async () => {
  await bot.stop('SIGTERM');
  await shutdownTracing();
});
