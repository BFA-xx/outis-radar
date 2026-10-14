import { ApiDown, Panel, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, int } from '@/lib/format';
import type { ChainRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CAPS = [
  ['discovery', 'Discovery'],
  ['marketData', 'Market data'],
  ['metadata', 'Metadata'],
  ['holders', 'Holders'],
  ['walletActivity', 'Wallets'],
  ['riskChecks', 'Risk checks'],
] as const;

export default async function ChainsPage() {
  const res = await api<ChainRow[]>('/chains');
  if (!res.ok) return <ApiDown message={res.message} />;
  const groups = [1, 2, 3].map((p) => res.data.filter((c) => c.priority === p));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Multi-chain explorer</h1>
        <p className="text-sm text-muted">
          What each network adapter actually does today. Status is computed from live provider health, not declared:
          a chain is <span className="text-accent">live</span> only if it is being scanned and a provider answered for it in the last 2 hours.
          Enable more chains with <code className="num text-ink">SCAN_CHAINS</code>.
        </p>
      </div>
      {groups.map((chains, i) => (
        <Panel key={i} title={`Priority ${i + 1}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Chain</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Last data</th>
                  {CAPS.map(([, l]) => (
                    <th key={l} className="px-3 py-2 font-medium">{l}</th>
                  ))}
                  <th className="px-3 py-2 font-medium">RPC</th>
                </tr>
              </thead>
              <tbody>
                {chains.map((c) => (
                  <tr key={c.id} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035] align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{c.displayName}</div>
                      <div className="num text-xs text-faint">
                        {c.family}
                        {c.evmChainId ? ` · ${c.evmChainId}` : ''} · {c.nativeAsset.symbol} · {c.tokenStandards.join(', ')}
                      </div>
                      {c.notes.map((n) => (
                        <div key={n} className="mt-1 max-w-xs text-xs text-muted">{n}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill status={c.status} />
                      <div className="mt-1 max-w-[220px] text-xs text-muted">{c.statusReason}</div>
                    </td>
                    <td className="num px-3 py-2 text-right">{int(c.trackedTokens)}</td>
                    <td className="px-3 py-2 text-xs text-muted">{c.lastMarketUpdate ? ago(c.lastMarketUpdate) : '—'}</td>
                    {CAPS.map(([k]) => (
                      <td key={k} className="px-3 py-2" title={[c.capabilities[k].via.join(' + '), c.capabilities[k].note].filter(Boolean).join('\n')}>
                        <StatusPill status={c.capabilities[k].state} />
                      </td>
                    ))}
                    <td className="num px-3 py-2 text-xs" title={`Set ${c.rpcEnvVar} to enable on-chain checks`}>
                      {c.rpcConfigured ? <span className="text-accent">set</span> : <span className="text-faint">{c.rpcEnvVar}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}
    </div>
  );
}
