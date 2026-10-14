import type { ChainSpec, WalletSource } from '@outis/shared';
import type { FetchLike, Sleep } from '../http';
import type { HealthRecorder } from '../providers/types';

export const NATIVE = 'native';

/** One movement into or out of the wallet, as reconstructed by a provider. */
export interface RawTransfer {
  txHash: string;
  /** EVM log index; -1 for a native-coin leg; 0 for Solana per-tx deltas. */
  logIndex: number;
  blockNumber: number | null;
  blockTime: Date;
  /** Normalized token address, or "native". */
  tokenAddress: string;
  symbol: string | null;
  direction: 'in' | 'out';
  /** Integer amount in base units, as a decimal string. */
  amountRaw: string;
  decimals: number | null;
  counterparty: string | null;
}

export interface SyncBudget {
  /** Hard stop for this wallet. */
  deadline: number;
  /** First sync: how far back to look. */
  backfillHours: number;
  /** Most transactions to fetch individually in one run (Solana, native legs). */
  maxTxFetches: number;
}

export interface SyncContext {
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  signal?: AbortSignal;
  health: HealthRecorder;
  /** Known decimals for tokens already in our DB (saves RPC calls). */
  knownDecimals: (tokenAddress: string) => number | null;
}

export interface SyncResult {
  transfers: RawTransfer[];
  cursor: Record<string, unknown>;
  /** True when the provider reached the present; false means more to fetch next run. */
  complete: boolean;
  /** Human-readable caveats about this sync (gaps, unknown legs). */
  notes: string[];
}

export interface WalletProvider {
  sync(chain: ChainSpec, address: string, source: WalletSource, cursor: Record<string, unknown> | null, budget: SyncBudget, ctx: SyncContext): Promise<SyncResult>;
}

export function toAmount(raw: string, decimals: number | null): number {
  if (decimals === null) return Number(raw);
  // Float precision is fine for display and PnL ratios; amountRaw keeps the exact value.
  const neg = raw.startsWith('-');
  const digits = neg ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const v = Number(`${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`);
  return neg ? -v : v;
}

/** Lower-case EVM address from a 32-byte topic. */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function addressToTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}
