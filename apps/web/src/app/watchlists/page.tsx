import Link from 'next/link';
import { addWatchlistItem, createWatchlist, deleteWatchlist, removeWatchlistItem } from '@/app/actions';
import { AutoRefresh } from '@/components/auto-refresh';
import { MomentumCell, RiskCell } from '@/components/scores';
import { ApiDown, ChangeCell, Flash, PageHeader, Panel, WritesDisabled } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { ago, price, shortAddr, usd } from '@/lib/format';
import type { ChainRow, WatchlistRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function WatchlistsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const [lists, chains] = await Promise.all([api<WatchlistRow[]>('/watchlists'), api<ChainRow[]>('/chains')]);
  if (!lists.ok) return <ApiDown message={lists.message} />;
  const canWrite = writesEnabled();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Watchlists"
        sub="Tokens and wallets you want to keep an eye on, with live scores. Watched tokens and wallets also drive Telegram alerts (price moves, risk escalations, trades)."
        right={<AutoRefresh seconds={60} />}
      />
      <Flash msg={sp.msg} err={sp.err} />

      {canWrite ? (
        <form action={createWatchlist} className="glass flex flex-wrap items-end gap-3 rounded-2xl p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.1em] text-faint">New list</span>
            <input name="name" required maxLength={60} placeholder="e.g. Solana early" className="field h-10 w-64 px-3 text-sm" />
          </label>
          <button className="btn-primary h-10 px-5 text-sm">Create</button>
        </form>
      ) : (
        <WritesDisabled />
      )}

      {lists.data.length === 0 && <p className="text-sm text-muted">No lists yet. Create one, then add tokens from any token page or paste an address below.</p>}

      {lists.data.map((l) => (
        <Panel
          key={l.id}
          title={`${l.name} · ${l.items.length}`}
          right={
            canWrite ? (
              <form action={deleteWatchlist}>
                <input type="hidden" name="id" value={l.id} />
                <button className="text-xs text-faint hover:text-bad">Delete list</button>
              </form>
            ) : undefined
          }
        >
          {l.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="text-left text-muted">
                  <tr className="border-b border-line">
                    {['Item', 'Chain', 'Price', 'Δ 1h', 'Δ 24h', 'Liquidity', 'Momentum', 'Risk', 'Added', ''].map((h) => (
                      <th key={h} className="px-4 py-2.5 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {l.items.map((i) => (
                    <tr key={i.id} className="border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]">
                      <td className="px-4 py-2.5">
                        {i.kind === 'token' ? (
                          i.token ? (
                            <Link href={`/token/${i.chainId}/${encodeURIComponent(i.address)}`} className="font-medium hover:underline">{i.token.symbol ?? shortAddr(i.address)}</Link>
                          ) : (
                            <span className="num text-muted" title="Not in discovery data yet">{shortAddr(i.address)}</span>
                          )
                        ) : i.wallet ? (
                          <Link href={`/wallets/${i.wallet.id}`} className="font-medium hover:underline">◎ {i.wallet.label ?? shortAddr(i.address)}</Link>
                        ) : (
                          <span className="num text-muted" title="Wallet is not tracked — add it on the Wallets page">◎ {shortAddr(i.address)}</span>
                        )}
                        {i.note && <span className="block text-xs text-faint">{i.note}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{i.chainName}</td>
                      <td className="num px-4 py-2.5">{i.token?.priceUsd != null ? `$${price(i.token.priceUsd)}` : '—'}</td>
                      <td className="num px-4 py-2.5"><ChangeCell v={i.token?.priceChangeH1 ?? null} /></td>
                      <td className="num px-4 py-2.5"><ChangeCell v={i.token?.priceChangeH24 ?? null} /></td>
                      <td className="num px-4 py-2.5">{usd(i.token?.liquidityUsd ?? null)}</td>
                      <td className="px-4 py-2.5">{i.token ? <MomentumCell score={i.token.momentumScore} /> : '—'}</td>
                      <td className="px-4 py-2.5">{i.token ? <RiskCell score={i.token.riskScore} level={i.token.riskLevel} coverage={i.token.riskCoverage} /> : '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-faint">{ago(i.addedAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {canWrite && (
                          <form action={removeWatchlistItem}>
                            <input type="hidden" name="watchlistId" value={l.id} />
                            <input type="hidden" name="itemId" value={i.id} />
                            <button className="text-xs text-faint hover:text-bad" title="Remove">✕</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && (
            <form action={addWatchlistItem} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
              <input type="hidden" name="watchlistId" value={l.id} />
              <select name="kind" className="field h-9 px-3 text-sm" defaultValue="token">
                <option value="token">Token</option>
                <option value="wallet">Wallet</option>
              </select>
              <select name="chainId" className="field h-9 px-3 text-sm" defaultValue="solana">
                {(chains.ok ? chains.data : []).map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </select>
              <input name="address" required placeholder="Address" className="num field h-9 min-w-[260px] flex-1 px-3 text-sm" spellCheck={false} />
              <input name="note" maxLength={300} placeholder="Note (optional)" className="field h-9 w-48 px-3 text-sm" />
              <button className="btn-ghost h-9 px-4 text-sm">Add</button>
            </form>
          )}
        </Panel>
      ))}
    </div>
  );
}
