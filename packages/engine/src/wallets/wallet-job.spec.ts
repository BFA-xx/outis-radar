/** Wallet sync + report against a real Postgres (DATABASE_URL_TEST), RPC mocked with real Solana data. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import buyFx from '../__fixtures__/solana-pumpfun-buy.json';
import type { FetchLike } from '../http';
import { createLogger } from '../logger';
import { syncChains } from '../persist';
import { walletReport } from './insights';
import { runWalletJob } from './sync';

const envFile = resolve(__dirname, '../../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;
const quiet = createLogger('test', () => {});
const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });

const MINT = (buyFx.tx as { meta: { postTokenBalances: Array<{ owner: string; mint: string }> } }).meta.postTokenBalances.find((b) => b.owner === buyFx.wallet && b.mint !== 'So11111111111111111111111111111111111111112')!.mint;

function solanaMock() {
  const fetchImpl: FetchLike = async (_u, init) => {
    const req = JSON.parse(init!.body!) as { id: number; method: string };
    if (req.method === 'getSignaturesForAddress') {
      return ok({ jsonrpc: '2.0', id: req.id, result: [{ signature: buyFx.signature, blockTime: Math.floor(Date.now() / 1000) - 60, slot: 1, err: null }] });
    }
    return ok({ jsonrpc: '2.0', id: req.id, result: buyFx.tx });
  };
  return fetchImpl;
}

describe.skipIf(!url)('wallet job (Postgres)', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await syncChains(prisma);
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "WalletTransfer", "TrackedWallet", "TokenCheck", "Pair", "Token", "ProviderHealth", "JobLease", "ScanRun" CASCADE');
  });

  it('syncs a real Solana buy, dedupes on re-sync, and values the position from our pair data', async () => {
    const w = await prisma.trackedWallet.create({ data: { chainId: 'solana', address: buyFx.wallet, label: 'test', trackedFrom: new Date() } });
    const env = { RPC_URL_SOLANA: 'https://sol.test' };
    const r1 = await runWalletJob({ prisma, logger: quiet, trigger: 'test', fetchImpl: solanaMock(), sleep: async () => {}, env });
    expect(r1).toMatchObject({ status: 'ok', wallets: 1 });
    expect(r1.transfers).toBe(2); // token in + SOL out
    // A re-run must not duplicate rows.
    await prisma.trackedWallet.update({ where: { id: w.id }, data: { syncCursor: {} } });
    const r2 = await runWalletJob({ prisma, logger: quiet, trigger: 'test', fetchImpl: solanaMock(), sleep: async () => {}, env });
    expect(r2.transfers).toBe(0);
    expect(await prisma.walletTransfer.count()).toBe(2);

    // Price it via a tracked pair quoted in wSOL.
    const token = await prisma.token.create({ data: { chainId: 'solana', address: MINT, symbol: 'TEST', firstSeenSource: 'test', decimals: 6 } });
    await prisma.pair.create({
      data: { chainId: 'solana', address: 'PairAddr1', baseTokenId: token.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', isPrimary: true, priceNative: 2e-7, priceUsd: 2e-7 * 150, pairCreatedAt: new Date(Date.now() - 5 * 60_000), marketUpdatedAt: new Date() },
    });
    const rep = await walletReport(prisma, w.id);
    const p = rep.positions.find((x) => x.tokenAddress === MINT)!;
    expect(p.unit).toBe('native');
    expect(p.complete).toBe(true);
    expect(p.priceSource).toBe('primary pair, native quote');
    expect(p.value).toBeCloseTo(p.netQty * 2e-7);
    expect(p.unrealized).toBeCloseTo(p.netQty * 2e-7 - 0.05161884, 6);
    expect(p.entryMinutesAfterLaunch).not.toBeNull();
    expect(p.token.symbol).toBe('TEST');
  });

  it('records needs_config instead of failing for a chain without a source', async () => {
    await prisma.trackedWallet.create({ data: { chainId: 'base', address: '0x1111111111111111111111111111111111111111', trackedFrom: new Date() } });
    const r = await runWalletJob({ prisma, logger: quiet, trigger: 'test', env: {} });
    expect(r.status).toBe('ok');
    const w = await prisma.trackedWallet.findFirstOrThrow();
    expect(w.lastSyncStatus).toBe('needs_config');
    expect(w.lastSyncError).toMatch(/RPC_URL_BASE/);
  });

  it('finds evidence-backed connections: co-entry, direct transfer, deployer', async () => {
    const a = await prisma.trackedWallet.create({ data: { chainId: 'base', address: '0xaaa0000000000000000000000000000000000001', label: 'A', trackedFrom: new Date() } });
    const b = await prisma.trackedWallet.create({ data: { chainId: 'base', address: '0xbbb0000000000000000000000000000000000002', label: 'B', trackedFrom: new Date() } });
    const t = new Date('2026-10-14T10:00:00Z');
    const row = (walletId: string, tx: string, min: number, token: string, direction: string, counterparty: string | null = null) => ({
      walletId, chainId: 'base', txHash: tx, logIndex: 0, blockTime: new Date(t.getTime() + min * 60_000), tokenAddress: token, direction, amount: 1, amountRaw: '1', source: 'test', counterparty,
    });
    await prisma.walletTransfer.createMany({
      data: [
        row(a.id, '0x1', 0, '0xtoken', 'in'),
        row(b.id, '0x2', 4, '0xtoken', 'in'), // within 10 min → co-entry
        row(a.id, '0x3', 30, '0xother', 'in'),
        row(b.id, '0x4', 90, '0xother', 'in'), // 60 min apart → not a co-entry
        row(a.id, '0x5', 5, '0xtoken', 'out', b.address), // direct transfer A → B
      ],
    });
    const tok = await prisma.token.create({ data: { chainId: 'base', address: '0xdeployed', symbol: 'DEP', firstSeenSource: 'test' } });
    await prisma.tokenCheck.create({
      data: { tokenId: tok.id, checkId: 'holders.creator', category: 'holders', status: 'passed', severity: 'info', confidence: 'medium', title: 't', explanation: 'e', evidence: { creator_address: a.address }, source: 'goplus', observedAt: t },
    });

    const rep = await walletReport(prisma, a.id);
    const kinds = rep.connections.map((c) => c.kind).sort();
    expect(kinds).toEqual(['co_entry', 'deployer', 'direct_transfer']);
    const co = rep.connections.find((c) => c.kind === 'co_entry')!;
    expect((co.evidence.tokens as Array<{ token: string; gapSec: number }>)).toEqual([{ token: '0xtoken', gapSec: 240 }]);
    expect(rep.connections.find((c) => c.kind === 'deployer')!.text).toMatch(/DEP/);
  });
});
