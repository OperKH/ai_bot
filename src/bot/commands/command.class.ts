import { Telegraf } from 'telegraf';
import { IBotContext } from '../context/context.interface.js';

export abstract class Command {
  constructor(public readonly bot: Telegraf<IBotContext>) {}

  abstract command: string | null;
  abstract description: string | null;

  abstract handle(): void;
  abstract dispose(): Promise<void>;
}
