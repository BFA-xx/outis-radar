// Apply migrations to DATABASE_URL_TEST (the throwaway test database).
import { spawnSync } from 'node:child_process';
const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error('DATABASE_URL_TEST is not set — nothing to migrate.');
  process.exit(1);
}
const res = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
});
process.exit(res.status ?? 1);
