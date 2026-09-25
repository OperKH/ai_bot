import { shutdownTracing } from './tracing';
import dataSource from './dataSource/dataSource';
import { checkVectorExtensions } from './dataSource/vectorExtensions';
import { ConfigService } from './config/config.service';
import { Bot } from './bot/bot.class';
import { AIService } from './services/ai.service';
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

let isShuttingDown = false;

/**
 * Stops the bot, which lets the updates in progress finish, then releases the
 * AI models, closes the database and flushes the traces. AIService is a
 * singleton shared by several commands, so it is disposed once here rather
 * than by each of them. No step throws — each logs its own failure — so every
 * step runs and the traces are always flushed. The exit is explicit: a history
 * import running in the background holds an MTProto connection that would
 * keep the process alive.
 */
async function shutdown(exitCode: number) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  await bot.stop();
  await AIService.getInstance().dispose();
  await dataSource.destroy().catch((e) => console.error('Failed to close the database:', e));
  await shutdownTracing().catch((e) => console.error('Failed to flush the traces:', e));
  process.exit(exitCode);
}

bot.start().catch(async (e) => {
  console.error('Polling stopped:', e);
  await shutdown(1);
});

// `bot.catch` only sees rejections that travel back up the middleware chain.
// Work started without await on purpose — the history import, the trends
// cleanup interval — has no handler left on the stack, and an unhandled
// rejection there is what killed the process mid-import. Keep the bot running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
