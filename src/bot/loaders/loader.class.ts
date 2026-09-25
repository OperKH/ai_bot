import type { MessageContext } from '../context/context.interface';

export abstract class Loader {
  constructor(public readonly ctx: MessageContext) {}

  public abstract start(...args: unknown[]): Promise<void>;

  public abstract stop(): void;
}
