import type { ReactNode } from 'react';
import { ago } from '@/lib/format';
import type { Freshness } from '@/lib/types';

export function Panel({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass overflow-hidden rounded-2xl ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {sub && <div className="mt-1 max-w-3xl text-sm text-muted">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

const FRESH: Record<Freshness, { cls: string; label: string; hint: string }> = {
  live: { cls: 'text-accent', label: 'live', hint: 'Observed within 10 minutes' },
  recent: { cls: 'text-info', label: 'recent', hint: 'Observed within the last hour' },
  stale: { cls: 'text-warn', label: 'stale', hint: 'Older than an hour — cached, may be out of date' },
  unavailable: { cls: 'text-faint', label: 'n/a', hint: 'No market observation' },
};

export function FreshnessBadge({ freshness, at }: { freshness: Freshness; at: string | null }) {
  const f = FRESH[freshness];
  return (
    <span className={`num inline-flex items-center gap-1.5 text-xs ${f.cls}`} title={`${f.hint}${at ? ` · ${new Date(at).toISOString()}` : ''}`}>
      <span className="relative inline-flex h-1.5 w-1.5">
        {freshness === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-40" />}
        <span className="relative h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_8px_currentColor]" />
      </span>
      {at ? ago(at) : f.label}
    </span>
  );
}

const STATUS_CLS: Record<string, string> = {
  live: 'bg-accent/10 text-accent ring-accent/25',
  ok: 'bg-accent/10 text-accent ring-accent/25',
  partial: 'bg-warn/10 text-warn ring-warn/25',
  running: 'bg-info/10 text-info ring-info/25',
  needs_config: 'bg-warn/10 text-warn ring-warn/25',
  awaiting_config: 'bg-warn/10 text-warn ring-warn/25',
  planned: 'bg-white/[0.03] text-faint ring-white/10',
  disabled: 'bg-white/[0.03] text-faint ring-white/10',
  skipped: 'bg-white/[0.03] text-muted ring-white/10',
  unavailable: 'bg-bad/10 text-bad ring-bad/25',
  failed: 'bg-bad/10 text-bad ring-bad/25',
};

export function StatusPill({ status, title }: { status: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-4 ring-1 ring-inset ${STATUS_CLS[status] ?? 'bg-white/[0.03] text-muted ring-white/10'}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

/** Shows that a number is an estimate, with its source on hover. */
export function Sourced({ children, source, estimated }: { children: ReactNode; source?: { source: string; at: string }; estimated?: boolean }) {
  const title = [estimated ? 'Estimate (derived by the provider, not measured)' : null, source ? `Source: ${source.source} · ${new Date(source.at).toISOString()}` : 'Not reported by any source']
    .filter(Boolean)
    .join('\n');
  return (
    <span title={title} className={estimated ? 'underline decoration-faint decoration-dotted underline-offset-4' : undefined}>
      {children}
      {estimated && <span className="ml-0.5 text-faint">~</span>}
    </span>
  );
}

export function ApiDown({ message }: { message: string }) {
  return (
    <div className="glass rounded-2xl border-bad/30 px-5 py-4 text-sm">
      <p className="font-medium text-bad">Data unavailable</p>
      <p className="mt-1 text-muted">
        {message.replace(/[.\s]+$/, '')}. Nothing is shown rather than stale or sample data.{' '}
        {process.env.VERCEL === '1' ? (
          <>The API project&apos;s logs on Vercel show what is missing.</>
        ) : (
          <>
            Start everything with <code className="num text-ink">npm start</code>.
          </>
        )}
      </p>
    </div>
  );
}

export function Stat({ label, value, hint, accent = false }: { label: string; value: ReactNode; hint?: string; accent?: boolean }) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl px-5 py-4" title={hint}>
      {accent && <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-accent/15 blur-2xl" />}
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="num mt-2 text-[28px] font-medium leading-none tracking-tight text-ink">{value}</div>
    </div>
  );
}

export function ChangeCell({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint">—</span>;
  const cls = v > 0 ? 'text-accent' : v < 0 ? 'text-bad' : 'text-muted';
  return <span className={cls}>{`${v > 0 ? '+' : ''}${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)}%`}</span>;
}

/** Table row hover + spacing used by every data table. */
export const ROW = 'border-b border-white/[0.045] transition-colors last:border-0 hover:bg-white/[0.035]';
export const TH = 'px-3 py-2.5 font-medium text-faint';

/** Result banner for server-action redirects (?msg= / ?err=). */
export function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return (
    <div className={`glass rounded-xl px-4 py-2.5 text-sm ${err ? 'text-bad' : 'text-accent'}`} role="status">
      {err ?? msg}
    </div>
  );
}

export function WritesDisabled() {
  return (
    <p className="text-xs text-faint">
      Editing is off. Set <code className="num text-muted">DASHBOARD_WRITES=1</code> and <code className="num text-muted">ADMIN_TOKEN</code> for this dashboard (only on a
      private deployment — there is no sign-in yet).
    </p>
  );
}
