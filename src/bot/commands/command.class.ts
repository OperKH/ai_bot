import { Telegraf } from 'telegraf';
import { DataSource } from 'typeorm';
import { IBotContext } from '../context/context.interface.js';
import { ConfigService } from '../../config/config.service.js';

export abstract class Command {
  constructor(
    public readonly bot: Telegraf<IBotContext>,
    public readonly dataSource: DataSource,
    public readonly configService: ConfigService,
  ) {}

  abstract command: string | null;
  abstract description: string | null;

  abstract handle(): void;
  abstract dispose(): Promise<void>;
}
