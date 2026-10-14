import { Panel } from '@/components/ui';
import { ApiDown } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import type { CheckSpec, ScoringConfigResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

const FAMILIES = ['evm', 'solana', 'tron', 'sui', 'ton'];

export default async function ScoringPage() {
  const [cfg, checks] = await Promise.all([api<ScoringConfigResponse>('/scoring/config'), api<CheckSpec[]>('/risk/checks')]);
  if (!cfg.ok) return <ApiDown message={cfg.message} />;
  const m = cfg.data.effective.momentum;
  const r = cfg.data.effective.risk;
  const totalW = Object.values(m.weights).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Scoring</h1>
        <p className="text-sm text-muted">
          How risk and momentum are computed, with the weights in effect.{' '}
          {cfg.data.stored ? (
            cfg.data.stored.valid ? `Custom config, updated ${ago(cfg.data.stored.updatedAt)}.` : <span className="text-bad">A stored config is invalid and is being ignored — defaults apply.</span>
          ) : (
            'Using defaults.'
          )}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Momentum weights">
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(m.weights).map(([k, w]) => (
                <tr key={k} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2">{k}</td>
                  <td className="num px-4 py-2 text-right">{w}</td>
                  <td className="num px-4 py-2 text-right text-muted">{totalW ? `${Math.round((w / totalW) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
            <p>Factors without data are dropped, not scored 0. If known factors carry under {Math.round(m.minWeightCoverage * 100)}% of the weight, the score is scaled down by that share.</p>
            <p>
              Fewer than {m.minStrongFactors} <em>activity</em> factors (liquidity, volume acceleration, buy pressure, participants, price momentum) at ≥ {m.strongAt} caps the score at{' '}
              {m.singleSignalCap}: one spike is not enough evidence, and youth or a clean risk sheet is not momentum. Distrusted liquidity scores 0; a price change with no trades is ignored;
              risk only counts once enough checks have run.
            </p>
            <p>Ideal age {m.idealAgeMinutes.from}–{m.idealAgeMinutes.to} min; age factor reaches 0 at {m.maxAgeMinutes} min.</p>
          </div>
        </Panel>

        <Panel title="Risk scoring">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.severityPoints).map(([k, v]) => (
                <tr key={k} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035]">
                  <td className="px-4 py-1.5">{k}</td>
                  <td className="num px-4 py-1.5 text-right">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1 px-4 py-3 text-xs text-muted">
            <p>Confidence multiplier: low ×{r.confidenceMultiplier.low}, medium ×{r.confidenceMultiplier.medium}, high ×{r.confidenceMultiplier.high}.</p>
            <p>Score = 100 × (1 − Π(1 − pᵢ/100)). A high-confidence critical flag sets a floor of {r.criticalFloor}.</p>
            <p>Levels: caution ≥ {r.levels.caution}, high ≥ {r.levels.high}, severe ≥ {r.levels.severe}. Below {Math.round(r.minCoverage * 100)}% check coverage the level is marked incomplete.</p>
          </div>
        </Panel>
      </div>

      <Panel title="Changing the weights">
        <div className="space-y-2 p-4 text-sm text-muted">
          <p>
            No code change needed: <code className="num text-ink">PUT /scoring/config</code> with the full config (validated; an invalid config is rejected) and header{' '}
            <code className="num text-ink">x-admin-token</code>. Writes are disabled until <code className="num text-ink">ADMIN_TOKEN</code> is set on the API. Changes apply at the next
            scan, or immediately with <code className="num text-ink">POST /scoring/rescore</code>. <code className="num text-ink">POST /scoring/reset</code> restores defaults.
          </p>
          <p className="text-xs text-faint">An in-dashboard editor arrives with Settings (Milestone 8), once the dashboard has sign-in.</p>
        </div>
      </Panel>

      {checks.ok && (
        <Panel title={`Check catalog (${checks.data.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Check</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  {FAMILIES.map((f) => (
                    <th key={f} className="px-2 py-2 text-center font-medium">{f}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {checks.data.map((c) => (
                  <tr key={c.id} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035] align-top">
                    <td className="px-3 py-2">
                      <div>{c.title}</div>
                      <div className="text-xs text-muted">{c.description}</div>
                      {c.plannedReason && <div className="text-xs text-warn">Not built: {c.plannedReason}</div>}
                    </td>
                    <td className="px-3 py-2 text-muted">{c.category}</td>
                    <td className="num px-3 py-2 text-xs text-muted">{c.source}</td>
                    {FAMILIES.map((f) => (
                      <td key={f} className="px-2 py-2 text-center">{c.families.includes(f) ? (c.plannedReason ? <span className="text-faint">○</span> : <span className="text-accent">●</span>) : <span className="text-faint">·</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
