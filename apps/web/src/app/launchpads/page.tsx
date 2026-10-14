import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { LaunchpadBadge } from '@/components/chart-embed';
import { MomentumCell, RiskCell } from '@/components/scores';
import { ApiDown, ChangeCell, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, int, shortAddr, usd } from '@/lib/format';
import type { LaunchpadTag } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface LaunchpadsOverview {
  windowHours: number;
  launchpads: Array<{ id: string; name: string; chains: string[]; hasGraduation: boolean; tracked: number; seen24h: number; graduated24h: number }>;
  recentGraduates: Array<{
    chainId: string;
    address: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    launchpad: LaunchpadTag | null;
    liquidityUsd: number | null;
    marketCapUsd: number | null;
    priceChangeH1: number | null;
    priceChangeH24: number | null;
    volumeH1: number | null;
    momentumScore: number | null;
    riskScore: number | null;
    riskLevel: string | null;
    riskCoverage: number | null;
  }>;
}

export default async function LaunchpadsPage() {
  const res = await api<LaunchpadsOverview>('/launchpads');
  if (!res.ok) return <ApiDown message={res.message} />;
  const r = res.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Launchpads"
        sub={
          <>
            Where tokens were launched — pump.fun, four.meme, Meteora DBC, Pons and more — read from the pool each token trades on, or from the address pattern a
            launchpad stamps on its tokens (marked <span className="text-ink">*</span>). <span className="text-ink">Graduated</span> means the token left the
            launchpad&apos;s bonding curve for an open pool. Counts are what our scans saw, a sample — not the launchpads&apos; own totals. Whether graduates do well is
            measured, not assumed: see the <Link href="/performance" className="text-accent hover:underline">Launchpad graduates</Link> rule.
          </>
        }
        right={<AutoRefresh seconds={60} />}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {r.launchpads.map((l) => (
          <Link key={l.id} href={`/discover?launchpad=${l.id}&maxAgeHours=24`} className="glass rounded-xl px-4 py-3 transition-colors hover:bg-white/[0.05]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{l.name}</span>
              <span className="text-[11px] text-faint">{l.chains.join(', ')}</span>
            </div>
            <div className="num mt-2 flex gap-4 text-sm">
              <span title={`New tokens seen in the last ${r.windowHours}h`}>
                {int(l.seen24h)} <span className="text-xs text-faint">new</span>
              </span>
              {l.hasGraduation ? (
                <span className="text-accent" title={`Graduated in the last ${r.windowHours}h`}>
                  {int(l.graduated24h)} <span className="text-xs text-faint">graduated</span>
                </span>
              ) : (
                <span className="text-xs text-faint" title="This launchpad has no bonding-curve step we can observe">no curve</span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-faint">{int(l.tracked)} tracked in total</div>
          </Link>
        ))}
      </div>

      <Panel title="Recently graduated" right={<Link href="/discover?stage=graduated&sort=graduatedAt&maxAgeHours=any" className="text-xs text-muted hover:text-ink">All graduates →</Link>}>
        {r.recentGraduates.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No graduations seen yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  {['Token', 'Launchpad', 'Graduated', 'Liquidity', 'Market cap', 'Vol 1h', 'Δ 1h', 'Δ 24h', 'Momentum', 'Risk'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.recentGraduates.map((t) => (
                  <tr key={`${t.chainId}:${t.address}`} className="border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]">
                    <td className="px-3 py-2">
                      <Link href={`/token/${t.chainId}/${encodeURIComponent(t.address)}`} className="flex items-center gap-2">
                        {t.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={t.imageUrl} alt="" className="h-6 w-6 shrink-0 rounded-full bg-white/5 ring-1 ring-white/10" loading="lazy" />
                        ) : (
                          <span className="h-6 w-6 shrink-0 rounded-full bg-white/5 ring-1 ring-white/10" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{t.symbol ?? shortAddr(t.address)}</span>
                          <span className="block truncate text-xs text-muted">{t.name ?? '—'}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2"><LaunchpadBadge lp={t.launchpad} compact /></td>
                    <td className="px-3 py-2 text-xs text-muted">{ago(t.launchpad?.graduatedAt ?? null)}</td>
                    <td className="num px-3 py-2">{usd(t.liquidityUsd)}</td>
                    <td className="num px-3 py-2">{usd(t.marketCapUsd)}</td>
                    <td className="num px-3 py-2">{usd(t.volumeH1)}</td>
                    <td className="num px-3 py-2"><ChangeCell v={t.priceChangeH1} /></td>
                    <td className="num px-3 py-2"><ChangeCell v={t.priceChangeH24} /></td>
                    <td className="px-3 py-2"><MomentumCell score={t.momentumScore} /></td>
                    <td className="px-3 py-2"><RiskCell score={t.riskScore} level={t.riskLevel} coverage={t.riskCoverage} /></td>
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
