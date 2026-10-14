#!/usr/bin/env node
// Print fresh random values for the deploy secrets. They are printed HERE, on
// your machine, for you to paste into Vercel / GitHub settings — never into a
// chat, an issue or a commit. Nothing is saved.
import { randomBytes } from 'node:crypto';

const hex = (n) => randomBytes(n).toString('hex');
const words = ['radar', 'orbit', 'signal', 'comet', 'vector', 'pulse', 'quartz', 'ember', 'falcon', 'harbor', 'lumen', 'nimbus'];
const pick = () => words[randomBytes(1)[0] % words.length];

console.log(`
API_READ_TOKEN=${hex(24)}
ADMIN_TOKEN=${hex(24)}
TELEGRAM_WEBHOOK_SECRET=${hex(24)}
SESSION_SECRET=${hex(32)}
DASHBOARD_PASSWORD=${pick()}-${pick()}-${pick()}-${hex(3)}

Paste each where docs/DEPLOY.md says. Run again any time for new ones.
`);
