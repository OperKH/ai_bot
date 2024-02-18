import 'dotenv/config';

export class ConfigService {
  private static readonly config = {
    TOKEN: process.env.TOKEN || '',
  };

  get(key: keyof typeof ConfigService.config): string {
    return ConfigService.config[key];
  }
}
