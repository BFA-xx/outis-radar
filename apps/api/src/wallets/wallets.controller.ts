import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@outis/db';
import { createLogger, loadWalletJobConfig, runWalletJob, walletReport } from '@outis/engine';
import { CHAINS, getChain, isPlausibleAddress, normalizeAddress, walletSupport } from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from '../scoring/admin.guard';

const addWallet = z.object({
  chainId: z.string().refine((c) => Boolean(getChain(c)), 'Unknown chain id'),
  address: z.string().trim().min(10).max(100),
  label: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});
const idParam = z.object({ id: z.string().min(1).max(40) });

/** BigInt (blockNumber) is not JSON; serialize as string. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Which chains can be tracked right now, and from what source. */
  @Get('support')
  support() {
    return CHAINS.map((c) => {
      const s = walletSupport(c);
      return { chainId: c.id, name: c.displayName, family: c.family, state: s.state, source: s.source?.kind ?? null, userConfigured: s.source?.userConfigured ?? false, note: s.note };
    });
  }

  @Get()
  async list() {
    const wallets = await this.prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { transfers: true } } } });
    const lastActivity = await this.prisma.walletTransfer.groupBy({ by: ['walletId'], _max: { blockTime: true } });
    const last = new Map(lastActivity.map((l) => [l.walletId, l._max.blockTime]));
    return wallets.map((w) => ({
      id: w.id,
      chainId: w.chainId,
      chainName: getChain(w.chainId)?.displayName ?? w.chainId,
      address: w.address,
      label: w.label,
      note: w.note,
      createdAt: w.createdAt,
      trackedFrom: w.trackedFrom,
      lastSyncAt: w.lastSyncAt,
      lastSyncStatus: w.lastSyncStatus,
      lastSyncError: w.lastSyncError,
      source: w.source,
      transfers: w._count.transfers,
      lastActivityAt: last.get(w.id) ?? null,
    }));
  }

  @Get(':id')
  async report(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>) {
    try {
      return plain(await walletReport(this.prisma, p.id));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') throw new NotFoundException({ code: 'not_found', message: 'Wallet is not tracked' });
      throw err;
    }
  }

  @Post()
  @UseGuards(AdminGuard)
  async add(@Body(new ZodPipe(addWallet)) b: z.infer<typeof addWallet>) {
    const chain = getChain(b.chainId)!;
    if (!isPlausibleAddress(chain, b.address)) {
      throw new BadRequestException({ code: 'invalid_address', message: `That is not a ${chain.displayName} address.` });
    }
    const address = normalizeAddress(chain, b.address);
    try {
      const w = await this.prisma.trackedWallet.create({
        data: { chainId: chain.id, address, label: b.label || null, note: b.note || null, trackedFrom: new Date() },
      });
      const s = walletSupport(chain);
      return { ...w, support: { state: s.state, note: s.note } };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'exists', message: 'This wallet is already tracked.' });
      throw err;
    }
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  async remove(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>) {
    const r = await this.prisma.trackedWallet.deleteMany({ where: { id: p.id } });
    if (r.count === 0) throw new NotFoundException({ code: 'not_found', message: 'Wallet is not tracked' });
    return { ok: true };
  }

  /** Sync one wallet now (bounded to ~90s). Uses the same lease as the scheduled job. */
  @Post(':id/sync')
  @UseGuards(AdminGuard)
  async syncNow(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>) {
    const exists = await this.prisma.trackedWallet.count({ where: { id: p.id } });
    if (!exists) throw new NotFoundException({ code: 'not_found', message: 'Wallet is not tracked' });
    const r = await runWalletJob({
      prisma: this.prisma,
      logger: createLogger('api-wallet-sync'),
      trigger: 'api',
      walletIds: [p.id],
      config: { ...loadWalletJobConfig(), maxDurationMs: 90_000, perWalletMs: 85_000 },
    });
    return { status: r.status, transfers: r.transfers, errors: r.errors };
  }
}
