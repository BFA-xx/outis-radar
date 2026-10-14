/**
 * Chain registry.
 *
 * Every network OUTIS RADAR knows about is declared here, once, with what it
 * can and cannot do. Nothing else in the codebase hard-codes a chain: the
 * worker scans whatever is enabled here, the API serves this list, and the
 * dashboard renders capability states straight from it.
 *
 * Rules this file follows:
 *  - No invented infrastructure. RPC endpoints are never written here; each
 *    chain names the env var that would hold one, and stays "awaiting config"
 *    for anything that needs it until that var is set.
 *  - Provider ids are the ids those providers actually use (checked against
 *    GeckoTerminal /networks and DEX Screener search results, 2026-10-11).
 *  - Capability states describe what THIS codebase implements, not what the
 *    chain could support in theory. "planned" means not built yet.
 */

export type ChainFamily = 'evm' | 'solana' | 'tron' | 'sui' | 'ton';

/** Static implementation state of one capability on one chain. */
export type CapabilityState =
  /** Implemented and backed by a working public source. */
  | 'live'
  /** Implemented, but with known gaps (documented in `note`). */
  | 'partial'
  /** Implemented but needs configuration (an env var) before it can run. */
  | 'needs_config'
  /** Designed for, not built yet. */
  | 'planned'
  /** No reliable data source exists for this on this chain. */
  | 'unavailable';

export interface Capability {
  state: CapabilityState;
  /** Source ids that back this capability, e.g. ["geckoterminal", "dexscreener"]. */
  via: string[];
  note?: string;
}

export type CapabilityKey =
  | 'discovery'
  | 'marketData'
  | 'metadata'
  | 'holders'
  | 'walletActivity'
  | 'riskChecks';

export interface ChainSpec {
  /** Our stable slug. Used in URLs and the database. */
  id: string;
  displayName: string;
  family: ChainFamily;
  priority: 1 | 2 | 3;
  /** EIP-155 chain id, EVM only. Omitted where we have not verified it. */
  evmChainId?: number;
  nativeAsset: { symbol: string; decimals: number };
  tokenStandards: string[];
  /** The ids external providers use for this chain. Absent = provider doesn't cover it. */
  providerIds: {
    dexscreener?: string;
    geckoterminal?: string;
  };
  /** Name of the env var holding this chain's RPC URL. Never a URL. */
  rpcEnvVar: string;
  /**
   * Wrapped-native and major stablecoin addresses (normalized). A pair whose
   * BASE side is one of these is oriented backwards for discovery purposes —
   * WETH is not a new token. Only well-known canonical deployments are listed.
   */
  quoteAssets?: string[];
  explorer?: {
    name: string;
    baseUrl: string;
    tokenPath: (address: string) => string;
    addressPath: (address: string) => string;
    txPath: (hash: string) => string;
  };
  capabilities: Record<CapabilityKey, Capability>;
  /** Scanned by the worker unless SCAN_CHAINS overrides. */
  discoveryEnabledByDefault: boolean;
  notes?: string[];
}

const etherscanStyle = (name: string, baseUrl: string): ChainSpec['explorer'] => ({
  name,
  baseUrl,
  tokenPath: (a) => `/token/${a}`,
  addressPath: (a) => `/address/${a}`,
  txPath: (h) => `/tx/${h}`,
});

/** Discovery + market data are provider-backed and identical across EVM chains. */
const evmMarketCaps = (
  providers: Array<'geckoterminal' | 'dexscreener'>,
): Pick<Record<CapabilityKey, Capability>, 'discovery' | 'marketData' | 'metadata'> => ({
  discovery: {
    state: providers.includes('geckoterminal') ? 'live' : 'partial',
    via: providers,
    note: providers.includes('geckoterminal')
      ? undefined
      : 'No new-pool feed; only tokens surfaced by DEX Screener profiles/boosts are discovered.',
  },
  marketData: { state: 'live', via: providers },
  metadata: {
    state: 'partial',
    via: providers,
    note: 'Name/symbol/decimals from market providers; on-chain verification needs an RPC (planned).',
  },
});

const notYet = (note: string): Capability => ({ state: 'planned', via: [], note });

const EVM_PENDING = {
  holders: notYet('Holder distribution needs an indexer; planned for Milestone 4.'),
  walletActivity: notYet('Wallet tracking is Milestone 4.'),
  riskChecks: notYet('Contract risk checks are Milestone 3.'),
};

export const CHAINS: readonly ChainSpec[] = [
  // ── Priority 1 ──────────────────────────────────────────────────────────
  {
    id: 'solana',
    displayName: 'Solana',
    family: 'solana',
    priority: 1,
    nativeAsset: { symbol: 'SOL', decimals: 9 },
    tokenStandards: ['SPL Token', 'Token-2022'],
    providerIds: { dexscreener: 'solana', geckoterminal: 'solana' },
    rpcEnvVar: 'RPC_URL_SOLANA',
    quoteAssets: [
      'So11111111111111111111111111111111111111112', // wSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ],
    explorer: {
      name: 'Solscan',
      baseUrl: 'https://solscan.io',
      tokenPath: (a) => `/token/${a}`,
      addressPath: (a) => `/account/${a}`,
      txPath: (h) => `/tx/${h}`,
    },
    capabilities: {
      discovery: { state: 'live', via: ['geckoterminal', 'dexscreener'] },
      marketData: {
        state: 'live',
        via: ['geckoterminal', 'dexscreener'],
        note: 'DEX Screener reports no liquidity for pump.fun bonding-curve pairs; shown as unknown, not zero.',
      },
      metadata: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      holders: notYet('Needs a Solana RPC (getTokenLargestAccounts) — Milestone 3/4.'),
      walletActivity: notYet('Wallet tracking is Milestone 4.'),
      riskChecks: notYet('Mint/freeze authority checks are Milestone 3 — SPL semantics, not EVM.'),
    },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'base',
    displayName: 'Base',
    family: 'evm',
    priority: 1,
    evmChainId: 8453,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'base', geckoterminal: 'base' },
    rpcEnvVar: 'RPC_URL_BASE',
    quoteAssets: [
      '0x4200000000000000000000000000000000000006', // WETH
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    ],
    explorer: etherscanStyle('BaseScan', 'https://basescan.org'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'ethereum',
    displayName: 'Ethereum',
    family: 'evm',
    priority: 1,
    evmChainId: 1,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'ethereum', geckoterminal: 'eth' },
    rpcEnvVar: 'RPC_URL_ETHEREUM',
    quoteAssets: [
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    ],
    explorer: etherscanStyle('Etherscan', 'https://etherscan.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'bsc',
    displayName: 'BNB Smart Chain',
    family: 'evm',
    priority: 1,
    evmChainId: 56,
    nativeAsset: { symbol: 'BNB', decimals: 18 },
    tokenStandards: ['BEP-20 (ERC-20)'],
    providerIds: { dexscreener: 'bsc', geckoterminal: 'bsc' },
    rpcEnvVar: 'RPC_URL_BSC',
    quoteAssets: [
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
      '0x55d398326f99059ff775485246999027b3197955', // USDT (BSC-USD)
    ],
    explorer: etherscanStyle('BscScan', 'https://bscscan.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'arbitrum',
    displayName: 'Arbitrum One',
    family: 'evm',
    priority: 1,
    evmChainId: 42161,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'arbitrum', geckoterminal: 'arbitrum' },
    rpcEnvVar: 'RPC_URL_ARBITRUM',
    quoteAssets: [
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    ],
    explorer: etherscanStyle('Arbiscan', 'https://arbiscan.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'robinhood',
    displayName: 'Robinhood Chain',
    family: 'evm',
    priority: 1,
    evmChainId: 4663,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'robinhood', geckoterminal: 'robinhood' },
    rpcEnvVar: 'RPC_URL_ROBINHOOD',
    explorer: etherscanStyle('Blockscout', 'https://robinhoodchain.blockscout.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
    notes: [
      'Both providers list Robinhood Chain pairs as of 2026-10-11; coverage is thinner than on Base.',
      'Public Alchemy endpoints for this chain have a 10k-block eth_getLogs cap on free plans.',
    ],
  },
  // ── Priority 2 ──────────────────────────────────────────────────────────
  {
    id: 'optimism',
    displayName: 'Optimism',
    family: 'evm',
    priority: 2,
    evmChainId: 10,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'optimism', geckoterminal: 'optimism' },
    rpcEnvVar: 'RPC_URL_OPTIMISM',
    explorer: etherscanStyle('Optimistic Etherscan', 'https://optimistic.etherscan.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'polygon',
    displayName: 'Polygon PoS',
    family: 'evm',
    priority: 2,
    evmChainId: 137,
    nativeAsset: { symbol: 'POL', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'polygon', geckoterminal: 'polygon_pos' },
    rpcEnvVar: 'RPC_URL_POLYGON',
    explorer: etherscanStyle('PolygonScan', 'https://polygonscan.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'avalanche',
    displayName: 'Avalanche C-Chain',
    family: 'evm',
    priority: 2,
    evmChainId: 43114,
    nativeAsset: { symbol: 'AVAX', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'avalanche', geckoterminal: 'avax' },
    rpcEnvVar: 'RPC_URL_AVALANCHE',
    explorer: etherscanStyle('Snowtrace', 'https://snowtrace.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'blast',
    displayName: 'Blast',
    family: 'evm',
    priority: 2,
    evmChainId: 81457,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'blast', geckoterminal: 'blast' },
    rpcEnvVar: 'RPC_URL_BLAST',
    explorer: etherscanStyle('Blastscan', 'https://blastscan.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'linea',
    displayName: 'Linea',
    family: 'evm',
    priority: 2,
    evmChainId: 59144,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'linea', geckoterminal: 'linea' },
    rpcEnvVar: 'RPC_URL_LINEA',
    explorer: etherscanStyle('LineaScan', 'https://lineascan.build'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'scroll',
    displayName: 'Scroll',
    family: 'evm',
    priority: 2,
    evmChainId: 534352,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'scroll', geckoterminal: 'scroll' },
    rpcEnvVar: 'RPC_URL_SCROLL',
    explorer: etherscanStyle('Scrollscan', 'https://scrollscan.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'zora',
    displayName: 'Zora',
    family: 'evm',
    priority: 2,
    evmChainId: 7777777,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'zora', geckoterminal: 'zora-network' },
    rpcEnvVar: 'RPC_URL_ZORA',
    explorer: etherscanStyle('Zora Explorer', 'https://explorer.zora.energy'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  // ── Priority 2 (added 2026-10-11; provider ids verified against both APIs) ──
  {
    id: 'tron',
    displayName: 'Tron',
    family: 'tron',
    priority: 2,
    nativeAsset: { symbol: 'TRX', decimals: 6 },
    tokenStandards: ['TRC-20'],
    providerIds: { dexscreener: 'tron', geckoterminal: 'tron' },
    rpcEnvVar: 'RPC_URL_TRON',
    explorer: {
      name: 'Tronscan',
      baseUrl: 'https://tronscan.org',
      tokenPath: (a) => `/#/token20/${a}`,
      addressPath: (a) => `/#/address/${a}`,
      txPath: (h) => `/#/transaction/${h}`,
    },
    capabilities: {
      discovery: { state: 'live', via: ['geckoterminal', 'dexscreener'] },
      marketData: { state: 'live', via: ['geckoterminal', 'dexscreener'] },
      metadata: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      holders: notYet('Needs a Tron indexer (TronGrid).'),
      walletActivity: notYet('Not designed yet for Tron.'),
      riskChecks: notYet('TVM is EVM-like but addresses/tooling differ; checks need TronGrid.'),
    },
    discoveryEnabledByDefault: true,
    notes: ['Addresses are base58 (T…) and case-sensitive; stored exactly as given.'],
  },
  {
    id: 'sonic',
    displayName: 'Sonic',
    family: 'evm',
    priority: 2,
    evmChainId: 146,
    nativeAsset: { symbol: 'S', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'sonic', geckoterminal: 'sonic' },
    rpcEnvVar: 'RPC_URL_SONIC',
    explorer: etherscanStyle('SonicScan', 'https://sonicscan.org'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'hyperevm',
    displayName: 'HyperEVM',
    family: 'evm',
    priority: 2,
    evmChainId: 999,
    nativeAsset: { symbol: 'HYPE', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'hyperevm', geckoterminal: 'hyperevm' },
    rpcEnvVar: 'RPC_URL_HYPEREVM',
    explorer: etherscanStyle('HyperEVMScan', 'https://hyperevmscan.io'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
  },
  {
    id: 'abstract',
    displayName: 'Abstract',
    family: 'evm',
    priority: 2,
    evmChainId: 2741,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'abstract', geckoterminal: 'abstract' },
    rpcEnvVar: 'RPC_URL_ABSTRACT',
    explorer: etherscanStyle('Abscan', 'https://abscan.org'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
    notes: ['ZK Stack chain: contract checks must not assume standard EVM bytecode tooling.'],
  },
  {
    id: 'unichain',
    displayName: 'Unichain',
    family: 'evm',
    priority: 2,
    evmChainId: 130,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'unichain', geckoterminal: 'unichain' },
    rpcEnvVar: 'RPC_URL_UNICHAIN',
    explorer: etherscanStyle('Uniscan', 'https://uniscan.xyz'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
    notes: ['Many pools are Uniswap v4: the pair "address" is a 32-byte pool id, not a contract.'],
  },
  {
    id: 'monad',
    displayName: 'Monad',
    family: 'evm',
    priority: 2,
    evmChainId: 143,
    nativeAsset: { symbol: 'MON', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'monad', geckoterminal: 'monad' },
    rpcEnvVar: 'RPC_URL_MONAD',
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: true,
    notes: ['Chain id 143 per GoPlus /supported_chains (2026-10-11); explorer not yet verified.', 'Many pools are Uniswap v4 32-byte pool ids.'],
  },
  {
    id: 'mantle',
    displayName: 'Mantle',
    family: 'evm',
    priority: 2,
    evmChainId: 5000,
    nativeAsset: { symbol: 'MNT', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'mantle', geckoterminal: 'mantle' },
    rpcEnvVar: 'RPC_URL_MANTLE',
    explorer: etherscanStyle('Mantlescan', 'https://mantlescan.xyz'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'ink',
    displayName: 'Ink',
    family: 'evm',
    priority: 2,
    evmChainId: 57073,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'ink', geckoterminal: 'ink' },
    rpcEnvVar: 'RPC_URL_INK',
    explorer: etherscanStyle('Ink Explorer', 'https://explorer.inkonchain.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
    notes: ['Many pools are Uniswap v4 32-byte pool ids.'],
  },
  {
    id: 'berachain',
    displayName: 'Berachain',
    family: 'evm',
    priority: 2,
    evmChainId: 80094,
    nativeAsset: { symbol: 'BERA', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'berachain', geckoterminal: 'berachain' },
    rpcEnvVar: 'RPC_URL_BERACHAIN',
    explorer: etherscanStyle('Berascan', 'https://berascan.com'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'worldchain',
    displayName: 'World Chain',
    family: 'evm',
    priority: 2,
    evmChainId: 480,
    nativeAsset: { symbol: 'ETH', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'worldchain', geckoterminal: 'world-chain' },
    rpcEnvVar: 'RPC_URL_WORLDCHAIN',
    explorer: etherscanStyle('Worldscan', 'https://worldscan.org'),
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'plasma',
    displayName: 'Plasma',
    family: 'evm',
    priority: 2,
    evmChainId: 9745,
    nativeAsset: { symbol: 'XPL', decimals: 18 },
    tokenStandards: ['ERC-20'],
    providerIds: { dexscreener: 'plasma', geckoterminal: 'plasma' },
    rpcEnvVar: 'RPC_URL_PLASMA',
    capabilities: { ...evmMarketCaps(['geckoterminal', 'dexscreener']), ...EVM_PENDING },
    discoveryEnabledByDefault: false,
    notes: ['GeckoTerminal new-pool feed was empty on 2026-10-11; discovery relies on DEX Screener listings.', 'Chain id 9745 per GoPlus /supported_chains (2026-10-11).'],
  },
  // ── Priority 3 ──────────────────────────────────────────────────────────
  {
    id: 'sui',
    displayName: 'Sui',
    family: 'sui',
    priority: 3,
    nativeAsset: { symbol: 'SUI', decimals: 9 },
    tokenStandards: ['Sui Coin'],
    providerIds: { dexscreener: 'sui', geckoterminal: 'sui-network' },
    rpcEnvVar: 'RPC_URL_SUI',
    explorer: {
      name: 'Suiscan',
      baseUrl: 'https://suiscan.xyz/mainnet',
      tokenPath: (a) => `/coin/${a}`,
      addressPath: (a) => `/account/${a}`,
      txPath: (h) => `/tx/${h}`,
    },
    capabilities: {
      discovery: {
        state: 'partial',
        via: ['geckoterminal', 'dexscreener'],
        note: 'Coin type ids (0x…::module::NAME) normalized as-is; not yet scanned by default.',
      },
      marketData: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      metadata: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      holders: notYet('Needs a Sui indexer.'),
      walletActivity: notYet('Not designed yet for Sui.'),
      riskChecks: notYet('Move package upgrade-cap and treasury-cap checks; not EVM semantics.'),
    },
    discoveryEnabledByDefault: false,
  },
  {
    id: 'ton',
    displayName: 'TON',
    family: 'ton',
    priority: 3,
    nativeAsset: { symbol: 'TON', decimals: 9 },
    tokenStandards: ['Jetton (TEP-74)'],
    providerIds: { dexscreener: 'ton', geckoterminal: 'ton' },
    rpcEnvVar: 'RPC_URL_TON',
    explorer: {
      name: 'Tonviewer',
      baseUrl: 'https://tonviewer.com',
      tokenPath: (a) => `/${a}`,
      addressPath: (a) => `/${a}`,
      txPath: (h) => `/transaction/${h}`,
    },
    capabilities: {
      discovery: {
        state: 'partial',
        via: ['geckoterminal', 'dexscreener'],
        note: 'TON addresses have several encodings; providers are trusted as-is, not re-normalized yet.',
      },
      marketData: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      metadata: { state: 'partial', via: ['geckoterminal', 'dexscreener'] },
      holders: notYet('Needs a TON indexer (e.g. toncenter v3).'),
      walletActivity: notYet('Not designed yet for TON.'),
      riskChecks: notYet('Jetton admin/mintable checks; not EVM semantics.'),
    },
    discoveryEnabledByDefault: false,
  },
];

const BY_ID = new Map(CHAINS.map((c) => [c.id, c]));

export function getChain(id: string): ChainSpec | undefined {
  return BY_ID.get(id);
}

export function requireChain(id: string): ChainSpec {
  const chain = BY_ID.get(id);
  if (!chain) throw new Error(`Unknown chain "${id}"`);
  return chain;
}

/** Reverse lookup: the provider's chain id → our chain. */
export function chainByProviderId(
  provider: keyof ChainSpec['providerIds'],
  providerChainId: string,
): ChainSpec | undefined {
  return CHAINS.find((c) => c.providerIds[provider] === providerChainId);
}

/**
 * Normalize an address for storage and deduplication.
 *
 * EVM addresses are case-insensitive hex, so they are lowercased — otherwise
 * the same token arrives checksummed from one provider and lowercase from the
 * other and is stored twice. Solana (base58), Sui coin types and TON addresses
 * are case-SENSITIVE and are kept exactly as given.
 */
export function normalizeAddress(chain: ChainSpec, address: string): string {
  const trimmed = address.trim();
  return chain.family === 'evm' ? trimmed.toLowerCase() : trimmed;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SUI_COIN_TYPE = /^0x[0-9a-fA-F]{1,64}(::[A-Za-z_][A-Za-z0-9_]*){2}$/;
const SUI_OBJECT = /^0x[0-9a-fA-F]{1,64}$/;
const TON_RAW = /^-?\d+:[0-9a-fA-F]{64}$/;
const TON_FRIENDLY = /^[A-Za-z0-9_-]{48}$/;

/** Shape check only — it does not prove the account exists. */
export function isPlausibleAddress(chain: ChainSpec, address: string): boolean {
  switch (chain.family) {
    case 'evm':
      return EVM_ADDRESS.test(address);
    case 'solana':
      return BASE58.test(address);
    case 'tron':
      return TRON.test(address);
    case 'sui':
      return SUI_COIN_TYPE.test(address) || SUI_OBJECT.test(address);
    case 'ton':
      return TON_RAW.test(address) || TON_FRIENDLY.test(address);
  }
}

export function explorerUrl(
  chain: ChainSpec,
  kind: 'token' | 'address' | 'tx',
  value: string,
): string | undefined {
  if (!chain.explorer) return undefined;
  const path =
    kind === 'token'
      ? chain.explorer.tokenPath(value)
      : kind === 'address'
        ? chain.explorer.addressPath(value)
        : chain.explorer.txPath(value);
  return chain.explorer.baseUrl + path;
}

/** Serializable view of a chain (functions stripped) for the API and the web app. */
export interface ChainSummary {
  id: string;
  displayName: string;
  family: ChainFamily;
  priority: 1 | 2 | 3;
  evmChainId?: number;
  nativeAsset: { symbol: string; decimals: number };
  tokenStandards: string[];
  providers: string[];
  rpcEnvVar: string;
  explorer?: { name: string; baseUrl: string };
  capabilities: Record<CapabilityKey, Capability>;
  discoveryEnabledByDefault: boolean;
  notes: string[];
}

export function summarizeChain(chain: ChainSpec): ChainSummary {
  return {
    id: chain.id,
    displayName: chain.displayName,
    family: chain.family,
    priority: chain.priority,
    evmChainId: chain.evmChainId,
    nativeAsset: chain.nativeAsset,
    tokenStandards: chain.tokenStandards,
    providers: Object.keys(chain.providerIds),
    rpcEnvVar: chain.rpcEnvVar,
    explorer: chain.explorer ? { name: chain.explorer.name, baseUrl: chain.explorer.baseUrl } : undefined,
    capabilities: chain.capabilities,
    discoveryEnabledByDefault: chain.discoveryEnabledByDefault,
    notes: chain.notes ?? [],
  };
}
