/** Minimal SVG line chart. Gaps (nulls) break the line instead of drawing to zero. */
export function Sparkline({
  points,
  height = 64,
  stroke = 'var(--color-accent)',
  label,
}: {
  points: Array<{ t: number; v: number | null }>;
  height?: number;
  stroke?: string;
  label: string;
}) {
  const known = points.filter((p): p is { t: number; v: number } => p.v !== null);
  if (known.length < 2) {
    return <div className="flex h-16 items-center text-xs text-faint">Not enough observations yet for {label.toLowerCase()} — history builds with each scan.</div>;
  }
  const w = 600;
  const t0 = known[0].t;
  const t1 = known[known.length - 1].t;
  const lo = Math.min(...known.map((p) => p.v));
  const hi = Math.max(...known.map((p) => p.v));
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * w);
  const y = (v: number) => (hi === lo ? height / 2 : height - 4 - ((v - lo) / (hi - lo)) * (height - 8));
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.v === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    pen = true;
  }
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label={`${label} over time`}>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
