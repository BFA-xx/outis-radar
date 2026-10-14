#!/usr/bin/env node
// One command to run everything locally: API, dashboard, and the scanner loop.
//   npm start
// Ctrl-C stops all three.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(resolve(root, '.env'))) {
  console.error('No .env file. Run:  cp .env.example .env   then put your Postgres user in the three database URLs.');
  process.exit(1);
}
for (const f of ['apps/api/dist/main.js', 'apps/worker/dist/main.js', 'apps/bot/dist/main.js']) {
  if (!existsSync(resolve(root, f))) {
    console.error(`Not built yet (${f} missing). Run:  npm run build:packages && npm run build -w @outis/worker -w @outis/api -w @outis/bot`);
    process.exit(1);
  }
}

const procs = [
  { name: 'api', color: 36, cmd: 'node', args: ['apps/api/dist/main.js'] },
  { name: 'web', color: 35, cmd: 'npm', args: ['run', 'dev', '-w', '@outis/web'] },
  // Scans every 10 minutes: new tokens, market refresh, risk checks.
  { name: 'scan', color: 33, cmd: 'node', args: ['apps/worker/dist/main.js', 'all', '--loop', '600'] },
  // Telegram alerts. Exits on its own (harmlessly) when TELEGRAM_BOT_TOKEN is not set.
  { name: 'bot', color: 32, cmd: 'node', args: ['apps/bot/dist/main.js'] },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: root, env: process.env });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag}stopped (exit ${code})`));
  return child;
});

console.log('\n  OUTIS RADAR starting — open http://localhost:3000 in ~15 seconds. Ctrl-C to stop.\n');

let stopping = false;
const stop = () => {
  if (stopping) process.exit(1);
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
