import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the repo-root `.env` for local runs. In CI and production the variables
 * come from the host's secret store and no file exists — that is not an error.
 * Values already present in the environment always win.
 */
export function loadLocalEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')];
  const file = candidates.find((f) => existsSync(f));
  if (file) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See .env.example.`);
  return v;
}
