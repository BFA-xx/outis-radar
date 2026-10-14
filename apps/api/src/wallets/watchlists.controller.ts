import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@outis/db';
import { getChain, isPlausibleAddress, normalizeAddress } from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from '../scoring/admin.guard';

const createList = z.object({ name: z.string().trim().min(1).max(60) });
const addItem = z.object({
  kind: z.enum(['token', 'wallet']),
  chainId: z.string().refine((c) => Boolean(getChain(c)), 'Unknown chain id'),
  address: z.string().trim().min(10).max(100),
  note: z.string().trim().max(300).optional(),
});
const idParam = z.object({ id: z.string().min(1).max(40) });
const itemParam = z.object({ id: z.string().min(1).max(40), itemId: z.string().min(1).max(40) });

@Controller('watchlists')
export class WatchlistsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Every list with its items, each enriched with live token/wallet state. */
  @Get()
  async list() {
    const lists = await this.prisma.watchlist.findMany({ orderBy: { createdAt: 'asc' }, include: { items: { orderBy: { addedAt: 'desc' } } } });
    const items = lists.flatMap((l) => l.items);
    const tokenKeys = items.filter((i) => i.kind === 'token');
    const walletKeys = items.filter((i) => i.kind === 'wallet');
    const tokens = tokenKeys.length
      ? await this.prisma.token.findMany({
          where: { OR: tokenKeys.map((i) => ({ chainId: i.chainId, address: i.address })) },
          include: { pairs: { where: { isPrimary: true }, take: 1 } },
        })
      : [];
    const wallets = walletKeys.length ? await this.prisma.trackedWallet.findMany({ where: { OR: walletKeys.map((i) => ({ chainId: i.chainId, address: i.address })) } }) : [];
    const tk = new Map(tokens.map((t) => [`${t.chainId}:${t.address}`, t]));
    const wk = new Map(wallets.map((w) => [`${w.chainId}:${w.address}`, w]));
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      items: l.items.map((i) => {
        const key = `${i.chainId}:${i.address}`;
        const t = i.kind === 'token' ? tk.get(key) : undefined;
        const w = i.kind === 'wallet' ? wk.get(key) : undefined;
        const p = t?.pairs[0];
        return {
          ...i,
          chainName: getChain(i.chainId)?.displayName ?? i.chainId,
          token: t
            ? { symbol: t.symbol, name: t.name, imageUrl: t.imageUrl, riskScore: t.riskScore, riskLevel: t.riskLevel, riskCoverage: t.riskCoverage, momentumScore: t.momentumScore, priceUsd: p?.priceUsd ?? null, priceChangeH1: p?.priceChangeH1 ?? null, priceChangeH24: p?.priceChangeH24 ?? null, liquidityUsd: p?.liquidityUsd ?? null, marketUpdatedAt: p?.marketUpdatedAt ?? null }
            : null,
          wallet: w ? { id: w.id, label: w.label, lastSyncAt: w.lastSyncAt, lastSyncStatus: w.lastSyncStatus } : null,
        };
      }),
    }));
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body(new ZodPipe(createList)) b: z.infer<typeof createList>) {
    try {
      return await this.prisma.watchlist.create({ data: { name: b.name } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'exists', message: 'A list with that name exists.' });
      throw err;
    }
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  async remove(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>) {
    const r = await this.prisma.watchlist.deleteMany({ where: { id: p.id } });
    if (!r.count) throw new NotFoundException({ code: 'not_found', message: 'No such list' });
    return { ok: true };
  }

  @Post(':id/items')
  @UseGuards(AdminGuard)
  async addItem(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>, @Body(new ZodPipe(addItem)) b: z.infer<typeof addItem>) {
    const chain = getChain(b.chainId)!;
    if (!isPlausibleAddress(chain, b.address)) throw new BadRequestException({ code: 'invalid_address', message: `That is not a ${chain.displayName} address.` });
    try {
      return await this.prisma.watchlistItem.create({ data: { watchlistId: p.id, kind: b.kind, chainId: chain.id, address: normalizeAddress(chain, b.address), note: b.note || null } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException({ code: 'exists', message: 'Already on this list.' });
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw new NotFoundException({ code: 'not_found', message: 'No such list' });
      throw err;
    }
  }

  @Delete(':id/items/:itemId')
  @UseGuards(AdminGuard)
  async removeItem(@Param(new ZodPipe(itemParam)) p: z.infer<typeof itemParam>) {
    const r = await this.prisma.watchlistItem.deleteMany({ where: { id: p.itemId, watchlistId: p.id } });
    if (!r.count) throw new NotFoundException({ code: 'not_found', message: 'No such item' });
    return { ok: true };
  }
}
