import Link from 'next/link';
import { LAUNCHPADS } from '@outis/shared';
import { AutoRefresh } from '@/components/auto-refresh';
import { LaunchpadBadge } from '@/components/chart-embed';
import { ApiDown, ChangeCell, FreshnessBadge, Panel, Sourced } from '@/components/ui';
import { api } from '@/lib/api';
import { MomentumCell, RiskCell } from '@/components/scores';
import { REASON_LABEL, age, int, price, shortAddr, usd } from '@/lib/format';
import type { ChainRow, FeedItem, Paginated } from '@/lib/types';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;

const SORTS = [
  ['pairCreatedAt', 'Age'],
  ['liquidityUsd', 'Liquidity'],
  ['volumeH24', 'Vol 24h'],
  ['volumeH1', 'Vol 1h'],
  ['txnsH1', 'Txns 1h'],
  ['priceChangeH1', 'Δ 1h'],
  ['marketUpdatedAt', 'Updated'],
  ['momentumScore', 'Momentum'],
  ['riskScore', 'Risk'],
] as const;

const DEFAULT_MAX_AGE = '72';

function one(sp: SP, k: string): string | undefined {
  const v = sp[k];
  return Array.isArray(v) ? v[0] : v;
}

/** URL-level params → API query. maxAgeHours defaults to 72h ("early" tokens); "any" lifts it. */
function toApiQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of ['chain', 'q', 'minLiquidityUsd', 'minVolumeH24', 'minTxnsH1', 'maxRiskScore', 'minMomentumScore', 'launchpad', 'stage', 'sort', 'order', 'page', 'pageSize']) {
    const v = one(sp, k);
    if (v) q.set(k, v);
  }
  const maxAge = one(sp, 'maxAgeHours') ?? DEFAULT_MAX_AGE;
  if (maxAge !== 'any') q.set('maxAgeHours', maxAge);
  return q;
}

function withParams(sp: SP, patch: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) q.set(k, s);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  return `/discover?${q.toString()}`;
}

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const query = toApiQuery(sp);
  const [feed, chains] = await Promise.all([
    api<Paginated<FeedItem>>(`/tokens?${query.toString()}`),
    api<ChainRow[]>('/chains'),
  ]);

  const sort = one(sp, 'sort') ?? 'pairCreatedAt';
  const order = one(sp, 'order') ?? 'desc';
  const scanned = chains.ok ? chains.data.filter((c) => c.scanned) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Discovery feed</h1>
          <p className="text-sm text-muted">
            One row per token (its most liquid pair). <span className="text-ink">Momentum</span> ranks activity;{' '}
            <span className="text-ink">Risk</span> (0–100, higher is worse) is separate. A <span className="text-faint">?</span> after a risk score means too few
            checks have run to rely on it — a low score then means little is known, not safe.
          </p>
        </div>
        <AutoRefresh seconds={60} />
      </div>

      <form action="/discover" className="glass grid grid-cols-2 gap-3 rounded-2xl p-4 text-sm sm:grid-cols-4 lg:grid-cols-12">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Search symbol / name / address</span>
          <input name="q" defaultValue={one(sp, 'q') ?? ''} placeholder="e.g. PEPE or 0x…" className="field h-9 px-3" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Chain</span>
          <select name="chain" defaultValue={one(sp, 'chain') ?? ''} className="field h-9 px-3">
            <option value="">All scanned</option>
            {scanned.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Launchpad</span>
          <select name="launchpad" defaultValue={one(sp, 'launchpad') ?? ''} className="field h-9 px-3">
            <option value="">Any or none</option>
            <option value="any">Any launchpad</option>
            {LAUNCHPADS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Stage</span>
          <select name="stage" defaultValue={one(sp, 'stage') ?? ''} className="field h-9 px-3">
            <option value="">Any</option>
            <option value="curve">On bonding curve</option>
            <option value="graduated">Graduated</option>
            <option value="launched">Launched (no curve)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Max age</span>
          <select name="maxAgeHours" defaultValue={one(sp, 'maxAgeHours') ?? DEFAULT_MAX_AGE} className="field h-9 px-3">
            <option value="1">1h</option>
            <option value="6">6h</option>
            <option value="24">24h</option>
            <option value="72">72h</option>
            <option value="168">7d</option>
            <option value="any">Any</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Min liquidity $</span>
          <input name="minLiquidityUsd" inputMode="numeric" defaultValue={one(sp, 'minLiquidityUsd') ?? ''} placeholder="0" className="num field h-9 px-3" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Min vol 24h $</span>
          <input name="minVolumeH24" inputMode="numeric" defaultValue={one(sp, 'minVolumeH24') ?? ''} placeholder="0" className="num field h-9 px-3" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Min txns 1h</span>
          <input name="minTxnsH1" inputMode="numeric" defaultValue={one(sp, 'minTxnsH1') ?? ''} placeholder="0" className="num field h-9 px-3" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Max risk</span>
          <select name="maxRiskScore" defaultValue={one(sp, 'maxRiskScore') ?? ''} className="field h-9 px-3">
            <option value="">Any</option>
            <option value="19">&lt; 20</option>
            <option value="44">&lt; 45</option>
            <option value="69">&lt; 70</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Min momentum</span>
          <input name="minMomentumScore" inputMode="numeric" defaultValue={one(sp, 'minMomentumScore') ?? ''} placeholder="0" className="num field h-9 px-3" />
        </label>
        <div className="flex items-end gap-2">
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="order" value={order} />
          <button className="btn-primary h-9 w-full px-3 text-sm">Apply</button>
          <Link href="/discover" className="btn-ghost flex h-9 items-center px-3" title="Reset filters">
            ✕
          </Link>
        </div>
      </form>

      {!feed.ok ? (
        <ApiDown message={feed.message} />
      ) : (
        <Panel
          title={`${int(feed.data.total)} tokens`}
          right={<span className="hidden text-xs text-faint sm:inline">Hover a value for its source · ~ = provider estimate</span>}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Token</th>
                  <th className="px-3 py-2 font-medium">Chain</th>
                  {SORTS.map(([key, label]) => {
                    const activeSort = sort === key;
                    const nextOrder = activeSort && order === 'desc' ? 'asc' : 'desc';
                    return (
                      <th key={key} className="px-3 py-2 text-right font-medium">
                        <Link href={withParams(sp, { sort: key, order: nextOrder, page: undefined })} className={activeSort ? 'text-ink' : 'hover:text-ink'}>
                          {label}
                          {activeSort ? (order === 'desc' ? ' ↓' : ' ↑') : ''}
                        </Link>
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium" title="Distinct buyers / sellers over 24h (GeckoTerminal only)">
                    Buyers/Sellers
                  </th>
                </tr>
              </thead>
              <tbody>
                {feed.data.items.length === 0 && (
                  <tr>
                    <td colSpan={13} className="px-3 py-10 text-center text-muted">
                      No tokens match. Widen the filters, or run a scan: <code className="num text-ink">npm run scan</code>
                    </td>
                  </tr>
                )}
                {feed.data.items.map((t) => (
                  <Row key={`${t.chain.id}:${t.pair.address}`} t={t} />
                ))}
              </tbody>
            </table>
          </div>
          <Pager sp={sp} page={feed.data.page} pageSize={feed.data.pageSize} total={feed.data.total} />
        </Panel>
      )}
    </div>
  );
}

function Row({ t }: { t: FeedItem }) {
  const fs = t.fieldSources;
  const est = (f: string) => t.estimatedFields.includes(f);
  return (
    <tr className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035]">
      <td className="px-3 py-2">
        <Link href={`/token/${t.chain.id}/${encodeURIComponent(t.token.address)}`} className="flex items-center gap-2">
          {t.token.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.token.imageUrl} alt="" className="h-6 w-6 shrink-0 rounded-full bg-white/5 ring-1 ring-white/10" loading="lazy" />
          ) : (
            <span className="h-6 w-6 shrink-0 rounded-full bg-white/5 ring-1 ring-white/10" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{t.token.symbol ?? shortAddr(t.token.address)}</span>
            <span className="block truncate text-xs text-muted">
              {t.token.name ?? '—'}
              {t.discoveryReasons
                .filter((r) => r !== 'new_pool' && r !== 'refresh')
                .map((r) => (
                  <span key={r} className={`ml-1.5 rounded-md border px-1 text-[10px] ${r === 'token_boost' ? 'border-warn/40 text-warn' : 'border-line text-faint'}`} title={r === 'token_boost' ? 'Promotion was paid for on DEX Screener — not a quality signal' : undefined}>
                    {REASON_LABEL[r] ?? r}
                  </span>
                ))}
            </span>
          </span>
        </Link>
      </td>
      <td className="px-3 py-2 text-muted">
        {t.chain.name}
        <span className="block text-xs text-faint">{t.pair.dexId ?? '—'}</span>
        {t.launchpad && (
          <span className="mt-0.5 block">
            <LaunchpadBadge lp={t.launchpad} />
          </span>
        )}
      </td>
      <td className="num px-3 py-2 text-right" title={t.pairCreatedAt ? `Pair created ${t.pairCreatedAt}` : 'Creation time not reported'}>
        {age(t.ageMinutes)}
      </td>
      <td className="num px-3 py-2 text-right">
        <Sourced source={fs.liquidityUsd} estimated={est('liquidityUsd')}>
          {usd(t.liquidityUsd)}
        </Sourced>
      </td>
      <td className="num px-3 py-2 text-right">
        <Sourced source={fs['volume.h24']}>{usd(t.volume.h24)}</Sourced>
      </td>
      <td className="num px-3 py-2 text-right">
        <Sourced source={fs['volume.h1']}>{usd(t.volume.h1)}</Sourced>
      </td>
      <td className="num px-3 py-2 text-right">
        <Sourced source={fs['txns.h1.buys']}>{int(t.txnsH1)}</Sourced>
      </td>
      <td className="num px-3 py-2 text-right">
        <ChangeCell v={t.priceChange.h1} />
      </td>
      <td className="px-3 py-2 text-right">
        <FreshnessBadge freshness={t.freshness} at={t.marketUpdatedAt} />
      </td>
      <td className="px-3 py-2 text-right">
        <MomentumCell score={t.scores.momentum} />
      </td>
      <td className="px-3 py-2 text-right">
        <RiskCell score={t.scores.risk} level={t.scores.riskLevel} coverage={t.scores.riskCoverage} />
      </td>
      <td className="num px-3 py-2 text-right">
        <Sourced source={fs.priceUsd}>${price(t.priceUsd)}</Sourced>
      </td>
      <td className="num px-3 py-2 text-right text-muted">
        {t.buyersH24 === null && t.sellersH24 === null ? '—' : `${int(t.buyersH24)} / ${int(t.sellersH24)}`}
      </td>
    </tr>
  );
}

function Pager({ sp, page, pageSize, total }: { sp: SP; page: number; pageSize: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
      <span className="num">
        {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {int(total)}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className="btn-ghost px-2.5 py-1" href={withParams(sp, { page: String(page - 1) })}>
            ← Prev
          </Link>
        ) : (
          <span className="rounded-[0.6rem] border border-white/5 px-2.5 py-1 text-faint">← Prev</span>
        )}
        <span className="num px-1 py-1">
          {page} / {pages}
        </span>
        {page < pages ? (
          <Link className="btn-ghost px-2.5 py-1" href={withParams(sp, { page: String(page + 1) })}>
            Next →
          </Link>
        ) : (
          <span className="rounded-[0.6rem] border border-white/5 px-2.5 py-1 text-faint">Next →</span>
        )}
      </div>
    </div>
  );
}
