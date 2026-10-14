/**
 * Risk checks derived from market data we already store — no external calls,
 * so they run on every scan. Each one states its thresholds in its output.
 */
import { type CheckResult, type Confidence, type Severity, notChecked, requireCheck } from '@outis/shared';

export interface MarketCheckInput {
  liquidityUsd: number | null;
  fdvUsd?: number | null;
  volumeH24: number | null;
  priceUsd: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;
  pairCreatedAt: Date | null;
  marketUpdatedAt: Date | null;
  txns: Record<string, { buys: number | null; sells: number | null; buyers: number | null; sellers: number | null } | undefined> | null;
  /** Primary-pair liquidity observations over the last hours, any source. */
  liquidityHistory: Array<{ at: Date; liquidityUsd: number | null }>;
}

function result(checkId: string, status: 'flagged' | 'passed', severity: Severity, confidence: Confidence, explanation: string, evidence: Record<string, unknown>, observedAt: Date, source = 'market'): CheckResult {
  const spec = requireCheck(checkId);
  return { checkId, category: spec.category, status, severity: status === 'passed' ? 'info' : severity, confidence, title: spec.title, explanation, evidence, source, observedAt };
}

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

export function marketChecks(m: MarketCheckInput, now: Date): CheckResult[] {
  const out: CheckResult[] = [];
  const observedAt = m.marketUpdatedAt ?? now;
  const ageMin = m.pairCreatedAt ? (now.getTime() - m.pairCreatedAt.getTime()) / 60_000 : null;

  // liq.depth
  if (m.liquidityUsd === null) out.push(notChecked(requireCheck('liq.depth'), 'No source reported liquidity for this pair (common on bonding curves).', observedAt));
  else {
    const l = m.liquidityUsd;
    const sev: Severity | null = l < 5_000 ? 'high' : l < 20_000 ? 'medium' : l < 50_000 ? 'low' : null;
    out.push(
      result('liq.depth', sev ? 'flagged' : 'passed', sev ?? 'info', 'medium', sev ? `Only ${usd(l)} of liquidity: small trades move the price sharply and exits may be impossible at size. (< $5K high, < $20K medium, < $50K low)` : `${usd(l)} of liquidity.`, { liquidityUsd: l }, observedAt),
    );
  }

  // liq.removal — compare the latest reading with the recent peak.
  const hist = m.liquidityHistory.filter((h): h is { at: Date; liquidityUsd: number } => h.liquidityUsd !== null && h.liquidityUsd > 0);
  if (hist.length < 2) out.push(notChecked(requireCheck('liq.removal'), 'Needs at least two liquidity observations; history builds with each scan.', observedAt));
  else {
    const sorted = [...hist].sort((a, b) => a.at.getTime() - b.at.getTime());
    const peak = sorted.reduce((p, h) => (h.liquidityUsd > p.liquidityUsd ? h : p));
    const latest = sorted[sorted.length - 1];
    const drop = 1 - latest.liquidityUsd / peak.liquidityUsd;
    const sev: Severity | null = drop >= 0.7 ? 'critical' : drop >= 0.4 ? 'high' : null;
    out.push(
      result(
        'liq.removal',
        sev ? 'flagged' : 'passed',
        sev ?? 'info',
        'medium',
        sev
          ? `Liquidity fell ${(drop * 100).toFixed(0)}% from its recent peak (${usd(peak.liquidityUsd)} → ${usd(latest.liquidityUsd)}). Possible liquidity pull; a falling price also shrinks USD liquidity, so confirm on-chain. (≥ 70% critical, ≥ 40% high)`
          : `Liquidity is within ${(Math.max(drop, 0) * 100).toFixed(0)}% of its recent peak.`,
        { peakUsd: peak.liquidityUsd, peakAt: peak.at.toISOString(), latestUsd: latest.liquidityUsd, latestAt: latest.at.toISOString(), observations: sorted.length },
        observedAt,
        'snapshots',
      ),
    );
  }

  // liq.implausible — a pool cannot hold more of the token's value than the token is worth.
  if (m.liquidityUsd === null) out.push(notChecked(requireCheck('liq.implausible'), 'No liquidity figure to test.', observedAt));
  else {
    const l = m.liquidityUsd;
    const fdv = m.fdvUsd ?? null;
    const reasons: string[] = [];
    // A balanced pool holds at most ~half its value in the token; > 3× FDV is not a real pool.
    if (fdv !== null && fdv > 0 && l > fdv * 3) reasons.push(`${usd(l)} liquidity against a ${usd(fdv)} FDV (${(l / fdv).toFixed(0)}×).`);
    if (l >= 5_000_000 && ageMin !== null && ageMin < 24 * 60 && m.volumeH24 !== null && m.volumeH24 < l * 0.01) {
      reasons.push(`${usd(l)} liquidity on a ${Math.round(ageMin)}-minute-old pair that has traded only ${usd(m.volumeH24)}.`);
    }
    out.push(
      result(
        'liq.implausible',
        reasons.length ? 'flagged' : 'passed',
        'high',
        'medium',
        reasons.length ? `${reasons.join(' ')} The figure is almost certainly a mispriced quote token or a fake pool — treat liquidity as unknown.` : 'Liquidity is plausible relative to FDV and activity.',
        { liquidityUsd: l, fdvUsd: fdv, volumeH24: m.volumeH24, ageMinutes: ageMin === null ? null : Math.round(ageMin) },
        observedAt,
      ),
    );
  }

  // liq.phantom — lots of "liquidity", almost no trading, after enough time to trade.
  if (m.liquidityUsd === null || m.volumeH24 === null || ageMin === null) out.push(notChecked(requireCheck('liq.phantom'), 'Needs liquidity, 24h volume and pair age.', observedAt));
  else if (ageMin < 120 || m.liquidityUsd < 50_000) out.push(result('liq.phantom', 'passed', 'info', 'low', 'Not applicable yet (pair under 2h old or liquidity under $50K).', { liquidityUsd: m.liquidityUsd, volumeH24: m.volumeH24 }, observedAt));
  else {
    const turnover = m.volumeH24 / m.liquidityUsd;
    const flagged = turnover < 0.002;
    out.push(
      result('liq.phantom', flagged ? 'flagged' : 'passed', 'medium', 'medium', flagged ? `${usd(m.liquidityUsd)} reported liquidity but only ${usd(m.volumeH24)} traded in 24h (${(turnover * 100).toFixed(3)}% turnover). The reported figure may not be usable depth — common on concentrated-liquidity/v4 pools. (< 0.2% flags)` : `24h turnover is ${(turnover * 100).toFixed(1)}% of liquidity.`, { liquidityUsd: m.liquidityUsd, volumeH24: m.volumeH24, turnover }, observedAt),
    );
  }

  const h24 = m.txns?.h24;
  // mkt.one_sided
  if (!h24 || h24.buys === null || h24.sells === null) out.push(notChecked(requireCheck('mkt.one_sided'), 'Buy/sell counts not reported.', observedAt));
  else {
    const { buys, sells } = h24 as { buys: number; sells: number };
    const sev: Severity | null = buys >= 25 && sells === 0 ? 'high' : buys >= 50 && sells / buys < 0.02 ? 'medium' : null;
    out.push(result('mkt.one_sided', sev ? 'flagged' : 'passed', sev ?? 'info', 'medium', sev ? `${buys} buys and ${sells} sells in 24h. Nobody selling is consistent with a sell restriction. (≥ 25 buys with 0 sells: high)` : `${buys} buys / ${sells} sells in 24h.`, { buysH24: buys, sellsH24: sells }, observedAt));
  }

  // mkt.wash
  if (!h24 || h24.buys === null || h24.sells === null || h24.buyers === null || h24.sellers === null) out.push(notChecked(requireCheck('mkt.wash'), 'Needs distinct trader counts (GeckoTerminal only).', observedAt));
  else {
    const txns = (h24.buys as number) + (h24.sells as number);
    const traders = (h24.buyers as number) + (h24.sellers as number);
    const ratio = traders === 0 ? Infinity : txns / traders;
    const sev: Severity | null = txns >= 200 && ratio >= 40 ? 'high' : txns >= 200 && ratio >= 15 ? 'medium' : null;
    out.push(result('mkt.wash', sev ? 'flagged' : 'passed', sev ?? 'info', 'low', sev ? `${txns} trades from only ${traders} distinct wallets (${ratio.toFixed(0)} trades per wallet) — volume may be manufactured. (≥ 15 medium, ≥ 40 high, over 200 trades)` : `${txns} trades from ${traders} wallets.`, { txnsH24: txns, tradersH24: traders }, observedAt));
  }

  // mkt.parabolic
  if (m.priceChangeH1 === null && m.priceChangeH6 === null) out.push(notChecked(requireCheck('mkt.parabolic'), 'Price change not reported.', observedAt));
  else {
    const h1 = m.priceChangeH1 ?? 0;
    const h6 = m.priceChangeH6 ?? 0;
    const flagged = h1 >= 300 || h6 >= 1000;
    out.push(result('mkt.parabolic', flagged ? 'flagged' : 'passed', 'medium', 'medium', flagged ? `Price up ${h1.toFixed(0)}% in 1h / ${h6.toFixed(0)}% in 6h. Moves this steep often reverse sharply. (≥ 300% 1h or ≥ 1000% 6h)` : 'No extreme short-term move.', { priceChangeH1: m.priceChangeH1, priceChangeH6: m.priceChangeH6 }, observedAt));
  }

  // data.stale
  {
    const age = m.marketUpdatedAt ? (now.getTime() - m.marketUpdatedAt.getTime()) / 60_000 : null;
    const sev: Severity | null = age === null || age > 360 ? 'medium' : age > 60 ? 'low' : null;
    out.push(result('data.stale', sev ? 'flagged' : 'passed', sev ?? 'info', 'high', sev ? (age === null ? 'No market observation on record.' : `Market data is ${Math.round(age)} minutes old; the current state may differ.`) : 'Market data is current.', { minutesOld: age === null ? null : Math.round(age) }, now));
  }

  // data.incomplete
  {
    const missing = [
      ['liquidity', m.liquidityUsd],
      ['pair creation time', m.pairCreatedAt],
      ['24h volume', m.volumeH24],
      ['price', m.priceUsd],
    ]
      .filter(([, v]) => v === null)
      .map(([k]) => k as string);
    const sev: Severity | null = missing.length >= 2 ? 'medium' : missing.length === 1 ? 'low' : null;
    out.push(result('data.incomplete', sev ? 'flagged' : 'passed', sev ?? 'info', 'high', sev ? `Not reported by any source: ${missing.join(', ')}. Other checks are weaker without them.` : 'All key market fields are reported.', { missing }, now));
  }
  return out;
}
