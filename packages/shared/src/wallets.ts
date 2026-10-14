/**
 * Where wallet history comes from, per chain.
 *
 * Order of preference:
 *   1. The user's own RPC (RPC_URL_<CHAIN>) — full, wallet-wide Transfer logs.
 *   2. An official public RPC that we VERIFIED accepts wallet-wide log queries.
 *   3. A keyless Blockscout explorer API that we verified answers without a
 *      bot challenge.
 * Otherwise the chain needs configuration, and says so.
 *
 * Verified 2026-10-14 from this machine. Base's official endpoint answered
 * "request limit reached" for any log query; BSC's "limit exceeded";
 * PublicNode refuses log queries without a contract address; the Base,
 * Arbitrum, Polygon and Robinhood Blockscout instances sit behind a
 * Cloudflare challenge (we do not try to get past it).
 */
import type { ChainSpec } from './chains';

export type WalletSourceKind = 'rpc' | 'public_rpc' | 'blockscout' | 'solana_rpc';

export interface WalletSource {
  kind: WalletSourceKind;
  /** Base URL. Never logged with its query string (keys can live there). */
  url: string;
  /** True when the URL came from the user's own env var. */
  userConfigured: boolean;
  /** Logs include blockTimestamp (otherwise block headers are fetched). */
  logTimestamps?: boolean;
}

export interface WalletSupport {
  chainId: string;
  state: 'live' | 'needs_config' | 'unavailable';
  source: WalletSource | null;
  note: string;
}

/** Official public RPCs verified to answer wallet-wide eth_getLogs. */
const PUBLIC_EVM_RPC: Record<string, { url: string; logTimestamps: boolean }> = {
  arbitrum: { url: 'https://arb1.arbitrum.io/rpc', logTimestamps: true },
  optimism: { url: 'https://mainnet.optimism.io', logTimestamps: true },
  avalanche: { url: 'https://api.avax.network/ext/bc/C/rpc', logTimestamps: false },
};

/** Blockscout instances verified to answer /api/v2 without a challenge. */
const KEYLESS_BLOCKSCOUT: Record<string, string> = {
  ethereum: 'https://eth.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
  ink: 'https://explorer.inkonchain.com',
};

/** Solana's official public RPC (documented by Solana; heavily rate-limited). */
export const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export function walletSupport(chain: ChainSpec, env: Record<string, string | undefined> = process.env): WalletSupport {
  const own = env[chain.rpcEnvVar]?.trim();
  if (chain.family === 'solana') {
    return own
      ? { chainId: chain.id, state: 'live', source: { kind: 'solana_rpc', url: own, userConfigured: true }, note: 'Your Solana RPC.' }
      : {
          chainId: chain.id,
          state: 'live',
          source: { kind: 'solana_rpc', url: SOLANA_PUBLIC_RPC, userConfigured: false },
          note: 'Solana public RPC: works, but slow and rate-limited. Set RPC_URL_SOLANA for faster syncs.',
        };
  }
  if (chain.family !== 'evm') {
    return { chainId: chain.id, state: 'unavailable', source: null, note: `Wallet tracking is not built for ${chain.displayName} yet.` };
  }
  if (own) {
    return { chainId: chain.id, state: 'live', source: { kind: 'rpc', url: own, userConfigured: true, logTimestamps: false }, note: `Your RPC (${chain.rpcEnvVar}).` };
  }
  const pub = PUBLIC_EVM_RPC[chain.id];
  if (pub) {
    return {
      chainId: chain.id,
      state: 'live',
      source: { kind: 'public_rpc', url: pub.url, userConfigured: false, logTimestamps: pub.logTimestamps },
      note: 'Official public RPC. Rate-limited; set your own for faster syncs.',
    };
  }
  const bs = KEYLESS_BLOCKSCOUT[chain.id];
  if (bs) {
    return { chainId: chain.id, state: 'live', source: { kind: 'blockscout', url: bs, userConfigured: false }, note: 'Blockscout explorer API (keyless).' };
  }
  return {
    chainId: chain.id,
    state: 'needs_config',
    source: null,
    note: `No keyless source accepts wallet-wide queries on ${chain.displayName}. Set ${chain.rpcEnvVar} to an RPC URL (a free Alchemy or QuickNode key works).`,
  };
}
