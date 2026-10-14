import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import { readPrefs } from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';

const q = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['pending', 'sent', 'failed', 'suppressed']).optional(),
});

@Controller('alerts')
export class AlertsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get()
  async list(@Query(new ZodPipe(q)) p: z.infer<typeof q>) {
    const day = new Date(Date.now() - 24 * 60 * 60_000);
    const [events, subs, counts] = await Promise.all([
      this.prisma.alertEvent.findMany({ where: p.status ? { status: p.status } : {}, orderBy: { createdAt: 'desc' }, take: p.limit }),
      this.prisma.telegramSubscriber.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.alertEvent.groupBy({ by: ['kind', 'status'], where: { createdAt: { gte: day } }, _count: { _all: true } }),
    ]);
    return {
      // Whether the bot is configured — never the token itself.
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      allowedUsers: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').filter((s) => s.trim()).length,
      subscribers: subs.map((s) => ({ id: s.id, username: s.username, active: s.active, createdAt: s.createdAt, prefs: readPrefs(s.prefs) })),
      last24h: counts.map((c) => ({ kind: c.kind, status: c.status, count: c._count._all })),
      events: events.map((e) => ({ id: e.id, kind: e.kind, status: e.status, text: e.text, createdAt: e.createdAt, sentAt: e.sentAt, error: e.error, attempts: e.attempts })),
    };
  }
}
