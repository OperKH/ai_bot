import { Bot } from './bot/bot.class.js';
import { StartCommand, ClassifyMessageCommand, RecognizeSpeechCommand, ClockCommand } from './bot/commands/index.js';
import { ConfigService } from './config/config.service.js';

const configService = new ConfigService();
const bot = new Bot(configService);

bot.registerCommands([StartCommand, ClockCommand, ClassifyMessageCommand, RecognizeSpeechCommand]);
bot.start();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
