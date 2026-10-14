import Link from 'next/link';
import { getChain } from '@outis/shared';

/**
 * Live candlestick chart from DEX Screener or GeckoTerminal, embedded with
 * their public embed URLs. The data inside is theirs, rendered by them — our
 * own observations stay in the History panel below.
 */
export function ChartEmbed({ chainId, pairAddress, source, basePath }: { chainId: string; pairAddress: string; source: 'ds' | 'gt'; basePath: string }) {
  const chain = getChain(chainId);
  const ds = chain?.providerIds.dexscreener;
  const gt = chain?.providerIds.geckoterminal;
  const use = source === 'gt' && gt ? 'gt' : ds ? 'ds' : gt ? 'gt' : null;
  if (!use) return <p className="px-5 py-4 text-sm text-muted">Neither chart provider covers this chain.</p>;
  const src =
    use === 'ds'
      ? `https://dexscreener.com/${ds}/${pairAddress}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`
      : `https://www.geckoterminal.com/${gt}/pools/${pairAddress}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;
  const tab = (key: 'ds' | 'gt', label: string, ok: boolean) =>
    ok ? (
      <Link href={`${basePath}?chart=${key}`} scroll={false} className={`rounded-lg px-3 py-1 ${use === key ? 'bg-white/[0.09] text-ink' : 'text-muted hover:text-ink'}`}>
        {label}
      </Link>
    ) : null;
  return (
    <div>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2 text-xs">
        {tab('ds', 'DEX Screener', Boolean(ds))}
        {tab('gt', 'GeckoTerminal', Boolean(gt))}
        <span className="ml-auto text-faint">If the chart says “not found”, that provider has not indexed this pool — try the other.</span>
      </div>
      <iframe
        key={src}
        src={src}
        title={`${use === 'ds' ? 'DEX Screener' : 'GeckoTerminal'} chart`}
        className="block h-[460px] w-full border-0 bg-black md:h-[540px]"
        loading="lazy"
        allow="clipboard-write"
      />
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = { curve: 'on curve', graduated: 'graduated', launched: 'launched' };

export function LaunchpadBadge({ lp, compact = false }: { lp: { name: string; stage: string | null; evidence: string | null } | null; compact?: boolean }) {
  if (!lp) return null;
  const graduated = lp.stage === 'graduated';
  return (
    <span
      title={lp.evidence === 'address' ? 'Launchpad inferred from the token address pattern' : 'A pool on the launchpad’s own venue'}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ring-1 ${graduated ? 'bg-accent/10 text-accent ring-accent/25' : 'bg-white/[0.05] text-muted ring-white/10'}`}
    >
      {graduated ? '🎓' : '🚀'} {lp.name}
      {!compact && lp.stage ? <span className="text-faint">· {STAGE_LABEL[lp.stage] ?? lp.stage}</span> : null}
      {lp.evidence === 'address' ? <span className="text-faint">*</span> : null}
    </span>
  );
}
