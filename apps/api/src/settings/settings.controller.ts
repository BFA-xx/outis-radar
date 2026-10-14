import { Controller, Get, Inject } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import { loadPaperConfig } from '@outis/engine';
import { CHAINS } from '@outis/shared';
import { PRISMA } from '../common/prisma.module';

const JOBS = [
  { job: 'discovery-scan', label: 'Discovery scan' },
  { job: 'risk-scan', label: 'Risk checks' },
  { job: 'wallet-sync', label: 'Wallet sync' },
  { job: 'evaluate', label: 'Signal & paper evaluation' },
] as const;

const set = (name: string) => Boolean(process.env[name]?.trim());

/**
 * What is configured — as booleans, never values. Secrets stay where they
 * are; this only says whether each one is present on the API host.
 */
@Controller()
export class SettingsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get('settings')
  async settings() {
    const [lastRuns, subscribers, activeSubscribers, alertsLastDay, lastAlert] = await Promise.all([
      Promise.all(
        JOBS.map(async (j) => {
          const [last, lastOk] = await Promise.all([
            this.prisma.scanRun.findFirst({ where: { job: j.job, status: { not: 'skipped' } }, orderBy: { startedAt: 'desc' }, select: { status: true, trigger: true, startedAt: true, finishedAt: true, error: true } }),
            this.prisma.scanRun.findFirst({ where: { job: j.job, status: { in: ['ok', 'partial'] } }, orderBy: { startedAt: 'desc' }, select: { finishedAt: true, startedAt: true } }),
          ]);
          return { ...j, last, lastOkAt: lastOk ? (lastOk.finishedAt ?? lastOk.startedAt) : null };
        }),
      ),
      this.prisma.telegramSubscriber.count(),
      this.prisma.telegramSubscriber.count({ where: { active: true } }),
      this.prisma.alertEvent.count({ where: { status: 'sent', sentAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      this.prisma.alertEvent.findFirst({ where: { status: 'sent' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    ]);
    return {
      host: process.env.VERCEL === '1' ? 'vercel' : 'local',
      security: {
        apiReadToken: set('API_READ_TOKEN'),
        adminToken: (process.env.ADMIN_TOKEN ?? '').length >= 16,
      },
      telegram: {
        botToken: set('TELEGRAM_BOT_TOKEN'),
        webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET ?? '').length >= 24,
        allowedUsers: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').filter((s) => s.trim()).length,
        subscribers,
        activeSubscribers,
        sentLastDay: alertsLastDay,
        lastSentAt: lastAlert?.sentAt ?? null,
      },
      rpc: CHAINS.filter((c) => c.family !== 'tron').map((c) => ({ chainId: c.id, name: c.displayName, configured: set(`RPC_URL_${c.id.toUpperCase()}`) })),
      paper: loadPaperConfig(),
      jobs: lastRuns,
    };
  }
}
