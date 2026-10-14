import type { CheckResult, Severity } from '@/lib/types';

/** Risk level → colour. "incomplete" is shown alongside, never hidden. */
export function parseLevel(level: string | null): { level: string; incomplete: boolean } {
  if (!level) return { level: 'unassessed', incomplete: true };
  const [l, flag] = level.split(':');
  return { level: l, incomplete: flag === 'incomplete' };
}

const LEVEL_CLS: Record<string, string> = {
  no_major_flags: 'text-accent',
  caution: 'text-warn',
  high: 'text-bad',
  severe: 'text-bad font-semibold',
  unassessed: 'text-faint',
};
export const LEVEL_LABEL: Record<string, string> = {
  no_major_flags: 'no major flags',
  caution: 'caution',
  high: 'high risk',
  severe: 'severe',
  unassessed: 'not checked',
};

/** Compact risk cell for tables: score, coloured by level, with coverage. */
export function RiskCell({ score, level, coverage }: { score: number | null; level: string | null; coverage: number | null }) {
  if (score === null) return <span className="text-xs text-faint" title="Not assessed yet. Not checked ≠ safe.">not checked</span>;
  const p = parseLevel(level);
  return (
    <span
      className={`num ${LEVEL_CLS[p.level] ?? ''}`}
      title={`${LEVEL_LABEL[p.level] ?? p.level} · ${Math.round((coverage ?? 0) * 100)}% of checks ran${p.incomplete ? ' — too few to rely on; a low score here means little is known, not safe' : ''}`}
    >
      {score}
      {p.incomplete && <span className="ml-0.5 text-faint">?</span>}
    </span>
  );
}

export function MomentumCell({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-faint">—</span>;
  const cls = score >= 65 ? 'text-accent' : score >= 40 ? 'text-ink' : 'text-muted';
  return <span className={`num ${cls}`} title="Momentum 0–100. Ranks activity, not safety — read with the risk score.">{score.toFixed(0)}</span>;
}

export function Bar({ value, max = 100, cls = 'bg-accent' }: { value: number; max?: number; cls?: string }) {
  return (
    <span className="relative inline-block h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] align-middle">
      <span className={`absolute inset-y-0 left-0 rounded-full ${cls} shadow-[0_0_10px_currentColor]`} style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} />
    </span>
  );
}

const SEV_CLS: Record<Severity, string> = {
  info: 'border-line text-muted',
  low: 'border-info/40 text-info',
  medium: 'border-warn/40 text-warn',
  high: 'border-bad/40 text-bad',
  critical: 'border-bad bg-bad/10 text-bad',
};

export function SeverityPill({ s }: { s: Severity }) {
  return <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-wide ${SEV_CLS[s]}`}>{s}</span>;
}

export function CheckRow({ r }: { r: CheckResult }) {
  const hasEvidence = r.evidence && Object.keys(r.evidence).length > 0;
  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        {r.status === 'flagged' ? <SeverityPill s={r.severity} /> : r.status === 'passed' ? <span className="text-xs text-accent">✓</span> : <span className="text-xs text-faint">○</span>}
        <span className="text-sm">{r.title}</span>
        <span className="ml-auto text-[11px] text-faint" title={`Observed ${r.observedAt}`}>
          {r.source}
          {r.status === 'flagged' ? ` · ${r.confidence} confidence` : ''}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">{r.explanation}</p>
      {hasEvidence && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">evidence</summary>
          <pre className="num mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-2.5 ring-1 ring-white/5 text-[11px] text-muted">{JSON.stringify(r.evidence, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}
