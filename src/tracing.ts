import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { ConfigService } from './config/config.service.js';

const configService = ConfigService.getInstance();

const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: configService.get('LANGFUSE_PUBLIC_KEY'),
  secretKey: configService.get('LANGFUSE_SECRET_KEY'),
  baseUrl: configService.get('LANGFUSE_BASE_URL'),
  environment: configService.get('LANGFUSE_TRACING_ENVIRONMENT'),
});

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();

console.log('[Langfuse] Tracing initialized');

export async function shutdownTracing(): Promise<void> {
  await sdk.shutdown();
}
