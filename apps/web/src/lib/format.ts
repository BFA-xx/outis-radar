/** Formatting. Every formatter renders null as an em dash — unknown is never shown as 0. */

export const DASH = '—';

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${price(v)}`;
}

/** Tiny prices: 0.0₅1234 style, so a memecoin price stays readable. */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (v === 0) return '0';
  const s = v.toFixed(20);
  const m = /^0\.(0*)(\d{1,4})/.exec(s);
  if (!m) return v.toPrecision(4);
  const zeros = m[1].length;
  if (zeros < 4) return v.toPrecision(4);
  const sub = String(zeros)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('');
  return `0.0${sub}${m[2]}`;
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  const sign = v > 0 ? '+' : '';
  return `${sign}${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  return v.toLocaleString('en-US');
}

export function age(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return DASH;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const days = Math.floor(minutes / (24 * 60));
  return days < 365 ? `${days}d` : `${(days / 365).toFixed(1)}y`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Time until a future instant: "in 12m". Past instants read "due now". */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'not scheduled';
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return 'due now';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export const REASON_LABEL: Record<string, string> = {
  new_pool: 'new pool',
  token_profile: 'DS profile',
  token_boost: 'paid boost',
  community_takeover: 'CTO',
  wallet_activity: 'tracked wallet',
  lookup: 'searched',
  refresh: 'refresh',
};
