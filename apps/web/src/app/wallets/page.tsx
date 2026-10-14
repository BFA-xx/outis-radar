import Link from 'next/link';
import { addWallet } from '@/app/actions';
import { ApiDown, Flash, PageHeader, Panel, StatusPill, WritesDisabled } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { ago, int, shortAddr } from '@/lib/format';
import type { WalletRow, WalletSupportRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  rpc: 'your RPC',
  public_rpc: 'public RPC',
  blockscout: 'Blockscout',
  solana_rpc: 'Solana RPC',
};

export default async function WalletsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const [wallets, support] = await Promise.all([api<WalletRow[]>('/wallets'), api<WalletSupportRow[]>('/wallets/support')]);
  if (!wallets.ok) return <ApiDown message={wallets.message} />;
  const supported = support.ok ? support.data.filter((s) => s.state === 'live') : [];
  const needsConfig = support.ok ? support.data.filter((s) => s.state === 'needs_config') : [];
  const canWrite = writesEnabled();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Wallets"
        sub="Track wallets and reconstruct what they bought and sold. Profit and loss is only shown where both sides of a trade are visible in the same transaction; everything else is marked unknown, with the reason."
      />
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Track a wallet" className="lg:col-span-2">
          <div className="p-5">
            {canWrite ? (
              <form action={addWallet} className="grid gap-3 sm:grid-cols-[180px_1fr_180px_auto]">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Chain</span>
                  <select name="chainId" required className="field h-10 px-3 text-sm" defaultValue="solana">
                    {supported.map((s) => (
                      <option key={s.chainId} value={s.chainId}>
                        {s.name}
                      </option>
                    ))}
                    {needsConfig.length > 0 && (
                      <optgroup label="Needs your RPC URL">
                        {needsConfig.map((s) => (
                          <option key={s.chainId} value={s.chainId}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Address</span>
                  <input name="address" required placeholder="0x… or base58" className="num field h-10 px-3 text-sm" autoComplete="off" spellCheck={false} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Your label (optional)</span>
                  <input name="label" maxLength={60} placeholder="e.g. early buyer #3" className="field h-10 px-3 text-sm" />
                </label>
                <div className="flex items-end">
                  <button className="btn-primary h-10 w-full px-5 text-sm">Track</button>
                </div>
              </form>
            ) : (
              <WritesDisabled />
            )}
            <p className="mt-3 text-xs text-faint">
              History starts {`~72h`} before you add a wallet and is complete from then on. Labels are yours — the app never names a wallet on its own.
            </p>
          </div>
        </Panel>

        <Panel title="Coverage">
          <ul className="divide-y divide-white/[0.045] text-sm">
            {(support.ok ? support.data : [])
              .filter((s) => s.state !== 'unavailable')
              .map((s) => (
                <li key={s.chainId} className="flex items-center justify-between gap-3 px-5 py-2" title={s.note}>
                  <span>{s.name}</span>
                  {s.state === 'live' ? <span className="text-xs text-muted">{SOURCE_LABEL[s.source ?? ''] ?? s.source}</span> : <StatusPill status="needs_config" />}
                </li>
              ))}
          </ul>
          {needsConfig.length > 0 && (
            <p className="border-t border-line px-5 py-3 text-xs text-faint">
              “needs config”: no free source accepts wallet-wide queries there. Add that chain’s <code className="num">RPC_URL_…</code> (a free Alchemy key works) to <code className="num">.env</code>.
            </p>
          )}
        </Panel>
      </div>

      <Panel title={`Tracked (${wallets.data.length})`}>
        {wallets.data.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">No wallets yet. Add one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-muted">
                <tr className="border-b border-line">
                  {['Wallet', 'Chain', 'Transfers', 'Last activity', 'Last sync', 'Source'].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wallets.data.map((w) => (
                  <tr key={w.id} className="border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]">
                    <td className="px-4 py-3">
                      <Link href={`/wallets/${w.id}`} className="block">
                        <span className="font-medium text-ink">{w.label ?? shortAddr(w.address)}</span>
                        <span className="num block text-xs text-faint">{shortAddr(w.address)}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{w.chainName}</td>
                    <td className="num px-4 py-3">{int(w.transfers)}</td>
                    <td className="px-4 py-3 text-xs text-muted">{w.lastActivityAt ? ago(w.lastActivityAt) : '—'}</td>
                    <td className="px-4 py-3" title={w.lastSyncError ?? ''}>
                      {w.lastSyncStatus ? <StatusPill status={w.lastSyncStatus === 'error' ? 'failed' : w.lastSyncStatus} /> : <span className="text-xs text-faint">queued</span>}
                      <span className="ml-2 text-xs text-faint">{w.lastSyncAt ? ago(w.lastSyncAt) : ''}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{w.source ? (SOURCE_LABEL[w.source] ?? w.source) : '—'}</td>
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
