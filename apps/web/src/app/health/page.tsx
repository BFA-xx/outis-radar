import { AutoRefresh } from '@/components/auto-refresh';
import { ApiDown, Panel, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, int } from '@/lib/format';
import type { ProviderHealthRow, ScanRun } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const [health, providers, scans] = await Promise.all([
    api<{ ok: boolean; dbLatencyMs: number }>('/health'),
    api<ProviderHealthRow[]>('/providers/health'),
    api<ScanRun[]>('/scans?limit=25'),
  ]);
  if (!providers.ok) return <ApiDown message={providers.message} />;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Data-provider and scan health</h1>
          <p className="text-sm text-muted">
            API {health.ok ? <span className="text-accent">up</span> : <span className="text-bad">down</span>}
            {health.ok ? ` · database ${health.data.dbLatencyMs}ms` : ''}. Counters are cumulative since the database was created.
          </p>
        </div>
        <AutoRefresh seconds={30} />
      </div>

      <Panel title="Providers">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                {['Provider', 'Scope', 'Last success', 'Last error', 'Failing streak', 'Latency', 'Requests', 'Errors', '429s'].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {providers.data.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-muted">No provider has been called yet. Run a scan.</td></tr>
              )}
              {providers.data.map((p) => (
                <tr key={`${p.provider}|${p.scope}`} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035]">
                  <td className="px-3 py-2">{p.provider}</td>
                  <td className="num px-3 py-2 text-muted">{p.scope === '*' ? 'global' : p.scope}</td>
                  <td className="px-3 py-2 text-xs">{ago(p.lastSuccessAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted" title={p.lastError ?? ''}>
                    {p.lastErrorAt ? `${ago(p.lastErrorAt)} · ${p.lastError?.slice(0, 40) ?? ''}` : '—'}
                  </td>
                  <td className="num px-3 py-2">
                    {p.consecutiveFailures > 0 ? <span className="text-bad">{p.consecutiveFailures}</span> : <span className="text-accent">0</span>}
                  </td>
                  <td className="num px-3 py-2 text-muted">{p.lastLatencyMs ?? '—'}ms</td>
                  <td className="num px-3 py-2">{int(p.requestsTotal)}</td>
                  <td className="num px-3 py-2">{int(p.errorsTotal)}</td>
                  <td className="num px-3 py-2">{int(p.rateLimitedTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent scans">
        {!scans.ok ? (
          <p className="p-4 text-sm text-bad">{scans.message}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  {['Started', 'Job', 'Status', 'Trigger', 'Duration', 'Created', 'Updated', 'Checked', 'Provider errors', 'Note'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scans.data.map((s) => {
                  const cs = Object.values(s.stats?.chains ?? {});
                  // Risk-job rows carry no per-chain stats; their columns read "—" or their own counters.
                  const sum = (f: (c: (typeof cs)[number]) => number) => cs.reduce((n, c) => n + f(c), 0);
                  return (
                    <tr key={s.id} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035]">
                      <td className="px-3 py-2 text-xs" title={s.startedAt}>{ago(s.startedAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted">{s.job === 'risk-scan' ? 'risk' : s.job === 'wallet-sync' ? 'wallets' : 'discovery'}</td>
                      <td className="px-3 py-2"><StatusPill status={s.status} /></td>
                      <td className="px-3 py-2 text-xs text-muted">{s.trigger}</td>
                      <td className="num px-3 py-2 text-muted">{s.stats?.durationMs ? `${Math.round(s.stats.durationMs / 1000)}s` : '—'}</td>
                      <td className="num px-3 py-2">{int(sum((c) => c.persist.pairsCreated))}</td>
                      <td className="num px-3 py-2">{int(sum((c) => c.persist.pairsUpdated))}</td>
                      <td className="num px-3 py-2 text-muted" title="Risk job: tokens answered by GoPlus / not indexed yet">
                        {s.job === 'risk-scan' ? `${int(s.stats?.checked ?? 0)} / ${int(s.stats?.notIndexed ?? 0)}` : '—'}
                      </td>
                      <td className="num px-3 py-2">{s.job === 'risk-scan' ? int(s.stats?.errors?.length ?? 0) : int(sum((c) => c.providerErrors.length))}</td>
                      <td className="max-w-xs truncate px-3 py-2 text-xs text-muted" title={s.error ?? s.stats?.stoppedEarly ?? ''}>
                        {s.error ?? s.stats?.stoppedEarly ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
