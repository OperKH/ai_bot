import { DataSource } from 'typeorm';
import type { TelegramBot } from '../context/context.interface';
import { ConfigService } from '../../config/config.service';

export abstract class Command {
  constructor(
    public readonly bot: TelegramBot,
    public readonly dataSource: DataSource,
    public readonly configService: ConfigService,
  ) {}

  abstract command: string | null;
  abstract description: string | null;

  abstract handle(): void;
  // Most commands hold nothing to release
  async dispose(): Promise<void> {}
}
