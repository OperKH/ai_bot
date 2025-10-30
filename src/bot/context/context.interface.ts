import { Context } from 'telegraf';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionData {}

export interface IBotContext extends Context {
  session: SessionData;
}
