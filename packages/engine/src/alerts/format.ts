/**
 * Alert text, Telegram HTML. Every value is escaped; unknown values print as
 * "—"; every alert ends with the research-only line.
 */

export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(3)}`;
}

export function qty(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

export function age(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function pct(v: number | null): string {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export const FOOTER = '<i>Research only — not a recommendation. A score is not a guarantee.</i>';

export interface Links {
  chart?: string | null;
  explorer?: string | null;
  dashboard?: string | null;
}

export function linkLine(l: Links): string {
  const parts = [
    l.chart ? `<a href="${esc(l.chart)}">Chart</a>` : null,
    l.explorer ? `<a href="${esc(l.explorer)}">Explorer</a>` : null,
    l.dashboard ? `<a href="${esc(l.dashboard)}">Dashboard</a>` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function riskLine(score: number | null, level: string | null, coverage: number | null): string {
  if (score === null) return 'Risk not checked';
  const [l, inc] = (level ?? '').split(':');
  const label = { no_major_flags: 'no major flags', caution: 'caution', high: 'HIGH', severe: 'SEVERE' }[l] ?? l;
  return `Risk ${score} (${label}${inc ? ', incomplete' : ''}${coverage !== null ? ` · ${Math.round(coverage * 100)}% of checks ran` : ''})`;
}
