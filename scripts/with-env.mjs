#!/usr/bin/env node
// Run a command with the repo-root .env loaded (if present). Variables already
// set in the environment win, so CI secrets are never overridden by a file.
//   node scripts/with-env.mjs prisma migrate dev
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: with-env.mjs <command> [...args]');
  process.exit(2);
}
const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status ?? 1);
