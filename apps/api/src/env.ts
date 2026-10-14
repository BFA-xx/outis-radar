import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Load the repo-root .env for local runs; hosted environments set real env vars. */
export function loadLocalEnv(): void {
  const file = [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')].find((f) => existsSync(f));
  if (file) process.loadEnvFile(file);
}

const schema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a postgres URL'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** Set when running behind a reverse proxy so rate limiting sees client IPs. */
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
});

export type ApiEnv = z.infer<typeof schema>;

export function loadApiEnv(): ApiEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Names only — never echo values, they may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid API environment — ${problems}`);
  }
  return parsed.data;
}
