/**
 * The analysis card: everything we know about one token, dense and scannable
 * (the format traders expect from a CA bot). Used for a pasted contract
 * address and for alpha calls. Unknown values print as "?" — never as safe.
 */
import type { PrismaClient } from '@outis/db';
import { explorerUrl, getChain, getLaunchpad } from '@outis/shared';
import { FOOTER, age, esc, pct, riskLine, usd } from './format';

export interface CardButton {
  text: string;
  url?: string;
  data?: string;
}

export interface Card {
  text: string;
  buttons: CardButton[][];
}

interface CheckRow {
  checkId: string;
  status: string;
  severity: string;
  title: string;
  evidence: Record<string, unknown> | null;
}

/** GMGN's chain slugs (checked against live token pages, 2026-10-14). */
const GMGN: Record<string, string> = { solana: 'sol', base: 'base', bsc: 'bsc', ethereum: 'eth' };

function price(v: number | null | undefined): string {
  if (v === null || v === undefined) return '?';
  if (v >= 1) return `$${v.toFixed(v >= 100 ? 2 : 4)}`;
  // 0.0000123 → $0.0₄123 is cute but unreadable in Telegram; keep 4 significant digits.
  return `$${v.toPrecision(4)}`;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** ✅ passed · ❌ flagged · ? not known. */
function mark(c: CheckRow | undefined): string {
  if (!c || c.status === 'not_checked' || c.status === 'error' || c.status === 'not_applicable') return '❔';
  return c.status === 'flagged' ? '❌' : '✅';
}

export function safetyLine(family: string, checks: Map<string, CheckRow>): string {
  if (family === 'solana') {
    return `🛡 Mint ${mark(checks.get('sol.mint_authority'))} · Freeze ${mark(checks.get('sol.freeze_authority'))} · Token-2022 ${mark(checks.get('sol.token2022'))} · Meta ${mark(checks.get('sol.metadata_mutable'))}`;
  }
  const tax = checks.get('evm.tax');
  const buy = num(tax?.evidence?.buy_tax);
  const sell = num(tax?.evidence?.sell_tax);
  const taxText = buy === null && sell === null ? '?' : `${buy === null ? '?' : Math.round(buy * 100)}/${sell === null ? '?' : Math.round(sell * 100)}%`;
  const lp = checks.get('liq.lp_control');
  const locked = num(lp?.evidence?.lockedOrBurnedPct);
  const lpText = lp && lp.status !== 'not_checked' ? (locked !== null ? `${Math.round(locked)}% locked/burned` : mark(lp)) : '?';
  return `🛡 Honeypot ${mark(checks.get('evm.honeypot'))} · Tax ${taxText} · Owner ${mark(checks.get('evm.ownership'))} · LP ${lpText}`;
}

export function holdersLine(checks: Map<string, CheckRow>): string | null {
  const conc = checks.get('holders.concentration');
  const top10 = num(conc?.evidence?.top10Pct);
  const count = num(conc?.evidence?.holderCount);
  const creator = num(checks.get('holders.creator')?.evidence?.creator_percent);
  const parts = [
    count !== null ? `Holders ${count.toLocaleString('en-US')}` : null,
    top10 !== null ? `Top10 ${top10.toFixed(0)}%${conc?.status === 'flagged' ? ' ⚠️' : ''}` : null,
    creator !== null ? `Dev ${(creator * 100).toFixed(1)}%` : null,
  ].filter(Boolean);
  return parts.length ? `👥 ${parts.join(' · ')}` : null;
}

export async function analysisCard(
  prisma: PrismaClient,
  tokenId: string,
  opts: { header?: string; dashboardUrl?: string | null; now?: Date; otherChains?: string[]; muteButton?: boolean } = {},
): Promise<Card | null> {
  const now = opts.now ?? new Date();
  const t = await prisma.token.findUnique({ where: { id: tokenId }, include: { pairs: { where: { isPrimary: true }, take: 1 } } });
  if (!t) return null;
  const p = t.pairs[0];
  const chain = getChain(t.chainId);
  const family = chain?.family ?? 'evm';
  const results = ((t.riskDetail as { results?: CheckRow[] } | null)?.results ?? []) as CheckRow[];
  const checks = new Map(results.map((r) => [r.checkId, r]));
  const lp = getLaunchpad(t.launchpad);
  const alpha = (t.alphaDetail ?? null) as { reasons?: string[]; cautions?: string[]; blockers?: string[] } | null;
  const tx = (p?.txns ?? null) as { h1?: { buys?: number | null; sells?: number | null; buyers?: number | null } } | null;
  const ageMin = p?.pairCreatedAt ? (now.getTime() - p.pairCreatedAt.getTime()) / 60_000 : null;
  const mc = p?.marketCapUsd ?? p?.fdvUsd ?? null;

  // Highest price we have observed for this pool → ATH market cap (ours, not all-time on-chain).
  let athMc: number | null = null;
  if (p && mc !== null && p.priceUsd) {
    const top = await prisma.marketSnapshot.aggregate({ where: { pairId: p.id }, _max: { priceUsd: true } });
    const maxPrice = Math.max(top._max.priceUsd ?? 0, p.priceUsd);
    athMc = (maxPrice / p.priceUsd) * mc;
  }

  const links = (t.links ?? {}) as { website?: string; twitter?: string; telegram?: string };
  const socials = [
    links.website ? `<a href="${esc(links.website)}">🌐 Web</a>` : null,
    links.twitter ? `<a href="${esc(links.twitter)}">𝕏</a>` : null,
    links.telegram ? `<a href="${esc(links.telegram)}">💬 TG</a>` : null,
  ].filter(Boolean);

  const stale = !p?.marketUpdatedAt || now.getTime() - p.marketUpdatedAt.getTime() > 30 * 60_000;
  const flagged = results.filter((r) => r.status === 'flagged' && ['critical', 'high', 'medium'].includes(r.severity));

  const lines = [
    opts.header ?? '',
    `💊 <b>${esc(t.name ?? t.symbol ?? t.address.slice(0, 8))}</b> ($${esc(t.symbol ?? '?')}) · ${esc(chain?.displayName ?? t.chainId)}`,
    lp ? `${t.launchpadStage === 'graduated' ? '🎓' : '🚀'} ${esc(lp.name)} · ${t.launchpadStage === 'graduated' ? `graduated${t.graduatedAt ? ` ${age((now.getTime() - t.graduatedAt.getTime()) / 60_000)} ago` : ''}` : t.launchpadStage === 'curve' ? 'on bonding curve' : 'launched'}${t.launchpadEvidence === 'address' ? ' (by address)' : ''}` : '',
    '',
    p ? `💰 ${price(p.priceUsd)} · 5m ${pct(p.priceChangeM5)} · 1h ${pct(p.priceChangeH1)} · 24h ${pct(p.priceChangeH24)}` : '💰 No trading pool found yet',
    p ? `💎 MC ${usd(mc)}${athMc !== null && athMc > (mc ?? 0) * 1.05 ? ` · ATH ${usd(athMc)} (seen)` : ''}` : '',
    p ? `💦 Liq ${usd(p.liquidityUsd)}${mc && p.liquidityUsd ? ` · MC/Liq ${(mc / p.liquidityUsd).toFixed(1)}×` : ''}` : '',
    p ? `📊 Vol 1h ${usd(p.volumeH1)} · 24h ${usd(p.volumeH24)}` : '',
    tx?.h1 ? `🔁 1h ${tx.h1.buys ?? '?'} buys · ${tx.h1.sells ?? '?'} sells${tx.h1.buyers !== null && tx.h1.buyers !== undefined ? ` · ${tx.h1.buyers} buyers` : ''}` : '',
    p ? `⏱ Age ${age(ageMin)} · ${esc(p.dexId ?? '?')}` : '',
    holdersLine(checks) ?? '',
    safetyLine(family, checks),
    `⚠️ ${riskLine(t.riskScore, t.riskLevel, t.riskCoverage)}${t.momentumScore !== null ? ` · Momentum ${t.momentumScore.toFixed(0)}` : ''}${t.alphaScore !== null ? ` · Alpha ${t.alphaScore}` : ''}`,
    flagged.length ? `🚩 ${flagged.slice(0, 4).map((f) => esc(f.title)).join(' · ')}` : '',
    alpha?.reasons?.length && (t.alphaScore ?? 0) >= 55 ? `\n🧠 <b>Why now</b>\n${alpha.reasons.slice(0, 4).map((r) => `• ${esc(r)}`).join('\n')}` : '',
    alpha?.cautions?.length && (t.alphaScore ?? 0) >= 55 ? `⚡ ${alpha.cautions.slice(0, 3).map(esc).join(' · ')}` : '',
    stale && p ? '<i>⏳ Market data is over 30 min old.</i>' : '',
    '',
    `<code>${esc(t.address)}</code>`,
    socials.length ? socials.join(' · ') : '',
    opts.otherChains?.length ? `Also on: ${opts.otherChains.map((c) => esc(getChain(c)?.displayName ?? c)).join(', ')}` : '',
    FOOTER,
  ];

  const dash = opts.dashboardUrl ? `${opts.dashboardUrl.replace(/\/$/, '')}/token/${t.chainId}/${encodeURIComponent(t.address)}` : null;
  const explorer = chain ? explorerUrl(chain, 'token', t.address) : null;
  const row1 = ([
    p?.url ? { text: '📈 Chart', url: p.url } : null,
    GMGN[t.chainId] ? { text: '🦎 GMGN', url: `https://gmgn.ai/${GMGN[t.chainId]}/token/${t.address}` } : null,
    explorer ? { text: '🔍 Explorer', url: explorer } : null,
  ] as Array<CardButton | null>).filter((b): b is CardButton => b !== null);
  const row2 = ([
    dash ? { text: '🖥 Dashboard', url: dash } : null,
    { text: '👀 Watch', data: `w:${t.id}` },
    opts.muteButton ? { text: '🔕 Mute', data: `m:${t.id}` } : null,
    { text: '🔄 Refresh', data: `r:${t.id}` },
  ] as Array<CardButton | null>).filter((b): b is CardButton => b !== null);

  return { text: lines.filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n').replace(/\n{3,}/g, '\n\n'), buttons: [row1, row2].filter((r) => r.length) };
}

/** Plain-text card (no buttons), kept for callers that only need text. */
export async function tokenCard(prisma: PrismaClient, tokenId: string, opts: { dashboardUrl?: string | null; now?: Date; otherChains?: string[] } = {}): Promise<string | null> {
  return (await analysisCard(prisma, tokenId, opts))?.text ?? null;
}
