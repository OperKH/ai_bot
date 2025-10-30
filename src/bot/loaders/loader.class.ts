import { NarrowedContext } from 'telegraf';
import { Message, Update } from 'telegraf/types';
import { IBotContext } from '../context/context.interface';

export abstract class Loader {
  constructor(public readonly ctx: NarrowedContext<IBotContext, Update.MessageUpdate<Message>>) {}

  public abstract start(...args: unknown[]): Promise<void>;

  public abstract stop(): void;
}
