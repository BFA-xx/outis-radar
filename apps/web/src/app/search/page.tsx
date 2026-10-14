import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RiskCell } from '@/components/scores';
import { ApiDown, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { shortAddr, usd } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface LookupResponse {
  query: string;
  invalid: boolean;
  fetched: boolean;
  resolvedFrom: 'pair' | null;
  providerProblem: boolean;
  hits: Array<{
    chainId: string;
    chainName: string;
    address: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    liquidityUsd: number | null;
    marketCapUsd: number | null;
    riskScore: number | null;
    riskLevel: string | null;
    riskCoverage: number | null;
  }>;
}

const tokenHref = (h: { chainId: string; address: string }) => `/token/${h.chainId}/${encodeURIComponent(h.address)}`;

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = ((await searchParams).q ?? '').trim();
  if (!q) {
    return (
      <div className="space-y-5">
        <PageHeader title="Search" sub="Paste a contract address (any chain we cover) or a DEX Screener link." />
        <SearchForm q="" />
      </div>
    );
  }
  // Live fetch + contract checks can take a few seconds for a token we have not seen.
  const res = await api<LookupResponse>(`/lookup?q=${encodeURIComponent(q)}`, 30_000);
  if (!res.ok) return <ApiDown message={res.message} />;
  const r = res.data;
  if (r.hits.length === 1) redirect(tokenHref(r.hits[0]));

  return (
    <div className="space-y-5">
      <PageHeader title="Search" sub={<span className="num break-all">{r.query}</span>} />
      <SearchForm q={q} />
      {r.invalid ? (
        <Panel title="Not an address">
          <p className="px-5 py-4 text-sm text-muted">
            That does not look like a contract address. To search by name or symbol, use{' '}
            <Link href={`/discover?q=${encodeURIComponent(q)}&maxAgeHours=any`} className="text-accent hover:underline">Discovery</Link>.
          </p>
        </Panel>
      ) : r.hits.length === 0 ? (
        <Panel title="Nothing found">
          <p className="px-5 py-4 text-sm text-muted">
            {r.providerProblem
              ? 'The data providers did not answer just now. Try again in a minute.'
              : 'No trading pool for this address on any chain we cover. It may not be trading yet, or it is a wallet rather than a token.'}
          </p>
        </Panel>
      ) : (
        <Panel title={`Trades on ${r.hits.length} chains — pick one`}>
          <ul>
            {r.hits.map((h) => (
              <li key={`${h.chainId}:${h.address}`} className="border-b border-white/[0.045] last:border-0">
                <Link href={tokenHref(h)} className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.035]">
                  {h.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.imageUrl} alt="" className="h-7 w-7 rounded-full bg-white/5 ring-1 ring-white/10" />
                  ) : (
                    <span className="h-7 w-7 rounded-full bg-white/5 ring-1 ring-white/10" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{h.symbol ?? shortAddr(h.address)} <span className="text-xs text-muted">{h.chainName}</span></span>
                    <span className="block truncate text-xs text-faint">{h.name}</span>
                  </span>
                  <span className="num text-right text-xs text-muted">
                    Liq {usd(h.liquidityUsd)}
                    <br />
                    MC {usd(h.marketCapUsd)}
                  </span>
                  <RiskCell score={h.riskScore} level={h.riskLevel} coverage={h.riskCoverage} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function SearchForm({ q }: { q: string }) {
  return (
    <form action="/search" className="glass flex gap-2 rounded-2xl p-3">
      <input name="q" defaultValue={q} autoFocus={!q} placeholder="Contract address or DEX Screener link" className="field num h-10 flex-1 px-3 text-sm" spellCheck={false} autoComplete="off" />
      <button className="btn-primary h-10 px-4 text-sm">Look up</button>
    </form>
  );
}
