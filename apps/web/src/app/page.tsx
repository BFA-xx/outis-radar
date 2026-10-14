import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import { MomentumCell, RiskCell } from '@/components/scores';
import { ApiDown, Panel, Stat, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, age, int, usd } from '@/lib/format';
import type { ChainRow, FeedItem, Overview, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [overview, chains, newest, liquid] = await Promise.all([
    api<Overview>('/overview'),
    api<ChainRow[]>('/chains'),
    api<Paginated<FeedItem>>('/tokens?pageSize=8&sort=pairCreatedAt&maxAgeHours=24'),
    api<Paginated<FeedItem>>('/tokens?pageSize=8&sort=momentumScore&maxAgeHours=24&maxRiskScore=44&minLiquidityUsd=10000'),
  ]);
  if (!overview.ok) return <ApiDown message={overview.message} />;
  const o = overview.data;
  const totals = o.chains.reduce((a, c) => ({ tokens: a.tokens + c.tokens, h1: a.h1 + c.newLastHour, d1: a.d1 + c.newLast24h }), { tokens: 0, h1: 0, d1: 0 });
  const scanned = chains.ok ? chains.data.filter((c) => c.scanned) : [];
  const live = scanned.filter((c) => c.status === 'live').length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">
            Last scan{' '}
            {o.lastScan ? (
              <>
                <StatusPill status={o.lastScan.status} /> {ago(o.lastScan.finishedAt ?? o.lastScan.startedAt)}
              </>
            ) : (
              'never — run npm run scan'
            )}
          </p>
        </div>
        <AutoRefresh seconds={60} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Tracked tokens" value={int(totals.tokens)} accent />
        <Stat label="New pairs · 1h" value={int(totals.h1)} hint="Primary pairs created in the last hour, among tokens we stored" />
        <Stat label="New pairs · 24h" value={int(totals.d1)} />
        <Stat label="Chains live" value={`${live} / ${scanned.length}`} hint="Scanned chains with a provider answering in the last 2 hours" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <MiniTable title="Newest (24h)" res={newest} href="/discover?sort=pairCreatedAt&maxAgeHours=24" />
        <MiniTable title="Top momentum · < 24h · risk < 45 · ≥ $10K liquidity" res={liquid} href="/discover?sort=momentumScore&maxAgeHours=24&maxRiskScore=44&minLiquidityUsd=10000" showScores />
      </div>

      <Panel title="Chains" right={<Link href="/chains" className="text-xs text-muted hover:text-ink">All chains →</Link>}>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-5">
          {scanned.map((c) => {
            const stats = o.chains.find((x) => x.chainId === c.id);
            return (
              <Link key={c.id} href={`/discover?chain=${c.id}`} className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3 transition-colors hover:border-white/10 hover:bg-white/[0.05]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{c.displayName}</span>
                  <StatusPill status={c.status} title={c.statusReason} />
                </div>
                <div className="num mt-1 text-xs text-muted">
                  {int(stats?.tokens ?? 0)} tokens · {int(stats?.newLastHour ?? 0)} new/1h
                </div>
              </Link>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function MiniTable({ title, res, href, showScores = false }: { title: string; res: Awaited<ReturnType<typeof api<Paginated<FeedItem>>>>; href: string; showScores?: boolean }) {
  return (
    <Panel title={title} right={<Link href={href} className="text-xs text-muted hover:text-ink">Open →</Link>}>
      {!res.ok ? (
        <p className="p-4 text-sm text-bad">{res.message}</p>
      ) : res.data.items.length === 0 ? (
        <p className="p-4 text-sm text-muted">Nothing matches yet. Scores fill in as scans and risk checks run.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {res.data.items.map((t) => (
              <tr key={`${t.chain.id}:${t.pair.address}`} className="border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]">
                <td className="px-4 py-2">
                  <Link href={`/token/${t.chain.id}/${encodeURIComponent(t.token.address)}`} className="font-medium">
                    {t.token.symbol ?? '?'}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{t.chain.name}</span>
                </td>
                <td className="num px-2 py-2 text-right text-muted">{age(t.ageMinutes)}</td>
                <td className="num px-2 py-2 text-right" title="Liquidity">{usd(t.liquidityUsd)}</td>
                {showScores ? (
                  <>
                    <td className="px-2 py-2 text-right"><MomentumCell score={t.scores.momentum} /></td>
                    <td className="px-4 py-2 text-right"><RiskCell score={t.scores.risk} level={t.scores.riskLevel} coverage={t.scores.riskCoverage} /></td>
                  </>
                ) : (
                  <td className="num px-4 py-2 text-right text-muted" title="Volume 1h">{usd(t.volume.h1)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
