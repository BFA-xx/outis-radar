/** Alert generation + delivery against a real Postgres (DATABASE_URL_TEST). */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_PREFS } from '@outis/shared';
import { classifyTokens } from '../launchpads';
import { syncChains } from '../persist';
import { type Sender, deliverPending } from './deliver';
import { generateAlerts } from './generate';
import { esc } from './format';

const envFile = resolve(__dirname, '../../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;

describe('esc', () => {
  it('escapes HTML so token names cannot inject markup', () => {
    expect(esc('<b>RUG</b> & co')).toBe('&lt;b&gt;RUG&lt;/b&gt; &amp; co');
  });
});

describe.skipIf(!url)('alerts (Postgres)', () => {
  let prisma: PrismaClient;
  const now = new Date();
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await syncChains(prisma);
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "AlertEvent", "TelegramSubscriber", "WatchlistItem", "Watchlist", "WalletTransfer", "TrackedWallet", "RiskAssessment", "Pair", "Token", "IngestionCheckpoint", "ScanRun" CASCADE',
    );
  });

  // The raw feeds are opt-in since alpha calls; these tests exercise them.
  const RAW = { ...DEFAULT_ALERT_PREFS, kinds: { ...DEFAULT_ALERT_PREFS.kinds, discovery: true, launchpad: true } };
  async function sub(prefs = RAW, chatId = 111n) {
    return prisma.telegramSubscriber.create({ data: { chatId, prefs: prefs as object } });
  }

  async function token(symbol: string, o: { liq?: number; vol?: number; mom?: number; risk?: number; cov?: number; ageMin?: number; chg?: number; chainId?: string } = {}) {
    const t = await prisma.token.create({
      data: {
        chainId: o.chainId ?? 'solana',
        address: `${symbol}Mint1111111111111111111111111111111`,
        symbol,
        firstSeenSource: 'test',
        momentumScore: o.mom ?? 70,
        riskScore: o.risk ?? 10,
        riskCoverage: o.cov ?? 0.8,
        riskLevel: 'no_major_flags',
        riskAssessedAt: now,
      },
    });
    await prisma.pair.create({
      data: {
        chainId: o.chainId ?? 'solana',
        address: `${symbol}-pair`,
        baseTokenId: t.id,
        quoteTokenAddress: 'So11111111111111111111111111111111111111112',
        isPrimary: true,
        pairCreatedAt: minsAgo(o.ageMin ?? 30),
        liquidityUsd: o.liq ?? 50_000,
        volumeH24: o.vol ?? 40_000,
        priceChangeH1: o.chg ?? 5,
        marketUpdatedAt: now,
      },
    });
    return t;
  }

  it('announces a matching new token once, and never one below the bar', async () => {
    const s = await sub();
    await token('GOOD');
    await token('THIN', { liq: 1_000 });
    await token('RISKY', { risk: 70 });
    await token('UNSURE', { cov: 0.2 });
    const g1 = await generateAlerts(prisma, { now });
    expect(g1.created.discovery).toBe(1);
    const ev = await prisma.alertEvent.findFirstOrThrow({ where: { subscriberId: s.id } });
    expect(ev.text).toContain('GOOD');
    expect(ev.text).toContain('Research only');
    // Re-running (overlapping window) never duplicates.
    const g2 = await generateAlerts(prisma, { now: new Date(now.getTime() + 60_000) });
    expect(g2.created.discovery).toBe(0);
    expect(await prisma.alertEvent.count()).toBe(1);
  });

  it('announces a fresh launchpad graduation once; old graduations and unselected launchpads stay quiet', async () => {
    const prefs = { ...RAW, kinds: { ...RAW.kinds, discovery: false } };
    await sub(prefs);
    await sub({ ...prefs, launchpad: { ...prefs.launchpad, ids: ['fourmeme'] } }, 222n);
    const grad = async (symbol: string, gradMinsAgo: number) => {
      const t = await token(symbol, { risk: 30 });
      // The curve pool, then the graduation pool on PumpSwap.
      await prisma.pair.update({ where: { chainId_address: { chainId: 'solana', address: `${symbol}-pair` } }, data: { dexId: 'pumpfun' } });
      await prisma.pair.create({ data: { chainId: 'solana', address: `${symbol}-amm`, dexId: 'pumpswap', baseTokenId: t.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', pairCreatedAt: minsAgo(gradMinsAgo) } });
      return t;
    };
    const fresh = await grad('FRESH', 20);
    await grad('STALE', 300);
    await token('PLAIN'); // no launchpad evidence at all
    const c = await classifyTokens(prisma, undefined, now);
    expect(c.graduated).toBe(2);
    expect((await prisma.token.findUniqueOrThrow({ where: { id: fresh.id } })).graduatedAt?.getTime()).toBe(minsAgo(20).getTime());
    const g = await generateAlerts(prisma, { now });
    expect(g.created.launchpad).toBe(1); // FRESH to chat 111 only; chat 222 wants four.meme
    const ev = await prisma.alertEvent.findFirstOrThrow({ where: { kind: 'launchpad' } });
    expect(ev.text).toContain('GRADUATED · FRESH');
    expect(ev.text).toContain('pump.fun');
    expect((await generateAlerts(prisma, { now: new Date(now.getTime() + 60_000) })).created.launchpad).toBe(0);
  });

  it('warns once when discovery scans stop succeeding, and re-arms after the next good scan', async () => {
    await sub();
    const run = await prisma.scanRun.create({ data: { job: 'discovery-scan', status: 'ok', trigger: 'test', startedAt: minsAgo(130), finishedAt: minsAgo(125) } });
    await generateAlerts(prisma, { now });
    await generateAlerts(prisma, { now: new Date(now.getTime() + 60_000) });
    const ops = await prisma.alertEvent.findMany({ where: { kind: 'ops' } });
    expect(ops).toHaveLength(1);
    expect(ops[0].dedupKey).toBe(`ops:stale:${run.id}`);
    expect(ops[0].text).toContain('Scans have stopped');
    await prisma.scanRun.create({ data: { job: 'discovery-scan', status: 'ok', trigger: 'test', startedAt: minsAgo(1), finishedAt: now } });
    await generateAlerts(prisma, { now: new Date(now.getTime() + 120_000) });
    expect(await prisma.alertEvent.count({ where: { kind: 'ops' } })).toBe(1);
  });

  it('alpha: one call per token with a card and buttons; muted tokens stay silent; follow-ups reply under the call; recap scores it', async () => {
    const a = await sub(DEFAULT_ALERT_PREFS, 1n);
    const t = await token('ALPHA', { liq: 60_000 });
    const muted = await token('MUTED', { liq: 60_000 });
    for (const x of [t, muted]) {
      await prisma.token.update({ where: { id: x.id }, data: { alphaScore: 82, alphaTier: 'alpha', alphaAt: now, alphaDetail: { reasons: ['Volume accelerating — last 5 min at 3.0× the hour\'s pace'], cautions: [], blockers: [] } } });
      await prisma.pair.update({ where: { chainId_address: { chainId: 'solana', address: `${x.symbol}-pair` } }, data: { priceUsd: 0.001, marketCapUsd: 100_000 } });
    }
    await prisma.telegramSubscriber.update({ where: { id: a.id }, data: { prefs: { ...DEFAULT_ALERT_PREFS, mutedTokens: [muted.id] } as object } });

    const g = await generateAlerts(prisma, { now, dashboardUrl: 'https://radar.example' });
    expect(g.created.alpha).toBe(1);
    const call = await prisma.alertEvent.findFirstOrThrow({ where: { kind: 'alpha' } });
    expect(call.text).toContain('ALPHA CALL');
    expect(call.text).toContain('Why now');
    expect(call.text).toContain('accelerating');
    const buttons = (call.payload as { buttons: Array<Array<{ text: string; url?: string; data?: string }>> }).buttons.flat();
    expect(buttons.some((b) => b.url === `https://radar.example/token/solana/${t.address}`)).toBe(true);
    expect(buttons.some((b) => b.data === `m:${t.id}`)).toBe(true);
    expect((await generateAlerts(prisma, { now: new Date(now.getTime() + 60_000) })).created.alpha).toBe(0); // once per token

    // Deliver it (Telegram gives it message id 501), then the price doubles.
    const sent: Array<{ html: string; replyTo?: number; buttons?: unknown }> = [];
    await deliverPending(prisma, async (_c, html, o) => (sent.push({ html, replyTo: o?.replyToMessageId, buttons: o?.buttons }), { ok: true, messageId: 501 + sent.length - 1 }), { sleep: async () => undefined });
    expect(sent[0].buttons).toBeTruthy();
    expect((await prisma.alertEvent.findUniqueOrThrow({ where: { id: call.id } })).telegramMessageId).toBe(501n);
    await prisma.pair.update({ where: { chainId_address: { chainId: 'solana', address: 'ALPHA-pair' } }, data: { priceUsd: 0.0021, marketCapUsd: 210_000, marketUpdatedAt: new Date(now.getTime() + 30 * 60_000) } });
    const later = new Date(now.getTime() + 31 * 60_000);
    expect((await generateAlerts(prisma, { now: later })).created.followup).toBe(1);
    sent.length = 0;
    await deliverPending(prisma, async (_c, html, o) => (sent.push({ html, replyTo: o?.replyToMessageId }), { ok: true, messageId: 900 }), { sleep: async () => undefined });
    expect(sent[0].html).toMatch(/ALPHA 2\.1×/);
    expect(sent[0].replyTo).toBe(501);
    expect((await generateAlerts(prisma, { now: new Date(later.getTime() + 60_000) })).created.followup).toBe(0); // 2× only once

    const { recapDraft } = await import('./generate');
    const recap = await recapDraft(prisma, a.id, later);
    expect(recap?.text).toContain('1 call in 24h');
    expect(recap?.text).toContain('$ALPHA');
  });

  it('respects chain filters and switched-off kinds', async () => {
    await sub({ ...RAW, chains: ['base'] }, 1n);
    await sub({ ...RAW, kinds: { ...RAW.kinds, discovery: false } }, 2n);
    await token('SOLTOK');
    const g = await generateAlerts(prisma, { now });
    expect(g.created.discovery).toBe(0);
  });

  it('escalates risk only for tokens the chat watches or was told about', async () => {
    await sub();
    const watched = await token('WATCHED', { liq: 1 }); // below discovery bar
    const stranger = await token('STRANGER', { liq: 1 });
    const list = await prisma.watchlist.create({ data: { name: 'L' } });
    await prisma.watchlistItem.create({ data: { watchlistId: list.id, kind: 'token', chainId: 'solana', address: watched.address } });
    for (const t of [watched, stranger]) {
      await prisma.riskAssessment.create({ data: { tokenId: t.id, score: 90, level: 'severe', coverage: 0.9, categories: {}, flaggedChecks: ['liq.removal'], computedAt: now } });
    }
    const g = await generateAlerts(prisma, { now });
    expect(g.created.risk).toBe(1);
    const ev = await prisma.alertEvent.findFirstOrThrow({ where: { kind: 'risk' } });
    expect(ev.text).toContain('WATCHED');
    expect(ev.dedupKey).toBe(`risk:${watched.id}:severe`);
  });

  it('alerts tracked-wallet trades, but not history from before tracking began', async () => {
    await sub();
    const w = await prisma.trackedWallet.create({ data: { chainId: 'solana', address: 'Wallet11111111111111111111111111111111111111', label: 'whale', trackedFrom: minsAgo(60) } });
    const leg = (tx: string, at: Date, token: string, direction: string, amount: number) => ({ walletId: w.id, chainId: 'solana', txHash: tx, logIndex: 0, blockTime: at, tokenAddress: token, direction, amount, amountRaw: '1', decimals: 9, source: 'test' });
    await prisma.walletTransfer.createMany({
      data: [
        leg('new', minsAgo(5), 'TokMint', 'in', 1_000_000), leg('new', minsAgo(5), 'native', 'out', 0.5),
        leg('old', minsAgo(600), 'TokMint', 'in', 10), leg('old', minsAgo(600), 'native', 'out', 0.1),
      ],
    });
    const g = await generateAlerts(prisma, { now });
    expect(g.created.wallet).toBe(1);
    const ev = await prisma.alertEvent.findFirstOrThrow({ where: { kind: 'wallet' } });
    expect(ev.text).toMatch(/whale<\/b> bought 1\.00M/);
    expect(ev.text).toContain('0.500 SOL');
  });

  it('a hyperactive wallet becomes one digest, and cannot crowd out new-token alerts', async () => {
    await sub({ ...RAW, maxPerHour: 3 });
    const w = await prisma.trackedWallet.create({ data: { chainId: 'solana', address: 'Busy111111111111111111111111111111111111111', label: 'busy', trackedFrom: minsAgo(60) } });
    const rows = Array.from({ length: 8 }, (_, i) => [
      { walletId: w.id, chainId: 'solana', txHash: `tx${i}`, logIndex: 0, blockTime: minsAgo(10 - i), tokenAddress: `T${i}`, direction: 'in', amount: 100, amountRaw: '1', decimals: 9, source: 'test' },
      { walletId: w.id, chainId: 'solana', txHash: `tx${i}`, logIndex: 0, blockTime: minsAgo(10 - i), tokenAddress: 'native', direction: 'out', amount: 0.1, amountRaw: '1', decimals: 9, source: 'test' },
    ]).flat();
    await prisma.walletTransfer.createMany({ data: rows });
    await token('FRESH1');
    await token('FRESH2');
    const g = await generateAlerts(prisma, { now });
    expect(g.created.wallet).toBe(1); // one digest, not 8 messages
    expect(g.created.discovery).toBe(2); // still room for new tokens
    const digest = await prisma.alertEvent.findFirstOrThrow({ where: { kind: 'wallet' } });
    expect(digest.text).toMatch(/made 8 trades/);
  });

  it('watchlist moves alert once per direction per 2h window', async () => {
    await sub();
    const t = await token('MOVER', { liq: 1, chg: 40 });
    const list = await prisma.watchlist.create({ data: { name: 'L' } });
    await prisma.watchlistItem.create({ data: { watchlistId: list.id, kind: 'token', chainId: 'solana', address: t.address } });
    expect((await generateAlerts(prisma, { now })).created.watch).toBe(1);
    expect((await generateAlerts(prisma, { now: new Date(now.getTime() + 10 * 60_000) })).created.watch).toBe(0);
  });

  it('the watch cooldown is rolling: no repeat across a 2h bucket boundary', async () => {
    await sub();
    const t = await token('EDGE', { liq: 1, chg: 40 });
    const list = await prisma.watchlist.create({ data: { name: 'L' } });
    await prisma.watchlistItem.create({ data: { watchlistId: list.id, kind: 'token', chainId: 'solana', address: t.address } });
    const boundary = Math.ceil(now.getTime() / 7_200_000) * 7_200_000;
    const before = new Date(boundary - 5 * 60_000);
    const after = new Date(boundary + 5 * 60_000);
    await prisma.pair.updateMany({ where: { baseTokenId: t.id }, data: { marketUpdatedAt: before } });
    expect((await generateAlerts(prisma, { now: before })).created.watch).toBe(1);
    await prisma.pair.updateMany({ where: { baseTokenId: t.id }, data: { marketUpdatedAt: after } });
    expect((await generateAlerts(prisma, { now: after })).created.watch).toBe(0);
  });

  it('holds back alerts past the hourly cap and sends one summary instead', async () => {
    await sub({ ...RAW, maxPerHour: 2 });
    for (const s of ['A1', 'A2', 'A3', 'A4']) await token(s);
    const g = await generateAlerts(prisma, { now });
    expect(g.created.discovery).toBe(2);
    expect(g.suppressed).toBe(2);
    expect(g.created.summary).toBe(1);
    expect(await prisma.alertEvent.count({ where: { status: 'suppressed' } })).toBe(2);
  });

  it('first run looks back 15 minutes only — no blast of history', async () => {
    await sub();
    const t = await token('OLD');
    await prisma.token.update({ where: { id: t.id }, data: { riskAssessedAt: minsAgo(120) } });
    expect((await generateAlerts(prisma, { now })).created.discovery).toBe(0);
  });

  describe('delivery', () => {
    async function queue(n: number, chatId = 5n) {
      const s = await sub(DEFAULT_ALERT_PREFS, chatId);
      for (let i = 0; i < n; i++) await prisma.alertEvent.create({ data: { subscriberId: s.id, kind: 'discovery', dedupKey: `k${i}`, text: `msg ${i}` } });
      return s;
    }

    it('sends in order, spaced per chat, and marks rows sent', async () => {
      await queue(3);
      const sent: string[] = [];
      const waits: number[] = [];
      const send: Sender = async (_c, html) => {
        sent.push(html);
        return { ok: true };
      };
      const d = await deliverPending(prisma, send, { sleep: async (ms) => void waits.push(ms) });
      expect(d.sent).toBe(3);
      expect(sent).toEqual(['msg 0', 'msg 1', 'msg 2']);
      expect(waits.length).toBe(2); // gaps between consecutive messages to the same chat
      expect(await prisma.alertEvent.count({ where: { status: 'sent' } })).toBe(3);
    });

    it('on a Telegram 429 it stops the round and keeps the rest pending', async () => {
      await queue(3);
      const d = await deliverPending(prisma, async () => ({ ok: false, retryAfterMs: 5000, error: 'rate limited' }), { sleep: async () => {} });
      expect(d.deferred).toBe(1);
      expect(await prisma.alertEvent.count({ where: { status: 'pending' } })).toBe(3);
    });

    it('a blocked chat pauses the subscriber instead of retrying forever', async () => {
      const s = await queue(2);
      const d = await deliverPending(prisma, async () => ({ ok: false, permanent: true, error: 'Forbidden: bot was blocked by the user' }), { sleep: async () => {} });
      expect(d.deactivated).toBe(1);
      expect((await prisma.telegramSubscriber.findUniqueOrThrow({ where: { id: s.id } })).active).toBe(false);
    });

    it('gives up after 3 failed attempts', async () => {
      await queue(1);
      const fail: Sender = async () => ({ ok: false, error: 'network' });
      for (let i = 0; i < 3; i++) await deliverPending(prisma, fail, { sleep: async () => {} });
      expect((await prisma.alertEvent.findFirstOrThrow()).status).toBe('failed');
    });
  });
});
