import { Bot } from './bot/bot.class.js';
import { StartCommand, ClassifyMessageCommand } from './bot/commands/index.js';
import { ConfigService } from './config/config.service.js';

const configService = new ConfigService();
const bot = new Bot(configService);

bot.registerCommands([StartCommand, ClassifyMessageCommand]);
bot.start();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
