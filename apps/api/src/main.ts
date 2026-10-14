import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadLocalEnv } from './env';

async function bootstrap() {
  loadLocalEnv();
  const { app, env } = await createApp();
  app.enableShutdownHooks();
  const server = await app.listen(env.API_PORT);
  // Bound slow clients; every endpoint is a bounded DB read.
  server.requestTimeout = 15_000;
  server.headersTimeout = 16_000;
  new Logger('api').log(`listening on :${env.API_PORT}`);
}

bootstrap().catch((err) => {
  console.error(`API failed to start: ${(err as Error).message}`);
  process.exit(1);
});
