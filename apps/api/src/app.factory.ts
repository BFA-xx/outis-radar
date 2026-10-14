import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ErrorsFilter } from './common/errors.filter';
import { type ApiEnv, loadApiEnv } from './env';

/** The configured app, not yet listening. Shared by the local server and the Vercel function. */
export async function createApp(): Promise<{ app: NestExpressApplication; env: ApiEnv }> {
  const env = loadApiEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: process.env.VERCEL === '1' ? ['warn', 'error'] : ['log', 'warn', 'error'] });
  // Scoring config bodies are small; anything bigger is not legitimate.
  app.useBodyParser('json', { limit: '32kb' });

  app.enableCors({
    origin: env.WEB_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-admin-token', 'x-api-token'],
  });
  // Vercel sits in front of the function, so rate limiting needs the forwarded client IP.
  if (env.TRUST_PROXY === '1' || process.env.VERCEL === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.useGlobalFilters(new ErrorsFilter());
  return { app, env };
}
