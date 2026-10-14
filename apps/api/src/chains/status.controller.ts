import { Controller, Get, Inject, Query, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import { loadScanConfig } from '@outis/engine';
import { CHAINS, computeChainStatus, summarizeChain } from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';

const scansQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** Chains that the worker scans, per the same env the worker reads. */
function scannedChainIds(): Set<string> {
  try {
    return new Set(loadScanConfig().chains.map((c) => c.id));
  } catch {
    return new Set();
  }
}

@Controller()
export class StatusController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Liveness + database reachability. 503 when the database is down. */
  @Get('health')
  async health() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ code: 'db_unavailable', message: 'Database unreachable' });
    }
    const lastScan = await this.prisma.scanRun.findFirst({
      where: { job: 'discovery-scan', status: { not: 'skipped' } },
      orderBy: { startedAt: 'desc' },
      select: { status: true, startedAt: true, finishedAt: true },
    });
    return { ok: true, dbLatencyMs: Date.now() - started, lastScan };
  }

  @Get('chains')
  async chains() {
    const health = await this.prisma.providerHealth.findMany();
    const scanned = scannedChainIds();
    const counts = await this.prisma.pair.groupBy({
      by: ['chainId'],
      where: { isPrimary: true },
      _count: { _all: true },
      _max: { marketUpdatedAt: true },
    });
    const byChain = new Map(counts.map((c) => [c.chainId, c]));
    return CHAINS.map((chain) => {
      const h = health.filter((x) => x.scope === chain.id).map((x) => ({ ...x, chainId: x.scope }));
      const status = computeChainStatus(chain, { scanned: scanned.has(chain.id), health: h });
      const c = byChain.get(chain.id);
      return {
        ...summarizeChain(chain),
        scanned: scanned.has(chain.id),
        rpcConfigured: Boolean(process.env[chain.rpcEnvVar]),
        status: status.status,
        statusReason: status.reason,
        trackedTokens: c?._count._all ?? 0,
        lastMarketUpdate: c?._max.marketUpdatedAt?.toISOString() ?? null,
        providers: h.map((x) => ({
          provider: x.provider,
          lastSuccessAt: x.lastSuccessAt?.toISOString() ?? null,
          lastErrorAt: x.lastErrorAt?.toISOString() ?? null,
          lastError: x.lastError,
          consecutiveFailures: x.consecutiveFailures,
        })),
      };
    });
  }

  @Get('providers/health')
  async providerHealth() {
    const rows = await this.prisma.providerHealth.findMany({ orderBy: [{ provider: 'asc' }, { scope: 'asc' }] });
    return rows.map((r) => ({
      provider: r.provider,
      scope: r.scope,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
      lastError: r.lastError,
      consecutiveFailures: r.consecutiveFailures,
      lastLatencyMs: r.lastLatencyMs,
      requestsTotal: r.requestsTotal,
      errorsTotal: r.errorsTotal,
      rateLimitedTotal: r.rateLimitedTotal,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  @Get('scans')
  async scans(@Query(new ZodPipe(scansQuery)) q: z.infer<typeof scansQuery>) {
    return this.prisma.scanRun.findMany({ orderBy: { startedAt: 'desc' }, take: q.limit });
  }

  /** Dashboard overview: counts per chain and the latest scan. */
  @Get('overview')
  async overview() {
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60_000);
    const dayAgo = new Date(now - 24 * 60 * 60_000);
    const [perChain, newHour, newDay, lastScan, scansDay] = await Promise.all([
      this.prisma.pair.groupBy({ by: ['chainId'], where: { isPrimary: true }, _count: { _all: true } }),
      this.prisma.pair.groupBy({
        by: ['chainId'],
        where: { isPrimary: true, pairCreatedAt: { gte: hourAgo } },
        _count: { _all: true },
      }),
      this.prisma.pair.groupBy({
        by: ['chainId'],
        where: { isPrimary: true, pairCreatedAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      this.prisma.scanRun.findFirst({ where: { job: 'discovery-scan', status: { not: 'skipped' } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.scanRun.groupBy({ by: ['status'], where: { startedAt: { gte: dayAgo } }, _count: { _all: true } }),
    ]);
    const n = (rows: Array<{ chainId: string; _count: { _all: number } }>, id: string) =>
      rows.find((r) => r.chainId === id)?._count._all ?? 0;
    const chainIds = [...new Set(perChain.map((r) => r.chainId))];
    return {
      chains: chainIds.map((id) => ({
        chainId: id,
        tokens: n(perChain, id),
        newLastHour: n(newHour, id),
        newLast24h: n(newDay, id),
      })),
      lastScan,
      scansLast24h: Object.fromEntries(scansDay.map((s) => [s.status, s._count._all])),
    };
  }
}
