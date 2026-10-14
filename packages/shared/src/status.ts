import type { ChainSpec } from './chains';

/** Overall operational state of a chain, computed at runtime. */
export type ChainStatus = 'live' | 'partial' | 'unavailable' | 'awaiting_config' | 'disabled';

export interface ProviderHealthLike {
  provider: string;
  chainId: string | null;
  lastSuccessAt: Date | string | null;
  lastErrorAt: Date | string | null;
  consecutiveFailures: number;
}

/**
 * A chain is only "live" if it is being scanned AND a provider has answered for
 * it recently. Declaring a capability in the registry is not enough — that is
 * how dashboards end up showing a green dot over a dead feed.
 */
export function computeChainStatus(
  chain: ChainSpec,
  opts: {
    scanned: boolean;
    health: ProviderHealthLike[];
    now?: Date;
    /** A successful provider call older than this no longer counts. */
    staleAfterMs?: number;
  },
): { status: ChainStatus; reason: string } {
  const now = opts.now ?? new Date();
  const staleAfter = opts.staleAfterMs ?? 2 * 60 * 60_000;
  const discovery = chain.capabilities.discovery.state;

  if (discovery === 'planned' || discovery === 'unavailable') {
    return { status: 'unavailable', reason: chain.capabilities.discovery.note ?? 'No discovery source.' };
  }
  if (!opts.scanned) {
    return { status: 'disabled', reason: 'Not in SCAN_CHAINS — no data is being collected.' };
  }

  const relevant = opts.health.filter((h) => h.chainId === chain.id);
  const fresh = relevant.filter(
    (h) => h.lastSuccessAt && now.getTime() - new Date(h.lastSuccessAt).getTime() <= staleAfter,
  );
  if (relevant.length === 0) {
    return { status: 'unavailable', reason: 'Enabled, but no scan has reached a provider yet.' };
  }
  if (fresh.length === 0) {
    return { status: 'unavailable', reason: 'No provider has answered for this chain in the last 2 hours.' };
  }
  const failing = relevant.filter((h) => h.consecutiveFailures > 0);
  if (failing.length > 0 || discovery === 'partial') {
    return {
      status: 'partial',
      reason:
        failing.length > 0
          ? `Failing provider(s): ${failing.map((f) => f.provider).join(', ')}.`
          : (chain.capabilities.discovery.note ?? 'Partial discovery coverage.'),
    };
  }
  return { status: 'live', reason: `Fresh data from ${fresh.map((f) => f.provider).join(' + ')}.` };
}
