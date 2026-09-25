import type { Api, Bot, Context, Filter } from 'grammy';
import type { FileApiFlavor } from '@grammyjs/files';

/** The context every handler gets */
export type BotContext = Context;

/** The Bot API client; its `getFile()` results can build their download URL (see `telegramFiles.ts`) */
export type BotApi = FileApiFlavor<Api>;

/** The grammY bot the commands register their handlers on */
export type TelegramBot = Bot<BotContext, BotApi>;

/** A new message in a chat */
export type MessageContext = Filter<BotContext, 'message'>;
