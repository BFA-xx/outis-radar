/** Token cleanup against a real Postgres (DATABASE_URL_TEST). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pruneTokens, syncChains } from './persist';

const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)('pruneTokens (Postgres)', () => {
  let prisma: PrismaClient;
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await syncChains(prisma);
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Signal", "PaperTrade", "WatchlistItem", "Watchlist", "WalletTransfer", "TrackedWallet", "MarketSnapshot", "Pair", "Token" CASCADE');
  });

  async function token(name: string, firstSeenDaysAgo: number, updatedDaysAgo: number | null) {
    const t = await prisma.token.create({ data: { chainId: 'solana', address: `${name}Mint`, symbol: name, firstSeenSource: 'test', firstSeenAt: daysAgo(firstSeenDaysAgo) } });
    const p = await prisma.pair.create({
      data: { chainId: 'solana', address: `${name}-pair`, baseTokenId: t.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', isPrimary: true, marketUpdatedAt: updatedDaysAgo === null ? null : daysAgo(updatedDaysAgo) },
    });
    await prisma.marketSnapshot.create({ data: { pairId: p.id, source: 'test', reason: 'refresh', observedAt: daysAgo(20), bucket: daysAgo(20), priceUsd: 1 } });
    return t;
  }

  it('deletes old, quiet, unreferenced tokens with their pairs and snapshots — and keeps everything else', async () => {
    await token('DEAD', 20, 18);
    await token('NEVERUPDATED', 20, null);
    await token('YOUNG', 5, 5); // inside the retention window
    await token('ALIVE', 20, 1); // still trading
    const watched = await token('WATCHED', 20, 18);
    const signalled = await token('SIGNALLED', 20, 18);
    const traded = await token('TRADED', 20, 18);
    const held = await token('HELD', 20, 18);

    const wl = await prisma.watchlist.create({ data: { name: 'w' } });
    await prisma.watchlistItem.create({ data: { watchlistId: wl.id, kind: 'token', chainId: 'solana', address: watched.address } });
    await prisma.signal.create({ data: { rule: 'strict', tokenId: signalled.id, pairId: 'x', chainId: 'solana', firedAt: daysAgo(19) } });
    await prisma.paperTrade.create({
      data: { tokenId: traded.id, pairId: 'x', chainId: 'solana', sizeUsd: 100, entryPrice: 1, entryObservedAt: daysAgo(19), entryImpactPct: 0, feeBps: 100, slippageBps: 50, status: 'closed' },
    });
    const w = await prisma.trackedWallet.create({ data: { chainId: 'solana', address: 'WalletAddr', trackedFrom: daysAgo(30) } });
    await prisma.walletTransfer.create({
      data: { walletId: w.id, chainId: 'solana', txHash: 'tx1', tokenAddress: held.address, logIndex: 0, direction: 'in', amount: 1, amountRaw: '1', source: 'test', blockTime: daysAgo(19) },
    });

    expect(await pruneTokens(prisma, 14, now)).toBe(2);
    const left = (await prisma.token.findMany({ select: { symbol: true } })).map((t) => t.symbol).sort();
    expect(left).toEqual(['ALIVE', 'HELD', 'SIGNALLED', 'TRADED', 'WATCHED', 'YOUNG']);
    expect(await prisma.pair.count()).toBe(6);
    expect(await prisma.marketSnapshot.count()).toBe(6);
  });
});
