import Link from 'next/link';
import { ApiDown, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import type { PerformanceReport, StatsT } from '@/lib/types';

export const dynamic = 'force-dynamic';

const pct = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const cls = (v: number | null) => (v === null ? 'text-faint' : v > 0 ? 'text-accent' : v < 0 ? 'text-bad' : 'text-muted');
const BREAKDOWN_LABEL = { chain: 'By chain', launchpad: 'By launchpad', age: 'By pair age at signal', momentum: 'By momentum at signal', risk: 'By risk at signal' } as const;

export default async function PerformancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const horizon = ['15m', '1h', '4h', '24h'].includes(sp.h ?? '') ? sp.h! : '4h';
  const res = await api<PerformanceReport>(`/performance?horizon=${horizon}`);
  if (!res.ok) return <ApiDown message={res.message} />;
  const r = res.data;
  const min = r.minMeaningfulSample;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Signal performance"
        sub={
          <>
            What would have happened after each signal. Entry is the first price observed at least a minute <em>after</em> the signal (usually the next scan, ~10 min) —
            never the price that triggered it. Returns are net of fees, slippage and modelled price impact on a $100 position. A liquidity collapse counts as −100%.
            {r.firstSignalAt ? ` Recording since ${new Date(r.firstSignalAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : ''}
          </>
        }
      />

      <div className="glass inline-flex rounded-xl p-1 text-sm">
        {r.horizons.map((h) => (
          <Link key={h.key} href={`/performance?h=${h.key}`} className={`rounded-lg px-3 py-1.5 ${horizon === h.key ? 'bg-white/[0.09] text-ink' : 'text-muted hover:text-ink'}`}>
            +{h.key}
          </Link>
        ))}
        <span className="px-3 py-1.5 text-xs text-faint">breakdowns use this horizon</span>
      </div>

      {r.rules.map((rule) => (
        <Panel key={rule.id} title={`${rule.label} · ${rule.signals} signal(s)`}>
          <p className="border-b border-line px-5 py-2.5 text-xs text-muted">{rule.description}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-muted">
                <tr className="border-b border-line">
                  {['Horizon', 'n', 'Win rate', 'Expectancy', 'Median', 'Pessimistic', 'Best / worst', 'Collapsed', 'No data', 'Pending'].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-medium" title={h === 'Pessimistic' ? 'Expectancy if every "no data" outcome is counted as −100% (tokens that vanish are rarely winners)' : undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.horizons.map((h) => {
                  const b = rule.byHorizon[h.key];
                  const o = b.observed;
                  return (
                    <tr key={h.key} className={`border-b border-white/[0.045] last:border-0 ${h.key === horizon ? 'bg-white/[0.025]' : ''}`}>
                      <td className="px-4 py-2.5">+{h.key}</td>
                      <td className="num px-4 py-2.5">
                        {o.n}
                        {o.n > 0 && o.n < min && <span className="ml-1 text-xs text-warn" title={`Fewer than ${min}: not statistically meaningful`}>low n</span>}
                      </td>
                      <td className="num px-4 py-2.5">{o.winRate === null ? '—' : `${Math.round(o.winRate * 100)}%`}</td>
                      <td className={`num px-4 py-2.5 ${cls(o.expectancyPct)}`}>{pct(o.expectancyPct)}</td>
                      <td className={`num px-4 py-2.5 ${cls(o.medianPct)}`}>{pct(o.medianPct)}</td>
                      <td className={`num px-4 py-2.5 ${cls(b.pessimistic.expectancyPct)}`}>{pct(b.pessimistic.expectancyPct)}</td>
                      <td className="num px-4 py-2.5 text-xs text-muted">{pct(o.bestPct)} / {pct(o.worstPct)}</td>
                      <td className="num px-4 py-2.5">{b.collapsed}</td>
                      <td className="num px-4 py-2.5">{b.noData}</td>
                      <td className="num px-4 py-2.5 text-faint">{b.pending}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid gap-px border-t border-line sm:grid-cols-2 lg:grid-cols-5">
            {(Object.keys(BREAKDOWN_LABEL) as Array<keyof typeof BREAKDOWN_LABEL>).map((k) => (
              <Breakdown key={k} title={BREAKDOWN_LABEL[k]} rows={rule.breakdown[k]} min={min} />
            ))}
          </div>
          <p className="border-t border-line px-5 py-2.5 text-xs text-faint">
            Average best move after entry {pct(rule.avgMfePct)} · average worst {pct(rule.avgMaePct)} (gross, first 24h).
          </p>
        </Panel>
      ))}

      <Panel title="Most recent signals">
        {r.recent.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No signals yet. They are recorded automatically as scans assess tokens.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-muted">
                <tr className="border-b border-line">
                  {['Token', 'Fired', 'Rule', 'Chain', 'Momentum', 'Risk', '+15m', '+1h', '+4h', '+24h'].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.recent.map((s) => (
                  <tr key={s.id} className="border-b border-white/[0.045] last:border-0 hover:bg-white/[0.035]">
                    <td className="px-4 py-2">
                      {s.address ? (
                        <Link href={`/token/${s.chainId}/${encodeURIComponent(s.address)}`} className="font-medium hover:underline">{s.symbol ?? '?'}</Link>
                      ) : (
                        <span>{s.symbol ?? '?'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">{ago(s.firedAt)}</td>
                    <td className="px-4 py-2 text-xs">{s.rule}</td>
                    <td className="px-4 py-2 text-xs text-muted">{s.chainId}</td>
                    <td className="num px-4 py-2">{s.momentumScore?.toFixed(0) ?? '—'}</td>
                    <td className="num px-4 py-2">{s.riskScore ?? '—'}</td>
                    {['15m', '1h', '4h', '24h'].map((h) => {
                      const o = s.outcomes?.[h];
                      return (
                        <td key={h} className={`num px-4 py-2 text-xs ${o?.status === 'ok' || o?.status === 'collapsed' ? cls(o.netReturnPct) : 'text-faint'}`}>
                          {!o || o.status === 'pending' ? '…' : o.status === 'no_data' ? 'no data' : o.status === 'collapsed' ? 'rug' : pct(o.netReturnPct)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Breakdown({ title, rows, min }: { title: string; rows: Array<{ bucket: string; stats: StatsT }>; min: number }) {
  return (
    <div className="px-5 py-3">
      <div className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-faint">No completed outcomes yet.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((b) => (
              <tr key={b.bucket}>
                <td className="py-0.5 text-muted">{b.bucket}</td>
                <td className="num py-0.5 text-right text-faint">
                  n={b.stats.n}
                  {b.stats.n < min ? '*' : ''}
                </td>
                <td className={`num py-0.5 text-right ${cls(b.stats.expectancyPct)}`}>{pct(b.stats.expectancyPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
