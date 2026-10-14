/** Lenient numeric parsing for provider payloads: anything unparseable is null, never 0. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function date(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  const t = d.getTime();
  // Reject epoch-zero and far-future junk some feeds emit for "unknown".
  if (!Number.isFinite(t) || t < Date.UTC(2015, 0, 1) || t > Date.now() + 24 * 60 * 60_000) return null;
  return d;
}
