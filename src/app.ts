import { shutdownTracing } from './tracing';
import dataSource from './dataSource/dataSource';
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

const bot = new Bot(configService, dataSource);

await bot.registerCommands([
  StartCommand,
  MediaTrackerCommand,
  IgnoreMediaCommand,
  ClassifyMessageCommand,
  RecognizeSpeechCommand,
  TrendsCommand,
]);
bot.start();

// Enable graceful stop
process.once('SIGINT', async () => {
  await bot.stop('SIGINT');
  await shutdownTracing();
});
process.once('SIGTERM', async () => {
  await bot.stop('SIGTERM');
  await shutdownTracing();
});
