import Link from 'next/link';
import { closePaperTrade } from '@/app/actions';
import { AutoRefresh } from '@/components/auto-refresh';
import { Sparkline } from '@/components/sparkline';
import { ApiDown, Flash, PageHeader, Panel, Stat } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { ago, price, usd } from '@/lib/format';
import type { PaperReport, PaperTradeRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const pctFmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const cls = (v: number | null | undefined) => (v === null || v === undefined ? 'text-faint' : v > 0 ? 'text-accent' : v < 0 ? 'text-bad' : 'text-muted');
const REASON: Record<string, string> = { take_profit: 'take profit', stop_loss: 'stop loss', max_hold: 'time limit', manual: 'manual', collapsed: 'liquidity collapsed' };

export default async function PaperPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const res = await api<PaperReport>('/paper');
  if (!res.ok) return <ApiDown message={res.message} />;
  const r = res.data;
  const open = r.trades.filter((t) => t.status === 'open');
  const closed = r.trades.filter((t) => t.status === 'closed');
  const pnl = r.state.equityUsd - r.config.startingBalanceUsd;
  const canWrite = writesEnabled();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Paper trading"
        sub={
          <>
            Hypothetical positions only — nothing is ever bought or sold. Entries use the latest observed price (never older than 30 min); exits fill at the
            price actually observed when a rule triggers. Costs: {r.config.feeBps / 100}% fee + {r.config.slippageBps / 100}% slippage per side, plus modelled price impact.
            Open a position from any token page.
          </>
        }
        right={<AutoRefresh seconds={60} />}
      />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Equity" value={usd(r.state.equityUsd)} accent hint={`Started with ${usd(r.config.startingBalanceUsd)} of paper money`} />
        <Stat label="P&L" value={<span className={cls(pnl)}>{pnl >= 0 ? '+' : '−'}{usd(Math.abs(pnl))}</span>} />
        <Stat label="Cash" value={usd(r.state.cashUsd)} />
        <Stat label="Win rate" value={r.closedStats.winRate === null ? '—' : `${Math.round(r.closedStats.winRate * 100)}%`} hint={`${r.closedStats.n} closed trade(s)`} />
        <Stat label="Expectancy" value={<span className={cls(r.closedStats.expectancyPct)}>{pctFmt(r.closedStats.expectancyPct)}</span>} hint="Average net return per closed trade" />
        <Stat label="Max drawdown" value={`${r.maxDrawdownPct.toFixed(1)}%`} hint="Largest peak-to-trough fall of equity" />
      </div>
      {r.closedStats.n > 0 && r.closedStats.n < 30 && (
        <p className="-mt-2 text-xs text-warn">Only {r.closedStats.n} closed trade(s): win rate and expectancy are noise below ~30.</p>
      )}

      {r.curve.length > 1 && (
        <Panel title="Equity">
          <div className="p-5">
            <Sparkline points={r.curve.map((c) => ({ t: Date.parse(c.at), v: c.equityUsd }))} label="Equity" />
          </div>
        </Panel>
      )}

      <TradesTable title={`Open (${open.length})`} trades={open} canWrite={canWrite} />
      <TradesTable title={`Closed (${closed.length})`} trades={closed} canWrite={false} />

      {open.length + closed.length === 0 && (
        <Panel title="How to start">
          <p className="px-5 py-4 text-sm text-muted">
            Open any token from <Link href="/discover" className="text-accent hover:underline">Discovery</Link> and use <span className="text-ink">Paper buy</span>. Add a take-profit,
            stop-loss or time limit and the evaluator closes it for you from the prices the scanner observes.
          </p>
        </Panel>
      )}
    </div>
  );
}

function TradesTable({ title, trades, canWrite }: { title: string; trades: PaperTradeRow[]; canWrite: boolean }) {
  if (trades.length === 0) return null;
  const isOpen = trades[0].status === 'open';
  return (
    <Panel title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-line">
              {['Token', 'Size', 'Entry', isOpen ? 'Now' : 'Exit', 'Return (net)', isOpen ? 'Value' : 'P&L', 'MFE / MAE', 'Rules', isOpen ? 'Opened' : 'Closed', ''].map((h, i) => (
                <th key={i} className="px-4 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const ret = isOpen ? (t.mark?.returnPct ?? null) : t.returnPct;
              return (
                <tr key={t.id} className="border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]">
                  <td className="px-4 py-2.5">
                    {t.address ? (
                      <Link href={`/token/${t.chainId}/${encodeURIComponent(t.address)}`} className="font-medium hover:underline">{t.symbol ?? '?'}</Link>
                    ) : (
                      <span className="font-medium">{t.symbol ?? '?'}</span>
                    )}
                    <span className="ml-2 text-xs text-faint">{t.chainId}</span>
                    {t.note && <span className="block text-xs text-faint">{t.note}</span>}
                  </td>
                  <td className="num px-4 py-2.5">{usd(t.sizeUsd)}</td>
                  <td className="num px-4 py-2.5" title={`Price observed ${t.entryObservedAt} · impact ${t.entryImpactPct.toFixed(2)}%`}>${price(t.entryPrice)}</td>
                  <td className="num px-4 py-2.5">
                    {isOpen ? (t.mark?.priceUsd != null ? `$${price(t.mark.priceUsd)}` : '—') : t.exitPrice != null ? `$${price(t.exitPrice)}` : '—'}
                    {isOpen && t.mark?.stale && <span className="ml-1 text-xs text-warn" title="Price older than 1h">stale</span>}
                  </td>
                  <td className={`num px-4 py-2.5 ${cls(ret)}`}>{pctFmt(ret)}</td>
                  <td className={`num px-4 py-2.5 ${isOpen ? '' : cls(t.pnlUsd)}`}>{isOpen ? usd(t.mark?.valueUsd ?? null) : t.pnlUsd === null ? '—' : `${t.pnlUsd >= 0 ? '+' : '−'}${usd(Math.abs(t.pnlUsd))}`}</td>
                  <td className="num px-4 py-2.5 text-xs text-muted" title="Best and worst gross move seen while open">
                    {pctFmt(t.mfePct)} / {pctFmt(t.maePct)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {[t.takeProfitPct ? `TP +${t.takeProfitPct}%` : null, t.stopLossPct ? `SL −${t.stopLossPct}%` : null, t.maxHoldMinutes ? `≤ ${t.maxHoldMinutes}m` : null].filter(Boolean).join(' · ') || 'manual'}
                    {!isOpen && t.exitReason && <span className="block text-faint">exit: {REASON[t.exitReason] ?? t.exitReason}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint">{ago(isOpen ? t.openedAt : (t.closedAt ?? t.openedAt))}</td>
                  <td className="px-4 py-2.5 text-right">
                    {isOpen && canWrite && (
                      <form action={closePaperTrade}>
                        <input type="hidden" name="id" value={t.id} />
                        <button className="btn-ghost px-2.5 py-1 text-xs">Close</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
