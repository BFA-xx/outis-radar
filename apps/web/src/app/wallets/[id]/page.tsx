import Link from 'next/link';
import { notFound } from 'next/navigation';
import { addWatchlistItem, removeWallet, syncWallet } from '@/app/actions';
import { RiskCell } from '@/components/scores';
import { ApiDown, Flash, Panel, Stat, StatusPill } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { age, ago, price, shortAddr, usd } from '@/lib/format';
import type { ChainRow, WalletPosition, WalletReport, WatchlistRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Amount in the position's unit: "0.0516 SOL" / "$12.40". Unknown → em dash. */
function inUnit(v: number | null, unit: 'native' | 'usd' | null, nativeSymbol: string, signed = false): string {
  if (v === null || unit === null) return '—';
  const sign = signed && v > 0 ? '+' : '';
  if (unit === 'usd') return `${sign}${usd(v)}`;
  const abs = Math.abs(v);
  const n = abs >= 100 ? v.toFixed(1) : abs >= 1 ? v.toFixed(3) : abs >= 0.001 ? v.toFixed(4) : v.toPrecision(3);
  return `${sign}${n} ${nativeSymbol}`;
}

function qty(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

const pnlCls = (v: number | null) => (v === null ? 'text-faint' : v > 0 ? 'text-accent' : v < 0 ? 'text-bad' : 'text-muted');

export default async function WalletPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const [res, chains, lists] = await Promise.all([api<WalletReport>(`/wallets/${encodeURIComponent(id)}`), api<ChainRow[]>('/chains'), api<WatchlistRow[]>('/watchlists')]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <ApiDown message={res.message} />;
  const r = res.data;
  const w = r.wallet;
  const s = r.summary;
  const ns = s.nativeSymbol;
  const explorer = chains.ok ? chains.data.find((c) => c.id === w.chainId)?.explorer : undefined;
  const canWrite = writesEnabled();
  const open = r.positions.filter((p) => p.netQty > 0);
  const closed = r.positions.filter((p) => p.netQty === 0);

  return (
    <div className="space-y-5">
      <Link href="/wallets" className="text-xs text-muted hover:text-ink">← Wallets</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight">{w.label ?? shortAddr(w.address)}</h1>
          <p className="num mt-1 break-all text-xs text-muted">
            {r.chain?.name} · {w.address}
          </p>
          <p className="mt-1 text-xs text-faint">
            Tracked since {new Date(w.trackedFrom).toISOString().slice(0, 16).replace('T', ' ')} UTC · last sync {w.lastSyncAt ? ago(w.lastSyncAt) : 'never'}{' '}
            {w.lastSyncStatus && <StatusPill status={w.lastSyncStatus === 'error' ? 'failed' : w.lastSyncStatus} />}
          </p>
          {w.lastSyncError && <p className="mt-1 max-w-3xl text-xs text-warn">{w.lastSyncError}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {explorer && (
            <a className="btn-ghost px-3 py-1.5 text-sm" target="_blank" rel="noopener noreferrer" href={`${explorer.baseUrl}${w.chainId === 'solana' ? '/account/' : w.chainId === 'tron' ? '/#/address/' : '/address/'}${w.address}`}>
              Explorer ↗
            </a>
          )}
          {canWrite && (
            <>
              <form action={syncWallet}>
                <input type="hidden" name="id" value={w.id} />
                <button className="btn-ghost px-3 py-1.5 text-sm">Sync now</button>
              </form>
              <form action={removeWallet}>
                <input type="hidden" name="id" value={w.id} />
                <button className="btn-ghost px-3 py-1.5 text-sm hover:!text-bad">Stop tracking</button>
              </form>
            </>
          )}
        </div>
      </div>
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Realized (known)" value={<span className={pnlCls(s.realizedNative)}>{inUnit(s.realizedNative, 'native', ns, true)}</span>} accent hint="Sum over positions whose realized PnL is fully known, in the native coin." />
        <Stat label="Unrealized (known)" value={<span className={pnlCls(s.unrealizedKnownNative)}>{inUnit(s.unrealizedKnownNative, 'native', ns, true)}</span>} hint="Open positions with known cost and a current price." />
        <Stat label="Win rate" value={s.winRate === null ? '—' : `${Math.round(s.winRate * 100)}%`} hint={`Over ${s.closedWithKnownPnl} closed position(s) with known PnL.`} />
        <Stat label="Early entries" value={s.earlyEntries} hint="First buy within 30 minutes of the pair's creation (tokens we track)." />
      </div>
      <p className="-mt-2 text-xs text-faint">
        {s.completePositions} of {s.positions} positions are fully reconstructable. Totals include only those; the rest show why below.
        {s.nativeUsd ? ` ${ns} ≈ ${usd(s.nativeUsd)} today (from our own pair data) — USD figures use today's price, not the price at the time.` : ''}
        {s.realizedUsdStable !== 0 ? ` Stablecoin-quoted realized: ${usd(s.realizedUsdStable)}.` : ''}
      </p>

      {r.flows.length > 0 && (
        <Panel title="Money in / out">
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-4">
            {r.flows.map((f) => (
              <div key={f.tokenAddress} className="px-5 py-4">
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{f.symbol}</div>
                <div className="num mt-1.5 text-sm">
                  <span className="text-accent">+{qty(f.received)}</span> <span className="text-faint">/</span> <span className="text-warn">−{qty(f.sent)}</span>
                </div>
                <div className="mt-0.5 text-xs text-faint">{f.transfers} transfer(s) · net {f.received - f.sent >= 0 ? '+' : '−'}{qty(Math.abs(f.received - f.sent))}</div>
              </div>
            ))}
          </div>
          {open.length + closed.length === 0 && (
            <p className="border-t border-line px-5 py-3 text-xs text-faint">This wallet has only moved money (native coin / stablecoins) in the loaded window — no token positions to show.</p>
          )}
        </Panel>
      )}

      <PositionsTable title={`Open positions (${open.length})`} positions={open} ns={ns} chainId={w.chainId} />
      <PositionsTable title={`Closed (${closed.length})`} positions={closed} ns={ns} chainId={w.chainId} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={`Connections (${r.connections.length})`}>
          {r.connections.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">None found among tracked wallets and checked tokens. Connections are only shown with evidence: a deployer record, a shared early entry, or a direct transfer.</p>
          ) : (
            <ul className="divide-y divide-white/[0.045]">
              {r.connections.map((c, i) => (
                <li key={i} className="px-5 py-3 text-sm">
                  <span className="mr-2 rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{c.kind.replace('_', ' ')}</span>
                  {c.text}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-faint">evidence</summary>
                    <pre className="num mt-1 overflow-auto rounded-lg bg-black/40 p-2.5 text-[11px] text-muted ring-1 ring-white/5">{JSON.stringify(c.evidence, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Recent transfers (${r.transfers.length})`} className="lg:col-span-2">
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#0d0d0f] text-left text-muted">
                <tr className="border-b border-line">
                  {['When', 'Token', 'Direction', 'Amount', 'Tx'].map((h) => (
                    <th key={h} className="px-4 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.transfers.map((t) => (
                  <tr key={t.id} className="border-b border-white/[0.045]">
                    <td className="px-4 py-2 text-xs text-muted" title={t.blockTime}>{ago(t.blockTime)}</td>
                    <td className="num px-4 py-2 text-xs">{t.tokenAddress === 'native' ? ns : (t.symbol ?? shortAddr(t.tokenAddress))}</td>
                    <td className={`px-4 py-2 text-xs ${t.direction === 'in' ? 'text-accent' : 'text-warn'}`}>{t.direction}</td>
                    <td className="num px-4 py-2 text-right">{qty(t.amount)}</td>
                    <td className="num px-4 py-2 text-xs text-faint">
                      {explorer ? (
                        <a href={`${explorer.baseUrl}${w.chainId === 'tron' ? '/#/transaction/' : '/tx/'}${t.txHash}`} target="_blank" rel="noopener noreferrer" className="hover:text-ink">
                          {shortAddr(t.txHash)}
                        </a>
                      ) : (
                        shortAddr(t.txHash)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {canWrite && lists.ok && lists.data.length > 0 && (
        <form action={addWatchlistItem} className="glass flex flex-wrap items-center gap-3 rounded-2xl px-5 py-3 text-sm">
          <span className="text-muted">Add this wallet to</span>
          <select name="watchlistId" className="field h-9 px-3">
            {lists.data.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <input type="hidden" name="kind" value="wallet" />
          <input type="hidden" name="chainId" value={w.chainId} />
          <input type="hidden" name="address" value={w.address} />
          <input type="hidden" name="returnTo" value={`/wallets/${w.id}`} />
          <button className="btn-ghost px-3 py-1.5">Add</button>
        </form>
      )}
    </div>
  );
}

function PositionsTable({ title, positions, ns, chainId }: { title: string; positions: WalletPosition[]; ns: string; chainId: string }) {
  if (positions.length === 0) return null;
  return (
    <Panel title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Token</th>
              <th className="px-3 py-2.5 text-right font-medium">Held</th>
              <th className="px-3 py-2.5 text-right font-medium">Avg entry</th>
              <th className="px-3 py-2.5 text-right font-medium">Now</th>
              <th className="px-3 py-2.5 text-right font-medium">Value</th>
              <th className="px-3 py-2.5 text-right font-medium">Unrealized</th>
              <th className="px-3 py-2.5 text-right font-medium">Realized</th>
              <th className="px-3 py-2.5 text-right font-medium">Entry</th>
              <th className="px-3 py-2.5 text-right font-medium">Risk</th>
              <th className="px-4 py-2.5 font-medium">Data</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.tokenAddress} className="border-b border-white/[0.045] align-top transition-colors last:border-0 hover:bg-white/[0.035]">
                <td className="px-4 py-3">
                  {p.token.tracked ? (
                    <Link href={`/token/${chainId}/${encodeURIComponent(p.tokenAddress)}`} className="font-medium text-ink hover:underline">
                      {p.token.symbol ?? shortAddr(p.tokenAddress)}
                    </Link>
                  ) : (
                    <span className="font-medium">{p.token.symbol ?? shortAddr(p.tokenAddress)}</span>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-faint">{p.events.length} trade(s)</summary>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
                      {p.events.map((e, i) => (
                        <li key={i} className="num" title={e.note}>
                          {new Date(e.at).toISOString().slice(5, 16).replace('T', ' ')} {e.side.replace('_', ' ')} {qty(e.qty)}
                          {e.quote !== null ? ` for ${inUnit(e.quote, e.unit, ns)}` : ' · price unknown'}
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
                <td className="num px-3 py-3 text-right">{p.netQty === 0 ? <span className="text-faint">closed</span> : qty(p.netQty)}</td>
                <td className="num px-3 py-3 text-right">{p.avgEntry === null ? '—' : p.unit === 'usd' ? `$${price(p.avgEntry)}` : `${price(p.avgEntry)} ${ns}`}</td>
                <td className="num px-3 py-3 text-right" title={p.priceSource ?? 'No current price: token not in our discovery data'}>
                  {p.priceInUnit === null ? '—' : p.unit === 'usd' ? `$${price(p.priceInUnit)}` : `${price(p.priceInUnit)} ${ns}`}
                </td>
                <td className="num px-3 py-3 text-right" title={p.usd.value !== null ? `≈ ${usd(p.usd.value)} at today's ${ns} price` : ''}>{p.netQty === 0 ? '—' : inUnit(p.value, p.unit, ns)}</td>
                <td className={`num px-3 py-3 text-right ${pnlCls(p.unrealized)}`} title={p.usd.unrealized !== null ? `≈ ${usd(p.usd.unrealized)}` : ''}>{p.netQty === 0 ? '—' : inUnit(p.unrealized, p.unit, ns, true)}</td>
                <td className={`num px-3 py-3 text-right ${pnlCls(p.realized)}`} title={p.usd.realized !== null ? `≈ ${usd(p.usd.realized)} at today's price` : ''}>{p.soldQty === 0 ? '—' : inUnit(p.realized, p.unit, ns, true)}</td>
                <td className="num px-3 py-3 text-right text-xs text-muted" title="Minutes between pair creation and this wallet's first buy">
                  {p.entryMinutesAfterLaunch === null ? '—' : p.entryMinutesAfterLaunch < 0 ? 'before pair' : `T+${age(p.entryMinutesAfterLaunch)}`}
                </td>
                <td className="px-3 py-3 text-right">{p.token.tracked ? <RiskCell score={p.token.riskScore} level={p.token.riskLevel} coverage={null} /> : <span className="text-xs text-faint">—</span>}</td>
                <td className="max-w-[260px] px-4 py-3 text-xs">
                  {p.complete ? <span className="text-accent">complete</span> : <span className="text-warn" title={p.issues.join('\n')}>incomplete · {p.issues[0]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
