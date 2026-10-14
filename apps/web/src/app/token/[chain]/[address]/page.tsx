import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ChartEmbed, LaunchpadBadge } from '@/components/chart-embed';
import { Sparkline } from '@/components/sparkline';
import { Bar, CheckRow, LEVEL_LABEL, MomentumCell, parseLevel } from '@/components/scores';
import { addWatchlistItem, openPaperTrade } from '@/app/actions';
import { ApiDown, ChangeCell, Flash, FreshnessBadge, Panel, Sourced } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { REASON_LABEL, age, ago, int, price, shortAddr, until, usd } from '@/lib/format';
import type { ChainRow, TokenDetail, WatchlistRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function TokenPage({ params, searchParams }: { params: Promise<{ chain: string; address: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { chain, address } = await params;
  const sp = await searchParams;
  const lists = writesEnabled() ? await api<WatchlistRow[]>('/watchlists') : null;
  const [res, chains] = await Promise.all([
    api<TokenDetail>(`/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(decodeURIComponent(address))}?hours=72`),
    api<ChainRow[]>('/chains'),
  ]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <ApiDown message={res.message} />;

  const d = res.data;
  const p = d.pairs.find((x) => x.isPrimary) ?? d.pairs[0];
  const chainRow = chains.ok ? chains.data.find((c) => c.id === d.chain.id) : undefined;
  const fs = p?.fieldSources ?? {};
  const est = (f: string) => p?.estimatedFields.includes(f) ?? false;
  const series = (k: 'priceUsd' | 'liquidityUsd' | 'txnsH1') =>
    d.history.map((h) => ({ t: Date.parse(h.observedAt), v: h[k] }));

  return (
    <div className="space-y-5">
      <Link href="/discover" className="text-xs text-muted hover:text-ink">
        ← Discovery
      </Link>

      <Flash msg={sp.msg} err={sp.err} />
      <div className="flex flex-wrap items-start gap-4">
        {d.token.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={d.token.imageUrl} alt="" className="h-12 w-12 rounded-full bg-white/5 ring-1 ring-white/10" />
        ) : (
          <div className="h-12 w-12 rounded-full bg-white/5 ring-1 ring-white/10" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-semibold tracking-tight">
            {d.token.symbol ?? shortAddr(d.token.address)}{' '}
            <span className="text-base font-normal text-muted">{d.token.name}</span>
          </h1>
          <p className="num mt-1 break-all text-xs text-muted">
            {d.chain.name} · {d.token.address}
          </p>
          {d.launchpad && (
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
              <LaunchpadBadge lp={d.launchpad} />
              {d.launchpad.graduatedAt && <span>graduated {ago(d.launchpad.graduatedAt)}</span>}
            </p>
          )}
          <p className="mt-1 text-xs text-faint">
            First seen {ago(d.token.firstSeenAt)} via {d.token.firstSeenSource} · metadata from {d.token.metadataSource ?? 'unknown'}
            {d.token.decimals !== null ? ` · ${d.token.decimals} decimals` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {d.token.explorerUrl && (
            <a href={d.token.explorerUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost px-2.5 py-1">
              Explorer ↗
            </a>
          )}
          {lists?.ok && lists.data.length > 0 && (
            <form action={addWatchlistItem} className="flex items-center gap-1.5">
              <select name="watchlistId" className="field h-8 px-2.5 text-xs" aria-label="Watchlist">
                {lists.data.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <input type="hidden" name="kind" value="token" />
              <input type="hidden" name="chainId" value={d.chain.id} />
              <input type="hidden" name="address" value={d.token.address} />
              <input type="hidden" name="returnTo" value={`/token/${d.chain.id}/${encodeURIComponent(d.token.address)}`} />
              <button className="btn-ghost px-2.5 py-1 text-xs">+ Watch</button>
            </form>
          )}
          {p?.pair.url && (
            <a href={p.pair.url} target="_blank" rel="noopener noreferrer" className="btn-ghost px-2.5 py-1">
              Pair chart ↗
            </a>
          )}
        </div>
      </div>

      {p && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
          {[
            ['Price', <Sourced key="p" source={fs.priceUsd}>${price(p.priceUsd)}</Sourced>],
            ['Liquidity', <Sourced key="l" source={fs.liquidityUsd} estimated={est('liquidityUsd')}>{usd(p.liquidityUsd)}</Sourced>],
            ['FDV', <Sourced key="f" source={fs.fdvUsd} estimated={est('fdvUsd')}>{usd(p.fdvUsd)}</Sourced>],
            ['Market cap', <Sourced key="m" source={fs.marketCapUsd} estimated={est('marketCapUsd')}>{usd(p.marketCapUsd)}</Sourced>],
            ['Vol 24h', <Sourced key="v" source={fs['volume.h24']}>{usd(p.volume.h24)}</Sourced>],
            ['Txns 24h', int(p.txnsH24)],
            ['Buyers / sellers 24h', p.buyersH24 === null ? '—' : `${int(p.buyersH24)} / ${int(p.sellersH24)}`],
            ['Pair age', age(p.ageMinutes)],
          ].map(([label, value]) => (
            <div key={label as string} className="glass rounded-xl px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
              <div className="num mt-1 text-base">{value}</div>
            </div>
          ))}
        </div>
      )}

      {p && (
        <Panel title={`Chart · ${p.pair.dexId ?? 'primary pair'}`} right={<span className="text-xs text-faint">live, from the provider</span>}>
          <ChartEmbed chainId={d.chain.id} pairAddress={p.pair.address} source={sp.chart === 'gt' ? 'gt' : 'ds'} basePath={`/token/${d.chain.id}/${encodeURIComponent(d.token.address)}`} />
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={`Our observations · last ${d.historyWindowHours}h · primary pair`} className="lg:col-span-2" right={p && <FreshnessBadge freshness={p.freshness} at={p.marketUpdatedAt} />}>
          <div className="space-y-4 p-4">
            {(
              [
                ['Price (USD)', 'priceUsd', 'var(--color-accent)'],
                ['Liquidity (USD)', 'liquidityUsd', 'var(--color-info)'],
                ['Transactions, trailing 1h', 'txnsH1', 'var(--color-warn)'],
              ] as const
            ).map(([label, key, color]) => (
              <div key={key}>
                <div className="mb-1 text-xs text-muted">{label}</div>
                <Sparkline points={series(key)} stroke={color} label={label} />
              </div>
            ))}
            <p className="text-xs text-faint">
              {d.history.length} observations from {[...new Set(d.history.map((h) => h.source))].join(' + ') || 'no source'}. Each source is plotted as reported; values from different providers can differ slightly.
            </p>
          </div>
        </Panel>

        <DiscoveryPanel d={d} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <RiskPanel d={d} chainNote={chainRow?.capabilities.riskChecks.note} />
        <MomentumPanel d={d} />
      </div>

      {writesEnabled() && p && (
        <form action={openPaperTrade} className="glass flex flex-wrap items-end gap-3 rounded-2xl px-5 py-4 text-sm">
          <div className="mr-2">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Paper buy</div>
            <div className="text-xs text-faint">Hypothetical — at ${price(p.priceUsd)} (observed {p.marketUpdatedAt ? ago(p.marketUpdatedAt) : 'never'})</div>
          </div>
          <input type="hidden" name="tokenId" value={d.token.id} />
          <input type="hidden" name="returnTo" value={`/token/${d.chain.id}/${encodeURIComponent(d.token.address)}`} />
          {(
            [
              ['sizeUsd', 'Size $', '100', true],
              ['takeProfitPct', 'Take profit %', 'e.g. 50', false],
              ['stopLossPct', 'Stop loss %', 'e.g. 25', false],
              ['maxHoldMinutes', 'Max hold (min)', 'e.g. 240', false],
            ] as const
          ).map(([name, label, ph, req]) => (
            <label key={name} className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.1em] text-faint">{label}</span>
              <input name={name} inputMode="decimal" placeholder={ph} defaultValue={name === 'sizeUsd' ? '100' : ''} required={req} className="num field h-9 w-28 px-3" />
            </label>
          ))}
          <button className="btn-primary h-9 px-4">Open paper position</button>
        </form>
      )}

      <Panel title={`Pairs (${d.pairs.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">Pair</th>
                <th className="px-3 py-2 font-medium">DEX</th>
                <th className="px-3 py-2 text-right font-medium">Age</th>
                <th className="px-3 py-2 text-right font-medium">Liquidity</th>
                <th className="px-3 py-2 text-right font-medium">Vol 24h</th>
                <th className="px-3 py-2 text-right font-medium">Δ 1h</th>
                <th className="px-3 py-2 text-right font-medium">Δ 24h</th>
                <th className="px-3 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {d.pairs.map((x) => (
                <tr key={x.pair.address} className="border-b border-white/[0.045] transition-colors hover:bg-white/[0.035]">
                  <td className="num px-3 py-2 text-xs">
                    {x.isPrimary && <span className="mr-1 text-accent" title="Most liquid pair — used for the feed">●</span>}
                    {d.token.symbol ?? '?'}/{x.pair.quoteSymbol ?? '?'} <span className="text-faint">{shortAddr(x.pair.address)}</span>
                  </td>
                  <td className="px-3 py-2 text-muted">{x.pair.dexId ?? '—'}</td>
                  <td className="num px-3 py-2 text-right">{age(x.ageMinutes)}</td>
                  <td className="num px-3 py-2 text-right">{usd(x.liquidityUsd)}</td>
                  <td className="num px-3 py-2 text-right">{usd(x.volume.h24)}</td>
                  <td className="num px-3 py-2 text-right"><ChangeCell v={x.priceChange.h1} /></td>
                  <td className="num px-3 py-2 text-right"><ChangeCell v={x.priceChange.h24} /></td>
                  <td className="px-3 py-2 text-right"><FreshnessBadge freshness={x.freshness} at={x.marketUpdatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function DiscoveryPanel({ d }: { d: TokenDetail }) {
  const reasons = [...new Set(d.pairs.flatMap((x) => x.discoveryReasons))];
  return (
    <Panel title="How it was found">
      <div className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap gap-1 text-xs">
          {reasons.map((r) => (
            <span key={r} className={`rounded-md border px-1.5 py-0.5 ${r === 'token_boost' ? 'border-warn/40 text-warn' : 'border-line text-muted'}`}>
              {REASON_LABEL[r] ?? r}
            </span>
          ))}
        </div>
        {reasons.includes('token_boost') && (
          <p className="text-xs text-warn">A paid DEX Screener boost was bought for this token. Promotion spend is not evidence of quality.</p>
        )}
        <p className="text-xs text-muted">
          Contract checks {d.risk.contractCheckedAt ? `last ran ${ago(d.risk.contractCheckedAt)}` : 'have not run yet'}
          {d.risk.contractNextCheckAt ? ` · next ${until(d.risk.contractNextCheckAt)}` : ''}.
        </p>
      </div>
    </Panel>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  contract: 'Contract',
  holders: 'Holders',
  liquidity: 'Liquidity',
  market: 'Market behaviour',
  data: 'Data quality',
};

function RiskPanel({ d, chainNote }: { d: TokenDetail; chainNote?: string }) {
  const detail = d.risk.detail;
  if (!detail || d.risk.score === null) {
    return (
      <Panel title="Risk analysis" className="lg:col-span-2">
        <div className="space-y-2 p-4 text-sm text-muted">
          <p>Not assessed yet — this token is <span className="text-ink">not checked</span>, which is not the same as “no issues found”.</p>
          {chainNote && <p className="text-xs text-faint">{chainNote}</p>}
        </div>
      </Panel>
    );
  }
  const { level, incomplete } = parseLevel(d.risk.level);
  const s = detail.summary;
  const flagged = detail.results.filter((r) => r.status === 'flagged').sort((a, b) => SEV_ORDER.indexOf(b.severity) - SEV_ORDER.indexOf(a.severity));
  const passed = detail.results.filter((r) => r.status === 'passed');
  const unchecked = detail.results.filter((r) => r.status === 'not_checked' || r.status === 'error');
  const levelCls = level === 'no_major_flags' ? 'text-accent' : level === 'caution' ? 'text-warn' : 'text-bad';

  return (
    <Panel title="Risk analysis" className="lg:col-span-2" right={<span className="text-xs text-faint">assessed {ago(d.risk.assessedAt)}</span>}>
      <div className="grid gap-4 border-b border-line p-4 sm:grid-cols-[auto_1fr]">
        <div>
          <div className={`num text-4xl ${levelCls}`}>{s.score}</div>
          <div className={`text-sm ${levelCls}`}>{LEVEL_LABEL[level] ?? level}</div>
          <div className="mt-1 text-xs text-muted">
            {s.checksRun} of {s.checksApplicable} checks ran ({Math.round(s.coverage * 100)}%)
          </div>
          {incomplete && (
            <p className="mt-2 max-w-[220px] text-xs text-warn">Too few checks have run to rely on this score. A low number here means little is known — not that the token is safe.</p>
          )}
        </div>
        <div className="space-y-2">
          {Object.entries(s.categories)
            .filter(([, c]) => c.applicable > 0)
            .map(([cat, c]) => (
              <div key={cat} className="grid grid-cols-[110px_1fr_70px] items-center gap-3 text-xs">
                <span className="text-muted">{CATEGORY_LABEL[cat] ?? cat}</span>
                <Bar value={c.score} cls={c.score >= 45 ? 'bg-bad' : c.score >= 20 ? 'bg-warn' : 'bg-accent'} />
                <span className="num text-right text-muted" title={`${c.flagged} flagged · ${c.run} of ${c.applicable} checks ran`}>
                  {c.score} · {c.run}/{c.applicable}
                </span>
              </div>
            ))}
          <p className="pt-1 text-[11px] text-faint">
            Score = 100 × (1 − Π(1 − pᵢ/100)) over flagged checks, where pᵢ = severity points × confidence. A high-confidence critical flag sets a floor.
            Weights are on the Scoring page.
          </p>
        </div>
      </div>
      <Section title={`Flagged (${flagged.length})`} open>
        {flagged.length === 0 ? <p className="px-4 py-3 text-xs text-muted">No check that ran raised a flag.</p> : <ul>{flagged.map((r) => <CheckRow key={r.checkId} r={r} />)}</ul>}
      </Section>
      <Section title={`Not checked (${unchecked.length})`} open={incomplete}>
        <ul>{unchecked.map((r) => <CheckRow key={r.checkId} r={r} />)}</ul>
      </Section>
      <Section title={`Passed (${passed.length})`}>
        <ul>{passed.map((r) => <CheckRow key={r.checkId} r={r} />)}</ul>
      </Section>
    </Panel>
  );
}

const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

function Section({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="border-b border-line last:border-0">
      <summary className="cursor-pointer px-4 py-2 text-xs uppercase tracking-wider text-muted hover:text-ink">{title}</summary>
      {children}
    </details>
  );
}

const FACTOR_LABEL: Record<string, string> = {
  liquidity: 'Liquidity',
  volumeAcceleration: 'Volume acceleration',
  buyPressure: 'Buy pressure',
  participants: 'Participants',
  age: 'Age',
  priceMomentum: 'Price momentum',
  holderDistribution: 'Holder distribution',
  riskPenalty: 'Risk penalty',
};

function MomentumPanel({ d }: { d: TokenDetail }) {
  const m = d.momentum.detail;
  return (
    <Panel title="Momentum" right={<MomentumCell score={d.momentum.score} />}>
      {!m ? (
        <p className="p-4 text-sm text-muted">Not scored yet.</p>
      ) : (
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted">Ranks how much is happening — not how safe it is. Each factor is 0–1; contributions are its share of the score.</p>
          <ul className="space-y-2.5">
            {m.factors.map((f) => (
              <li key={f.key} title={f.explanation}>
                <div className="flex items-center justify-between text-xs">
                  <span className={f.value === null ? 'text-faint' : 'text-ink'}>{FACTOR_LABEL[f.key] ?? f.key}</span>
                  <span className="num text-muted">
                    {f.value === null ? 'no data' : `${f.value.toFixed(2)} × w${f.weight}`} {f.value !== null && <span className="text-ink">+{f.contribution}</span>}
                  </span>
                </div>
                {f.value !== null && <Bar value={f.value} max={1} cls="bg-info" />}
                <p className="mt-0.5 text-[11px] text-faint">{f.explanation}</p>
              </li>
            ))}
          </ul>
          {m.adjustments.map((a) => (
            <p key={a} className="text-xs text-warn">{a}</p>
          ))}
          <p className="text-[11px] text-faint">{Math.round(m.weightCoverage * 100)}% of factor weight had data.</p>
        </div>
      )}
    </Panel>
  );
}
