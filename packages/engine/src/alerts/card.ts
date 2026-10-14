/**
 * The reply to a pasted contract address: everything we know about the
 * token, with unknowns shown as unknown — never as safe.
 */
import type { PrismaClient } from '@outis/db';
import { explorerUrl, getChain, getLaunchpad } from '@outis/shared';
import { FOOTER, age, esc, linkLine, pct, riskLine, usd } from './format';

const STAGE: Record<string, string> = { curve: 'on bonding curve', graduated: 'graduated', launched: 'launched' };

export async function tokenCard(prisma: PrismaClient, tokenId: string, opts: { dashboardUrl?: string | null; now?: Date; otherChains?: string[] } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  const t = await prisma.token.findUnique({ where: { id: tokenId }, include: { pairs: { where: { isPrimary: true }, take: 1 } } });
  if (!t) return null;
  const p = t.pairs[0];
  const chain = getChain(t.chainId);
  const ageMin = p?.pairCreatedAt ? (now.getTime() - p.pairCreatedAt.getTime()) / 60_000 : null;
  const lp = getLaunchpad(t.launchpad);
  const detail = t.riskDetail as { results?: Array<{ status: string; title: string; severity: string }> } | null;
  const flags = (detail?.results ?? []).filter((r) => r.status === 'flagged');
  const tx = (p?.txns ?? null) as { h1?: { buys?: number | null; sells?: number | null } } | null;
  const dash = opts.dashboardUrl ? `${opts.dashboardUrl.replace(/\/$/, '')}/token/${t.chainId}/${encodeURIComponent(t.address)}` : null;
  const stale = p?.marketUpdatedAt ? now.getTime() - p.marketUpdatedAt.getTime() > 30 * 60_000 : true;

  return [
    `🔎 <b>${esc(t.symbol ?? t.address.slice(0, 8))}</b>${t.name ? ` — ${esc(t.name)}` : ''} · ${esc(chain?.displayName ?? t.chainId)}`,
    lp ? `${t.launchpadStage === 'graduated' ? '🎓' : '🚀'} ${esc(lp.name)} · ${STAGE[t.launchpadStage ?? ''] ?? '—'}${t.launchpadEvidence === 'address' ? ' (from address pattern)' : ''}` : '',
    p
      ? [
          `Price ${p.priceUsd === null ? '—' : `$${p.priceUsd < 1 ? p.priceUsd.toPrecision(4) : p.priceUsd.toFixed(4)}`} · 1h ${pct(p.priceChangeH1)} · 24h ${pct(p.priceChangeH24)}`,
          `MC ${usd(p.marketCapUsd ?? p.fdvUsd)} · Liq ${usd(p.liquidityUsd)} · Vol 24h ${usd(p.volumeH24)}`,
          `Age ${age(ageMin)} · Txns 1h ${tx?.h1 ? `${tx.h1.buys ?? '—'} buys / ${tx.h1.sells ?? '—'} sells` : '—'} · ${esc(p.dexId ?? '—')}`,
        ].join('\n')
      : 'No trading pool found yet.',
    stale && p ? '<i>Market data is over 30 min old.</i>' : '',
    `Momentum ${t.momentumScore?.toFixed(0) ?? '—'} · ${riskLine(t.riskScore, t.riskLevel, t.riskCoverage)}`,
    flags.length ? `⚠️ ${flags.slice(0, 4).map((f) => `${esc(f.title)} (${esc(f.severity)})`).join(', ')}` : t.riskScore !== null ? 'No flags among the checks that ran.' : '',
    `<code>${esc(t.address)}</code>`,
    opts.otherChains?.length ? `Also trades on: ${opts.otherChains.map((c) => esc(getChain(c)?.displayName ?? c)).join(', ')}` : '',
    linkLine({ chart: p?.url, explorer: chain ? explorerUrl(chain, 'token', t.address) : null, dashboard: dash }),
    FOOTER,
  ]
    .filter(Boolean)
    .join('\n');
}
