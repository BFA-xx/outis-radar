/**
 * Alert generation: DB → AlertEvent outbox rows. Delivery is separate.
 *
 * Every alert has a dedup key; inserting with skipDuplicates makes the whole
 * run idempotent, so overlapping windows (we look back a little further than
 * the last run, on purpose) can never send the same alert twice.
 */
import type { Prisma, PrismaClient } from '@outis/db';
import { type AlertKind, type AlertPrefs, explorerUrl, getChain, getLaunchpad, matchesDiscovery, matchesGraduation, readPrefs } from '@outis/shared';
import { computePositions } from '../wallets/positions';
import { FOOTER, age, esc, linkLine, pct, qty, riskLine, usd } from './format';

export interface GenerateOptions {
  now?: Date;
  /** Public dashboard base URL for links; omitted when unset. */
  dashboardUrl?: string | null;
}

export interface GenerateStats {
  subscribers: number;
  created: Record<AlertKind | 'summary', number>;
  suppressed: number;
}

const CHECKPOINT = 'alerts:generate';
const FIRST_RUN_LOOKBACK_MS = 15 * 60_000;
const OVERLAP_MS = 2 * 60_000;
const WATCH_COOLDOWN_MS = 2 * 60 * 60_000;
/** A graduation first noticed later than this is history, not news. */
export const GRADUATION_FRESH_MS = 2 * 60 * 60_000;

interface Draft {
  kind: AlertKind;
  dedupKey: string;
  text: string;
  payload: Record<string, unknown>;
}

function dashboardLink(base: string | null | undefined, path: string): string | null {
  return base ? `${base.replace(/\/$/, '')}${path}` : null;
}

export async function generateAlerts(prisma: PrismaClient, opts: GenerateOptions = {}): Promise<GenerateStats> {
  const now = opts.now ?? new Date();
  const cp = await prisma.ingestionCheckpoint.findUnique({ where: { key: CHECKPOINT } });
  const last = cp ? new Date(String((cp.cursor as { lastRunAt?: string }).lastRunAt ?? now.toISOString())) : null;
  const since = last ? new Date(last.getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);

  const subs = await prisma.telegramSubscriber.findMany({ where: { active: true } });
  const stats: GenerateStats = { subscribers: subs.length, created: { discovery: 0, launchpad: 0, risk: 0, wallet: 0, watch: 0, summary: 0 }, suppressed: 0 };
  if (subs.length === 0) {
    await saveCheckpoint(prisma, now);
    return stats;
  }

  const prefsBySub = new Map(subs.map((s) => [s.id, readPrefs(s.prefs)]));
  const watchItems = await prisma.watchlistItem.findMany();
  const watchedTokens = new Set(watchItems.filter((i) => i.kind === 'token').map((i) => `${i.chainId}:${i.address}`));

  // ── Shared inputs, loaded once for all subscribers ───────────────────────
  const maxAge = Math.max(...subs.map((s) => prefsBySub.get(s.id)!.discovery.maxAgeMinutes));
  const discoveryPool = await prisma.pair.findMany({
    where: {
      isPrimary: true,
      pairCreatedAt: { gte: new Date(now.getTime() - maxAge * 60_000) },
      // Re-assessed since the last run: covers both brand-new tokens and ones that just crossed a threshold.
      baseToken: { riskAssessedAt: { gte: since } },
    },
    include: { baseToken: true },
    take: 2000,
  });

  const graduations = await prisma.token.findMany({
    where: { graduatedAt: { gte: new Date(now.getTime() - GRADUATION_FRESH_MS) }, updatedAt: { gte: since } },
    include: { pairs: { where: { isPrimary: true }, take: 1 } },
    take: 500,
  });

  const riskRows = await prisma.riskAssessment.findMany({
    where: { computedAt: { gte: since }, OR: [{ level: { startsWith: 'severe' } }, { level: { startsWith: 'high' } }] },
    include: { token: { include: { pairs: { where: { isPrimary: true }, take: 1 } } } },
    orderBy: { computedAt: 'asc' },
  });

  const walletTxs = await prisma.walletTransfer.findMany({
    where: { createdAt: { gte: since } },
    include: { wallet: true },
    orderBy: { blockTime: 'asc' },
  });
  // Solana transfer rows carry no symbol; the token table usually has it.
  const symbolRows = walletTxs.length
    ? await prisma.token.findMany({
        where: { OR: [...new Set(walletTxs.filter((t) => t.tokenAddress !== 'native').map((t) => `${t.chainId}|${t.tokenAddress}`))].map((k) => ({ chainId: k.split('|')[0], address: k.split('|')[1] })) },
        select: { chainId: true, address: true, symbol: true },
      })
    : [];
  const symbols = new Map(symbolRows.filter((t) => t.symbol).map((t) => [`${t.chainId}|${t.address}`, t.symbol as string]));

  const watchedPairs = watchedTokens.size
    ? await prisma.pair.findMany({
        where: { isPrimary: true, marketUpdatedAt: { gte: since }, OR: [...watchedTokens].map((k) => ({ chainId: k.split(':')[0], baseToken: { address: k.slice(k.indexOf(':') + 1) } })) },
        include: { baseToken: true },
      })
    : [];

  // ── Ops: tell every subscriber once when discovery scans stop succeeding ──
  const staleAfterMs = Math.max(15, Number(process.env.STALE_SCAN_MINUTES ?? 60)) * 60_000;
  const lastOk = await prisma.scanRun.findFirst({ where: { job: 'discovery-scan', status: { in: ['ok', 'partial'] } }, orderBy: { startedAt: 'desc' }, select: { id: true, finishedAt: true, startedAt: true } });
  const lastOkAt = lastOk ? (lastOk.finishedAt ?? lastOk.startedAt) : null;
  if (lastOkAt && now.getTime() - lastOkAt.getTime() > staleAfterMs) {
    const mins = Math.round((now.getTime() - lastOkAt.getTime()) / 60_000);
    const r = await prisma.alertEvent.createMany({
      skipDuplicates: true,
      data: subs.map((s) => ({
        subscriberId: s.id,
        kind: 'ops',
        // Once per stall: keyed to the last good scan, so it re-arms after the next success.
        dedupKey: `ops:stale:${lastOk!.id}`,
        createdAt: now,
        status: 'pending',
        text: `🛠 <b>Scans have stopped</b> — the last successful discovery scan finished ${mins} min ago. Data on the dashboard is going stale. Check the GitHub Actions "scheduled-scans" runs (or the local worker).`,
      })),
    });
    stats.created.summary += r.count;
  }

  for (const sub of subs) {
    const prefs = prefsBySub.get(sub.id)!;
    const drafts: Draft[] = [];
    const chainOk = (id: string) => prefs.chains.length === 0 || prefs.chains.includes(id);

    if (prefs.kinds.discovery) drafts.push(...discoveryDrafts(discoveryPool, prefs, now, opts.dashboardUrl));

    if (prefs.kinds.launchpad) drafts.push(...graduationDrafts(graduations, prefs, now, opts.dashboardUrl));

    if (prefs.kinds.risk) {
      // Escalations only on tokens this chat cares about: watched, or previously announced to it.
      const announced = new Set(
        (await prisma.alertEvent.findMany({ where: { subscriberId: sub.id, kind: 'discovery' }, select: { payload: true } })).map((e) => String((e.payload as { tokenId?: string })?.tokenId)),
      );
      for (const r of riskRows) {
        const key = `${r.token.chainId}:${r.token.address}`;
        if (!chainOk(r.token.chainId) || !(watchedTokens.has(key) || announced.has(r.tokenId))) continue;
        drafts.push(riskDraft(r, opts.dashboardUrl));
      }
    }

    if (prefs.kinds.wallet) drafts.push(...walletDrafts(walletTxs, prefs, chainOk, opts.dashboardUrl, symbols));

    if (prefs.kinds.watch) {
      // Rolling cooldown: no repeat for the same token + direction within 2h of the last one.
      const recentWatch = new Set(
        (await prisma.alertEvent.findMany({ where: { subscriberId: sub.id, kind: 'watch', createdAt: { gte: new Date(now.getTime() - WATCH_COOLDOWN_MS) } }, select: { dedupKey: true } })).map((e) =>
          e.dedupKey.split(':').slice(0, 3).join(':'),
        ),
      );
      for (const p of watchedPairs) {
        if (!chainOk(p.chainId) || p.priceChangeH1 === null || Math.abs(p.priceChangeH1) < prefs.watch.priceMovePct) continue;
        const dir = p.priceChangeH1 > 0 ? 'up' : 'down';
        if (recentWatch.has(`watch:${p.baseTokenId}:${dir}`)) continue;
        const bucket = Math.floor(now.getTime() / WATCH_COOLDOWN_MS);
        const chain = getChain(p.chainId);
        drafts.push({
          kind: 'watch',
          dedupKey: `watch:${p.baseTokenId}:${dir}:${bucket}`,
          text: [
            `${dir === 'up' ? '📈' : '📉'} <b>WATCHLIST · ${esc(p.baseToken.symbol ?? p.baseToken.address)}</b> ${pct(p.priceChangeH1)} in 1h on ${esc(chain?.displayName ?? p.chainId)}`,
            `Price ${usd(p.priceUsd)} · Liq ${usd(p.liquidityUsd)} · Vol 1h ${usd(p.volumeH1)}`,
            riskLine(p.baseToken.riskScore, p.baseToken.riskLevel, p.baseToken.riskCoverage),
            linkLine({ chart: p.url, dashboard: dashboardLink(opts.dashboardUrl, `/token/${p.chainId}/${encodeURIComponent(p.baseToken.address)}`) }),
            FOOTER,
          ].join('\n'),
          payload: { tokenId: p.baseTokenId, priceChangeH1: p.priceChangeH1 },
        });
      }
    }

    await insertWithCap(prisma, sub.id, prefs, drafts, now, stats);
  }

  await saveCheckpoint(prisma, now);
  return stats;
}

async function saveCheckpoint(prisma: PrismaClient, now: Date): Promise<void> {
  await prisma.ingestionCheckpoint.upsert({
    where: { key: CHECKPOINT },
    create: { key: CHECKPOINT, cursor: { lastRunAt: now.toISOString() } },
    update: { cursor: { lastRunAt: now.toISOString() } },
  });
}

type PoolPair = Prisma.PairGetPayload<{ include: { baseToken: true } }>;

export function discoveryDrafts(pool: PoolPair[], prefs: AlertPrefs, now: Date, dashboardUrl?: string | null): Draft[] {
  const out: Draft[] = [];
  for (const p of pool) {
    const t = p.baseToken;
    const ageMinutes = p.pairCreatedAt ? (now.getTime() - p.pairCreatedAt.getTime()) / 60_000 : null;
    const m = matchesDiscovery(
      { chainId: p.chainId, liquidityUsd: p.liquidityUsd, volumeH24: p.volumeH24, ageMinutes, momentumScore: t.momentumScore, riskScore: t.riskScore, riskCoverage: t.riskCoverage },
      prefs,
    );
    if (!m.ok) continue;
    const chain = getChain(p.chainId);
    const detail = t.riskDetail as { results?: Array<{ status: string; title: string; severity: string }> } | null;
    const flags = (detail?.results ?? []).filter((r) => r.status === 'flagged').slice(0, 3);
    out.push({
      kind: 'discovery',
      dedupKey: `disc:${t.id}`,
      text: [
        `🛰 <b>NEW · ${esc(t.symbol ?? t.address)}</b> on ${esc(chain?.displayName ?? p.chainId)}${t.name ? ` — ${esc(t.name)}` : ''}`,
        `Age ${age(ageMinutes)} · Liq ${usd(p.liquidityUsd)} · Vol 24h ${usd(p.volumeH24)} · Txns 1h ${p.txnsH1 ?? '—'}`,
        `Momentum ${t.momentumScore?.toFixed(0) ?? '—'} · ${riskLine(t.riskScore, t.riskLevel, t.riskCoverage)}`,
        flags.length ? `Flags: ${flags.map((f) => `${esc(f.title)} (${esc(f.severity)})`).join(', ')}` : 'No flags among the checks that ran.',
        `<code>${esc(t.address)}</code>`,
        linkLine({ chart: p.url, explorer: chain ? explorerUrl(chain, 'token', t.address) : null, dashboard: dashboardLink(dashboardUrl, `/token/${p.chainId}/${encodeURIComponent(t.address)}`) }),
        FOOTER,
      ].join('\n'),
      payload: { tokenId: t.id, chainId: p.chainId, address: t.address, momentum: t.momentumScore, risk: t.riskScore },
    });
  }
  return out;
}

type GradToken = Prisma.TokenGetPayload<{ include: { pairs: true } }>;

export function graduationDrafts(tokens: GradToken[], prefs: AlertPrefs, now: Date, dashboardUrl?: string | null): Draft[] {
  const out: Draft[] = [];
  for (const t of tokens) {
    const p = t.pairs[0];
    if (!t.graduatedAt || now.getTime() - t.graduatedAt.getTime() > GRADUATION_FRESH_MS) continue;
    if (!matchesGraduation({ chainId: t.chainId, launchpad: t.launchpad, liquidityUsd: p?.liquidityUsd ?? null, riskScore: t.riskScore }, prefs).ok) continue;
    const chain = getChain(t.chainId);
    const lp = getLaunchpad(t.launchpad)?.name ?? t.launchpad;
    const mins = (now.getTime() - t.graduatedAt.getTime()) / 60_000;
    out.push({
      kind: 'launchpad',
      dedupKey: `grad:${t.id}`,
      text: [
        `🎓 <b>GRADUATED · ${esc(t.symbol ?? t.address)}</b> left the ${esc(lp ?? '')} curve on ${esc(chain?.displayName ?? t.chainId)}${t.name ? ` — ${esc(t.name)}` : ''}`,
        `${age(mins)} ago · Liq ${usd(p?.liquidityUsd)} · MC ${usd(p?.marketCapUsd ?? p?.fdvUsd)} · Vol 1h ${usd(p?.volumeH1)}`,
        riskLine(t.riskScore, t.riskLevel, t.riskCoverage),
        t.launchpadEvidence === 'address' ? 'Launchpad inferred from the token address pattern.' : '',
        `<code>${esc(t.address)}</code>`,
        linkLine({ chart: p?.url, explorer: chain ? explorerUrl(chain, 'token', t.address) : null, dashboard: dashboardLink(dashboardUrl, `/token/${t.chainId}/${encodeURIComponent(t.address)}`) }),
        FOOTER,
      ].filter(Boolean).join('\n'),
      payload: { tokenId: t.id, chainId: t.chainId, address: t.address, launchpad: t.launchpad, graduatedAt: t.graduatedAt.toISOString() },
    });
  }
  return out;
}

type RiskRow = Prisma.RiskAssessmentGetPayload<{ include: { token: { include: { pairs: true } } } }>;

function riskDraft(r: RiskRow, dashboardUrl?: string | null): Draft {
  const t = r.token;
  const chain = getChain(t.chainId);
  const level = r.level.split(':')[0];
  return {
    kind: 'risk',
    // One alert per token per level reached: a token going high → severe alerts twice, not every scan.
    dedupKey: `risk:${t.id}:${level}`,
    text: [
      `⚠️ <b>RISK ${level.toUpperCase()} · ${esc(t.symbol ?? t.address)}</b> on ${esc(chain?.displayName ?? t.chainId)}`,
      `Score ${r.score} · ${Math.round(r.coverage * 100)}% of checks ran`,
      `Flagged: ${r.flaggedChecks.map(esc).join(', ') || '—'}`,
      linkLine({ chart: t.pairs[0]?.url, dashboard: dashboardLink(dashboardUrl, `/token/${t.chainId}/${encodeURIComponent(t.address)}`) }),
      FOOTER,
    ].join('\n'),
    payload: { tokenId: t.id, score: r.score, level: r.level, flagged: r.flaggedChecks },
  };
}

type WalletTx = Prisma.WalletTransferGetPayload<{ include: { wallet: true } }>;

/** More trades than this from one wallet in one run become a single digest. */
const WALLET_DIGEST_OVER = 3;

export function walletDrafts(
  rows: WalletTx[],
  prefs: AlertPrefs,
  chainOk: (id: string) => boolean,
  dashboardUrl?: string | null,
  symbols: Map<string, string> = new Map(),
): Draft[] {
  // Group legs by wallet + transaction; history from before tracking began never alerts.
  const groups = new Map<string, WalletTx[]>();
  for (const r of rows) {
    if (!chainOk(r.chainId) || r.blockTime < r.wallet.trackedFrom) continue;
    const k = `${r.walletId}|${r.txHash}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  interface Trade {
    wallet: WalletTx['wallet'];
    txHash: string;
    side: string;
    qty: number;
    symbol: string;
    token: string;
    quote: number | null;
    unit: string | null;
    line: string;
  }
  const trades: Trade[] = [];
  for (const legs of groups.values()) {
    const w = legs[0].wallet;
    const chain = getChain(w.chainId);
    const ns = chain?.nativeAsset.symbol ?? 'native';
    const [pos] = computePositions(w.chainId, legs);
    if (!pos) continue; // money-only transaction: not a trade
    const ev = pos.events[0];
    if (!ev) continue;
    if (ev.quote !== null && ev.unit === 'native' && ev.quote < prefs.wallet.minNative) continue;
    if (ev.quote !== null && ev.unit === 'usd' && ev.quote < prefs.wallet.minUsd) continue;
    const verb = { buy: 'bought', sell: 'sold', transfer_in: 'received', transfer_out: 'sent' }[ev.side];
    const paid = ev.quote === null ? '' : ` for ${ev.unit === 'usd' ? usd(ev.quote) : `${ev.quote.toPrecision(3)} ${ns}`}`;
    const symbol = symbols.get(`${w.chainId}|${pos.tokenAddress}`) ?? pos.symbol ?? `${pos.tokenAddress.slice(0, 6)}…`;
    trades.push({ wallet: w, txHash: legs[0].txHash, side: ev.side, qty: ev.qty, symbol, token: pos.tokenAddress, quote: ev.quote, unit: ev.unit, line: `${verb} ${qty(ev.qty)} <b>${esc(symbol)}</b>${paid}` });
  }

  const byWallet = new Map<string, Trade[]>();
  for (const t of trades) byWallet.set(t.wallet.id, [...(byWallet.get(t.wallet.id) ?? []), t]);

  const out: Draft[] = [];
  for (const [walletId, list] of byWallet) {
    const w = list[0].wallet;
    const chain = getChain(w.chainId);
    const name = esc(w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`);
    const dash = dashboardLink(dashboardUrl, `/wallets/${w.id}`);
    if (list.length > WALLET_DIGEST_OVER) {
      // A busy wallet gets one message per run, keyed to its newest trade so it never repeats.
      const buys = list.filter((t) => t.side === 'buy').length;
      const sells = list.filter((t) => t.side === 'sell').length;
      out.push({
        kind: 'wallet',
        dedupKey: `wal-digest:${walletId}:${list[list.length - 1].txHash}`,
        text: [
          `👛 <b>${name}</b> made ${list.length} trades on ${esc(chain?.displayName ?? w.chainId)} (${buys} buys, ${sells} sells)`,
          ...list.slice(-5).reverse().map((t) => `• ${t.line}`),
          list.length > 5 ? `…and ${list.length - 5} more` : '',
          linkLine({ dashboard: dash }),
        ].filter(Boolean).join('\n'),
        payload: { walletId, trades: list.length, buys, sells },
      });
      continue;
    }
    for (const t of list) {
      out.push({
        kind: 'wallet',
        dedupKey: `wal:${walletId}:${t.txHash}`,
        text: [
          `👛 <b>${name}</b> ${t.line} on ${esc(chain?.displayName ?? w.chainId)}`,
          `<code>${esc(t.token)}</code>`,
          linkLine({ explorer: chain?.explorer ? `${chain.explorer.baseUrl}${chain.explorer.txPath(t.txHash)}` : null, dashboard: dash }),
        ].join('\n'),
        payload: { walletId, txHash: t.txHash, side: t.side, token: t.token, quote: t.quote, unit: t.unit },
      });
    }
  }
  return out;
}

/** Insert drafts; past the hourly cap they are kept as "suppressed" and summarized once. */
async function insertWithCap(prisma: PrismaClient, subscriberId: string, prefs: AlertPrefs, drafts: Draft[], now: Date, stats: GenerateStats): Promise<void> {
  if (drafts.length === 0) return;
  const existing = new Set(
    (await prisma.alertEvent.findMany({ where: { subscriberId, dedupKey: { in: drafts.map((d) => d.dedupKey) } }, select: { dedupKey: true } })).map((e) => e.dedupKey),
  );
  const fresh = drafts.filter((d, i) => !existing.has(d.dedupKey) && drafts.findIndex((x) => x.dedupKey === d.dedupKey) === i);
  if (fresh.length === 0) return;
  const lastHour = await prisma.alertEvent.count({ where: { subscriberId, status: { in: ['pending', 'sent'] }, kind: { not: 'summary' }, createdAt: { gte: new Date(now.getTime() - 60 * 60_000) } } });
  let room = Math.max(0, prefs.maxPerHour - lastHour);
  // Risk escalations first; then the other kinds take turns, so one noisy
  // source (a hyperactive wallet) cannot crowd out everything else.
  const risk = fresh.filter((d) => d.kind === 'risk');
  const queues = (['wallet', 'launchpad', 'watch', 'discovery'] as const).map((k) => fresh.filter((d) => d.kind === k));
  const interleaved: Draft[] = [...risk];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) interleaved.push(q.shift()!);
  fresh.splice(0, fresh.length, ...interleaved);
  let suppressed = 0;
  const rows = fresh.map((d) => {
    const send = room > 0;
    if (send) room--;
    else suppressed++;
    if (send) stats.created[d.kind]++;
    // createdAt from the generator's clock, so cooldowns and the hourly cap all use one timeline.
    return { subscriberId, kind: d.kind, dedupKey: d.dedupKey, text: d.text, payload: d.payload as Prisma.InputJsonValue, status: send ? 'pending' : 'suppressed', createdAt: now };
  });
  await prisma.alertEvent.createMany({ data: rows, skipDuplicates: true });
  if (suppressed > 0) {
    stats.suppressed += suppressed;
    const hour = Math.floor(now.getTime() / 3_600_000);
    const r = await prisma.alertEvent.createMany({
      skipDuplicates: true,
      data: [{ subscriberId, kind: 'summary', dedupKey: `summary:${hour}`, createdAt: now, text: `🔕 Hourly limit reached (${prefs.maxPerHour}/h). Further alerts this hour are held back — they are listed on the dashboard. Change with /set perhour.`, status: 'pending' }],
    });
    stats.created.summary += r.count;
  }
}
