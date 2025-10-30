import 'reflect-metadata';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataSourceFactory } from './dataSource.factory';
import { ConfigService } from '../config/config.service';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configService = ConfigService.getInstance();
const dataSource = dataSourceFactory({
  type: 'postgres',
  host: configService.get('DB_HOST'),
  port: configService.get('DB_PORT'),
  username: configService.get('DB_USERNAME'),
  password: configService.get('DB_PASSWORD'),
  database: configService.get('DB_NAME'),
  synchronize: false,
  logging: false,
  connectTimeoutMS: 10_000, // 10 seconds
  migrationsRun: true,
  entities: [`${__dirname}/../entity/*.{js,ts}`],
  subscribers: [],
  migrations: [`${__dirname}/../migrations/*.{js,ts}`],
});

export default dataSource;
