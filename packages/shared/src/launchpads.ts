/**
 * Launchpad registry: which platform a token was launched from, and whether it
 * has graduated from the launchpad's bonding curve onto an open DEX pool.
 *
 * Evidence, strongest first:
 *  - `dex`: one of the token's pools sits on the launchpad's own venue. The ids
 *    are the providers' own: GeckoTerminal's `/networks/{n}/dexes` listing
 *    (checked 2026-10-14) and the dexIds DEX Screener returned for pairs we
 *    stored (pumpfun, meteoradbc, pons-v2, flapsh, ...).
 *  - `address`: vanity suffixes the launchpad stamps on every token it creates,
 *    taken only from what our own stored tokens show (810 of 810 pump.fun-venue
 *    Solana mints end in "pump"; 464 of 471 four.meme tokens in "ffff", the
 *    rest in "4444"; the flap.sh token in "7777"). Shown as "inferred".
 *
 * A token with no evidence has `launchpad: null` — "not from a known
 * launchpad", never "definitely not a launchpad token".
 */

export interface LaunchpadSpec {
  id: string;
  name: string;
  chains: readonly string[];
  /** Venue ids where the token trades while still on the launchpad. */
  venueDexIds: readonly string[];
  /**
   * Venue ids a graduated token moves to. Empty = the launchpad has no
   * graduation step we can observe (Zora, Virtuals, ...), so stage stays "launched".
   * A prefix ending in "*" matches any dex id starting with it.
   */
  graduatedDexIds: readonly string[];
  /** Lower-case address suffixes this launchpad stamps on its tokens. */
  addressSuffixes?: readonly string[];
}

export const LAUNCHPADS: readonly LaunchpadSpec[] = [
  { id: 'pumpfun', name: 'pump.fun', chains: ['solana'], venueDexIds: ['pump-fun', 'pumpfun'], graduatedDexIds: ['pumpswap'], addressSuffixes: ['pump'] },
  { id: 'letsbonk', name: 'LetsBonk', chains: ['solana'], venueDexIds: ['letsbonk-fun'], graduatedDexIds: [] },
  { id: 'launchlab', name: 'Raydium LaunchLab', chains: ['solana'], venueDexIds: ['raydium-launchlab', 'launchlab'], graduatedDexIds: ['raydium*'] },
  { id: 'meteora-dbc', name: 'Meteora DBC', chains: ['solana'], venueDexIds: ['meteora-dbc', 'meteoradbc'], graduatedDexIds: ['meteora-damm*', 'meteora'] },
  { id: 'bags', name: 'Bags', chains: ['solana'], venueDexIds: ['bags-fm'], graduatedDexIds: [] },
  { id: 'moonit', name: 'Moonit', chains: ['solana'], venueDexIds: ['moonit', 'moonshot'], graduatedDexIds: [] },
  { id: 'boop', name: 'Boop', chains: ['solana'], venueDexIds: ['boop-fun'], graduatedDexIds: [] },
  { id: 'heaven', name: 'Heaven', chains: ['solana'], venueDexIds: ['heaven'], graduatedDexIds: [] },
  { id: 'stonkfun', name: 'StonkFun', chains: ['solana'], venueDexIds: ['stonkfun'], graduatedDexIds: [] },
  { id: 'daosfun', name: 'Daos.fun', chains: ['solana'], venueDexIds: ['daos-fun'], graduatedDexIds: [] },
  { id: 'fourmeme', name: 'four.meme', chains: ['bsc'], venueDexIds: ['four-meme'], graduatedDexIds: ['pancakeswap*'], addressSuffixes: ['ffff', '4444'] },
  { id: 'flap', name: 'flap.sh', chains: ['bsc'], venueDexIds: ['flapsh', 'flap-sh'], graduatedDexIds: ['pancakeswap*'], addressSuffixes: ['7777'] },
  { id: 'zora', name: 'Zora', chains: ['base'], venueDexIds: ['zora'], graduatedDexIds: [] },
  { id: 'bankr', name: 'Bankr', chains: ['base'], venueDexIds: ['bankr'], graduatedDexIds: [] },
  { id: 'virtuals', name: 'Virtuals', chains: ['base', 'solana', 'robinhood'], venueDexIds: ['virtuals-base', 'virtuals-unicorn-base', 'virtuals-solana', 'virtuals-robinhood', 'virtuals'], graduatedDexIds: [] },
  { id: 'pons', name: 'Pons', chains: ['robinhood'], venueDexIds: ['pons-v2', 'pons'], graduatedDexIds: [] },
];

export type LaunchpadStage = 'curve' | 'graduated' | 'launched';

export interface LaunchpadInfo {
  launchpad: string;
  stage: LaunchpadStage;
  evidence: 'dex' | 'address';
}

export function getLaunchpad(id: string | null | undefined): LaunchpadSpec | undefined {
  return id ? LAUNCHPADS.find((l) => l.id === id) : undefined;
}

const matches = (ids: readonly string[], dexId: string) => ids.some((x) => (x.endsWith('*') ? dexId.startsWith(x.slice(0, -1)) : dexId === x));

/** Launchpad whose own venue this dex id is, if any. */
export function launchpadForDex(chainId: string, dexId: string | null | undefined): LaunchpadSpec | undefined {
  if (!dexId) return undefined;
  const d = dexId.toLowerCase();
  return LAUNCHPADS.find((l) => l.chains.includes(chainId) && matches(l.venueDexIds, d));
}

/**
 * Classify a token from every pool we know for it.
 *
 * Graduated = launchpad origin is known AND the token now has a pool on the
 * launchpad's graduation venue. Launchpads without an observable graduation
 * step report "launched".
 */
export function classifyLaunchpad(chainId: string, tokenAddress: string, dexIds: Array<string | null | undefined>): LaunchpadInfo | null {
  const ids = dexIds.filter((d): d is string => Boolean(d)).map((d) => d.toLowerCase());
  let spec: LaunchpadSpec | undefined;
  let evidence: LaunchpadInfo['evidence'] = 'dex';
  for (const d of ids) {
    spec = launchpadForDex(chainId, d);
    if (spec) break;
  }
  if (!spec) {
    const addr = tokenAddress.toLowerCase();
    spec = LAUNCHPADS.find((l) => l.chains.includes(chainId) && l.addressSuffixes?.some((s) => addr.endsWith(s)));
    evidence = 'address';
  }
  if (!spec) return null;
  if (spec.graduatedDexIds.length === 0) return { launchpad: spec.id, stage: 'launched', evidence };
  const graduated = ids.some((d) => matches(spec.graduatedDexIds, d));
  // Address-only evidence without a graduation pool tells us nothing about the stage.
  if (!graduated && evidence === 'address') return { launchpad: spec.id, stage: 'launched', evidence };
  return { launchpad: spec.id, stage: graduated ? 'graduated' : 'curve', evidence };
}
