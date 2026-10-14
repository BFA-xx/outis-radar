/**
 * Bot process. Three ways to run it:
 *
 *   node dist/main.js                    local: long polling + an alert loop
 *   node dist/main.js --once             scheduled (GitHub Actions): generate + deliver alerts, exit
 *   node dist/main.js --set-webhook URL  deployed: point Telegram at the API's /telegram/webhook, exit
 *   node dist/main.js --delete-webhook   back to polling
 *
 * Without TELEGRAM_BOT_TOKEN it explains what to do and exits cleanly, so
 * `npm start` keeps working before Telegram is set up.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type PrismaClient, getPrisma } from '@outis/db';
import { type Logger, type Sender, acquireLease, createLogger, deliverPending, generateAlerts, releaseLease } from '@outis/engine';
import { BOT_COMMANDS, TOKEN_SHAPE, allowedUserIdsFromEnv, createBot, telegramSender } from './bot';

/** Generate (leased, so two runners never double-generate) and deliver once. */
async function alertsOnce(prisma: PrismaClient, send: Sender, logger: Logger, holder: string, leaseMs: number, deadline: number, dashboardUrl: string | null) {
  if (await acquireLease(prisma, 'alerts', holder, leaseMs)) {
    try {
      const g = await generateAlerts(prisma, { dashboardUrl });
      const total = Object.values(g.created).reduce((a, b) => a + b, 0);
      if (total || g.suppressed) logger.info('alerts generated', { ...g.created, suppressed: g.suppressed });
    } finally {
      await releaseLease(prisma, 'alerts', holder);
    }
  }
  // Delivery is safe to run anyway: rows move pending → sent exactly once.
  const d = await deliverPending(prisma, send, { deadline });
  if (d.sent || d.failed || d.deactivated) logger.info('alerts delivered', { ...d });
}

async function main() {
  const file = [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')].find((f) => existsSync(f));
  if (file) process.loadEnvFile(file);
  const logger = createLogger('bot');
  const args = process.argv.slice(2);

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram alerts are off. See docs/DEPLOY.md → Telegram.');
    return;
  }
  if (!TOKEN_SHAPE.test(token)) {
    // Say what is wrong without echoing the value.
    logger.error('TELEGRAM_BOT_TOKEN does not look like a bot token (expected "<digits>:<secret>" from @BotFather).');
    process.exitCode = 1;
    return;
  }
  const allowed = allowedUserIdsFromEnv();
  if (allowed.size === 0) logger.warn('TELEGRAM_ALLOWED_USER_IDS is empty — the bot will only tell people their id. Add yours to enable it.');
  const dashboardUrl = process.env.DASHBOARD_URL?.trim() || null;
  const interval = Math.max(20, Number(process.env.ALERT_INTERVAL_SECONDS ?? 60)) * 1000;

  const prisma = getPrisma();
  const bot = createBot(token, { prisma, allowedUserIds: allowed, dashboardUrl });
  const send = telegramSender(bot);
  const holder = `bot-${randomUUID().slice(0, 8)}`;

  if (args[0] === '--set-webhook' || args[0] === '--delete-webhook') {
    try {
      if (args[0] === '--delete-webhook') {
        await bot.api.deleteWebhook();
        logger.info('webhook removed — the bot can long-poll again');
        return;
      }
      const url = args[1];
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
      if (!url || !/^https:\/\/.+\/telegram\/webhook$/.test(url)) throw new Error('usage: --set-webhook https://<your-api>/telegram/webhook');
      if (!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 24+ characters of A-Z a-z 0-9 _ - (generate: openssl rand -hex 24)');
      await bot.api.setWebhook(url, { secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      await bot.api.setMyCommands(BOT_COMMANDS);
      logger.info('webhook set', { url });
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  if (args[0] === '--once') {
    // One bounded pass for a scheduler. Leaves time to finish inside the job's timeout.
    const budget = Math.max(30, Number(process.env.ALERT_ONCE_SECONDS ?? 120)) * 1000;
    try {
      await alertsOnce(prisma, send, logger, holder, budget + 60_000, Date.now() + budget, dashboardUrl);
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  // ── Local: polling + alert loop ─────────────────────────────────────────
  // grammY's polling deletes any webhook on start. If a deployment has one set,
  // polling here would silently take the bot away from it — so don't.
  const hook = await bot.api.getWebhookInfo();
  const polling = !hook.url;
  if (!polling) logger.warn('a webhook is set for this bot (deployed) — not polling, only delivering alerts. Use --delete-webhook to poll locally.');
  else await bot.api.setMyCommands(BOT_COMMANDS);

  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    try {
      await alertsOnce(prisma, send, logger, holder, interval * 3, Date.now() + interval - 5_000, dashboardUrl);
    } catch (err) {
      logger.error('alert loop error', { error: (err as Error).message.slice(0, 300) });
    } finally {
      if (!stopping) timer = setTimeout(tick, interval);
    }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (polling) await bot.stop();
    await prisma.$disconnect();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  void tick();
  logger.info(`bot started (${polling ? 'long polling' : 'alerts only'})`, { allowedUsers: allowed.size, alertIntervalSec: interval / 1000 });
  if (polling) await bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
}

main().catch((err) => {
  createLogger('bot').error('bot failed', { error: (err as Error).message.slice(0, 300) });
  process.exit(1);
});
