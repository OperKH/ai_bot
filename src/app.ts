import dataSource from './dataSource/dataSource';
import { ConfigService } from './config/config.service';
import { Bot } from './bot/bot.class';
import {
  StartCommand,
  ClassifyMessageCommand,
  MediaTrackerCommand,
  RecognizeSpeechCommand,
} from './bot/commands/index';

const configService = ConfigService.getInstance();

await dataSource.initialize();

const bot = new Bot(configService, dataSource);

await bot.registerCommands([StartCommand, MediaTrackerCommand, ClassifyMessageCommand, RecognizeSpeechCommand]);
bot.start();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
