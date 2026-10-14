import type { ChainSpec, PairObservation, ProviderId } from '@outis/shared';
import type { FetchLike, RequestRecord, Sleep } from '../http';

/** Per (provider, scope) counters gathered during one scan, flushed to ProviderHealth. */
export interface HealthCounter {
  /** gt, ds, goplus, or a wallet source (rpc:<chain>, blockscout, solana_rpc). */
  provider: ProviderId | (string & {});
  /** Chain id, or "*" for calls that are not chain-specific. */
  scope: string;
  requests: number;
  errors: number;
  rateLimited: number;
  lastLatencyMs: number | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  /** Did the LAST request succeed? Drives consecutiveFailures. */
  lastOk: boolean | null;
}

export class HealthRecorder {
  private readonly counters = new Map<string, HealthCounter>();

  record(provider: HealthCounter['provider'], scope: string, r: RequestRecord, now = new Date()): void {
    const key = `${provider}|${scope}`;
    let c = this.counters.get(key);
    if (!c) {
      c = {
        provider,
        scope,
        requests: 0,
        errors: 0,
        rateLimited: 0,
        lastLatencyMs: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        lastOk: null,
      };
      this.counters.set(key, c);
    }
    c.requests++;
    c.lastLatencyMs = r.latencyMs;
    c.lastOk = r.ok;
    if (r.ok) c.lastSuccessAt = now;
    else {
      c.errors++;
      c.lastErrorAt = now;
      c.lastError = r.error ?? 'error';
    }
    if (r.rateLimited) c.rateLimited++;
  }

  all(): HealthCounter[] {
    return [...this.counters.values()];
  }

  errorCount(): number {
    return this.all().reduce((n, c) => n + c.errors, 0);
  }
}

/** Result of one provider operation. Partial success is normal and reported, not thrown. */
export interface ProviderResult<T> {
  data: T;
  /** Items the provider returned that failed validation and were skipped. */
  malformed: number;
  errors: string[];
}

export interface ProviderContext {
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
  health: HealthRecorder;
  now?: () => Date;
}

export interface DiscoveredTokenRef {
  chain: ChainSpec;
  tokenAddress: string;
  reason: PairObservation['reason'];
}
