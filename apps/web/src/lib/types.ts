// Response shapes of the OUTIS RADAR API (apps/api). Kept in one place so a
// change to the API surfaces here as a type error.

export type Freshness = 'live' | 'recent' | 'stale' | 'unavailable';

export interface FeedItem {
  chain: { id: string; name: string };
  token: { address: string; symbol: string | null; name: string | null; imageUrl: string | null };
  pair: { address: string; dexId: string | null; url: string | null; quoteSymbol: string | null };
  pairCreatedAt: string | null;
  ageMinutes: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volume: { m5: number | null; h1: number | null; h24: number | null };
  priceChange: { m5: number | null; h1: number | null; h24: number | null };
  txnsH1: number | null;
  txnsH24: number | null;
  buyersH24: number | null;
  sellersH24: number | null;
  discoveryReasons: string[];
  estimatedFields: string[];
  fieldSources: Record<string, { source: string; at: string }>;
  marketUpdatedAt: string | null;
  freshness: Freshness;
  launchpad: LaunchpadTag | null;
  scores: {
    momentum: number | null;
    risk: number | null;
    riskLevel: string | null;
    riskCoverage: number | null;
    assessedAt: string | null;
    status: 'scored' | 'not_computed';
  };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Capability {
  state: 'live' | 'partial' | 'needs_config' | 'planned' | 'unavailable';
  via: string[];
  note?: string;
}

export interface ChainRow {
  id: string;
  displayName: string;
  family: string;
  priority: number;
  evmChainId?: number;
  nativeAsset: { symbol: string; decimals: number };
  tokenStandards: string[];
  providers: string[];
  rpcEnvVar: string;
  rpcConfigured: boolean;
  explorer?: { name: string; baseUrl: string };
  capabilities: Record<'discovery' | 'marketData' | 'metadata' | 'holders' | 'walletActivity' | 'riskChecks', Capability>;
  notes: string[];
  scanned: boolean;
  status: 'live' | 'partial' | 'unavailable' | 'awaiting_config' | 'disabled';
  statusReason: string;
  trackedTokens: number;
  lastMarketUpdate: string | null;
  providerHealth?: never;
}

export interface ProviderHealthRow {
  provider: string;
  scope: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  requestsTotal: number;
  errorsTotal: number;
  rateLimitedTotal: number;
  updatedAt: string;
}

export interface ScanRun {
  id: string;
  job: string;
  trigger: string;
  status: 'running' | 'ok' | 'partial' | 'failed' | 'skipped';
  chains: string[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  stats: {
    durationMs?: number;
    checked?: number;
    notIndexed?: number;
    errors?: string[];
    stoppedEarly?: string | null;
    chains?: Record<
      string,
      {
        newPools: number;
        listingTokens: number;
        refreshed: number;
        providerErrors: string[];
        persist: { pairsCreated: number; pairsUpdated: number; skippedBelowFloor: number; failed: number };
      }
    >;
  } | null;
}

export interface Overview {
  chains: Array<{ chainId: string; tokens: number; newLastHour: number; newLast24h: number }>;
  lastScan: ScanRun | null;
  scansLast24h: Record<string, number>;
}

export type CheckStatus = 'flagged' | 'passed' | 'not_checked' | 'not_applicable' | 'error';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CheckResult {
  checkId: string;
  category: string;
  status: CheckStatus;
  severity: Severity;
  confidence: 'low' | 'medium' | 'high';
  title: string;
  explanation: string;
  evidence: Record<string, unknown> | null;
  source: string;
  observedAt: string;
}

export interface RiskSummary {
  score: number;
  level: string;
  incomplete: boolean;
  coverage: number;
  checksRun: number;
  checksApplicable: number;
  categories: Record<string, { score: number; flagged: number; run: number; applicable: number }>;
  flagged: Array<{ checkId: string; points: number }>;
}

export interface MomentumDetail {
  score: number;
  weightCoverage: number;
  adjustments: string[];
  factors: Array<{ key: string; value: number | null; weight: number; contribution: number; explanation: string }>;
}

export interface TokenDetail {
  chain: { id: string; name: string; family: string };
  risk: {
    score: number | null;
    level: string | null;
    coverage: number | null;
    assessedAt: string | null;
    contractCheckedAt: string | null;
    contractNextCheckAt: string | null;
    detail: { summary: RiskSummary; results: CheckResult[] } | null;
    history: Array<{ score: number; level: string; coverage: number; flaggedChecks: string[]; momentumScore: number | null; computedAt: string }>;
  };
  momentum: { score: number | null; detail: MomentumDetail | null; computedAt: string | null };
  launchpad: LaunchpadTag | null;
  token: {
    id: string;
    address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    imageUrl: string | null;
    firstSeenAt: string;
    firstSeenSource: string;
    metadataSource: string | null;
    metadataUpdatedAt: string | null;
    explorerUrl: string | null;
  };
  pairs: Array<FeedItem & { isPrimary: boolean }>;
  history: Array<{
    observedAt: string;
    source: string;
    priceUsd: number | null;
    liquidityUsd: number | null;
    volumeH1: number | null;
    txnsH1: number | null;
    buyersH1: number | null;
  }>;
  historyWindowHours: number;
}

export interface CheckSpec {
  id: string;
  category: string;
  title: string;
  description: string;
  families: string[];
  source: string;
  plannedReason?: string;
}

export interface ScoringConfigResponse {
  effective: {
    momentum: {
      weights: Record<string, number>;
      minWeightCoverage: number;
      strongAt: number;
      minStrongFactors: number;
      singleSignalCap: number;
      idealAgeMinutes: { from: number; to: number };
      maxAgeMinutes: number;
    };
    risk: {
      severityPoints: Record<Severity, number>;
      confidenceMultiplier: Record<'low' | 'medium' | 'high', number>;
      criticalFloor: number;
      minCoverage: number;
      levels: { caution: number; high: number; severe: number };
    };
  };
  stored: { updatedAt: string; valid: boolean } | null;
}

export interface WalletSupportRow {
  chainId: string;
  name: string;
  family: string;
  state: 'live' | 'needs_config' | 'unavailable';
  source: string | null;
  userConfigured: boolean;
  note: string;
}

export interface WalletRow {
  id: string;
  chainId: string;
  chainName: string;
  address: string;
  label: string | null;
  note: string | null;
  createdAt: string;
  trackedFrom: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  source: string | null;
  transfers: number;
  lastActivityAt: string | null;
}

export interface TradeEvent {
  txHash: string;
  at: string;
  side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  qty: number;
  quote: number | null;
  unit: 'native' | 'usd' | null;
  price: number | null;
  note?: string;
}

export interface WalletPosition {
  tokenAddress: string;
  symbol: string | null;
  unit: 'native' | 'usd' | null;
  netQty: number;
  boughtQty: number;
  soldQty: number;
  avgEntry: number | null;
  openCost: number | null;
  realized: number | null;
  firstEntryAt: string | null;
  lastActivityAt: string;
  events: TradeEvent[];
  complete: boolean;
  issues: string[];
  token: { symbol: string | null; name: string | null; imageUrl: string | null; riskScore: number | null; riskLevel: string | null; tracked: boolean };
  priceInUnit: number | null;
  priceSource: string | null;
  value: number | null;
  unrealized: number | null;
  usd: { value: number | null; unrealized: number | null; realized: number | null; nativeUsd: number | null };
  entryMinutesAfterLaunch: number | null;
}

export interface WalletReport {
  wallet: WalletRow & { syncCursor: unknown };
  chain: { id: string; name: string; family: string } | null;
  positions: WalletPosition[];
  flows: Array<{ tokenAddress: string; symbol: string; unit: 'native' | 'usd'; received: number; sent: number; transfers: number }>;
  summary: {
    positions: number;
    open: number;
    completePositions: number;
    realizedNative: number;
    realizedUsdStable: number;
    unrealizedKnownNative: number;
    winRate: number | null;
    closedWithKnownPnl: number;
    earlyEntries: number;
    nativeSymbol: string;
    nativeUsd: number | null;
  };
  transfers: Array<{ id: string; txHash: string; blockTime: string; tokenAddress: string; symbol: string | null; direction: string; amount: number; counterparty: string | null; source: string }>;
  connections: Array<{ kind: 'deployer' | 'co_entry' | 'direct_transfer'; text: string; evidence: Record<string, unknown> }>;
}

export interface WatchlistItemRow {
  id: string;
  watchlistId: string;
  kind: 'token' | 'wallet';
  chainId: string;
  chainName: string;
  address: string;
  note: string | null;
  addedAt: string;
  token: { symbol: string | null; name: string | null; imageUrl: string | null; riskScore: number | null; riskLevel: string | null; riskCoverage: number | null; momentumScore: number | null; priceUsd: number | null; priceChangeH1: number | null; priceChangeH24: number | null; liquidityUsd: number | null; marketUpdatedAt: string | null } | null;
  wallet: { id: string; label: string | null; lastSyncAt: string | null; lastSyncStatus: string | null } | null;
}

export interface WatchlistRow {
  id: string;
  name: string;
  items: WatchlistItemRow[];
}

export interface StatsT {
  n: number;
  winRate: number | null;
  meanPct: number | null;
  medianPct: number | null;
  expectancyPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
}

export interface PerformanceReport {
  horizon: string;
  minMeaningfulSample: number;
  firstSignalAt: string | null;
  horizons: Array<{ key: string; minutes: number }>;
  rules: Array<{
    id: string;
    label: string;
    description: string;
    signals: number;
    byHorizon: Record<string, { observed: StatsT; pessimistic: StatsT; noData: number; pending: number; collapsed: number }>;
    breakdown: Record<'chain' | 'launchpad' | 'age' | 'momentum' | 'risk', Array<{ bucket: string; stats: StatsT }>>;
    avgMfePct: number | null;
    avgMaePct: number | null;
  }>;
  recent: Array<{ id: string; rule: string; chainId: string; tokenId: string; address: string | null; symbol: string | null; firedAt: string; momentumScore: number | null; riskScore: number | null; entryPrice: number | null; outcomes: Record<string, { status: string; netReturnPct: number | null }> | null; status: string }>;
}

export interface PaperTradeRow {
  id: string;
  tokenId: string;
  address: string | null;
  chainId: string;
  symbol: string | null;
  sizeUsd: number;
  feeBps: number;
  slippageBps: number;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxHoldMinutes: number | null;
  openedAt: string;
  entryPrice: number;
  entryObservedAt: string;
  entryImpactPct: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlUsd: number | null;
  returnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  note: string | null;
  mark: { priceUsd: number | null; valueUsd: number; returnPct: number | null; stale: boolean } | null;
}

export interface PaperReport {
  config: { startingBalanceUsd: number; defaultSizeUsd: number; feeBps: number; slippageBps: number };
  state: { cashUsd: number; openValueUsd: number; equityUsd: number; realizedUsd: number; openTrades: number };
  closedStats: StatsT;
  byChain: Array<{ chainId: string; stats: StatsT }>;
  byExitReason: Array<{ reason: string; count: number }>;
  maxDrawdownPct: number;
  curve: Array<{ at: string; equityUsd: number }>;
  trades: PaperTradeRow[];
}

export interface LaunchpadTag {
  id: string;
  name: string;
  stage: 'curve' | 'graduated' | 'launched' | null;
  evidence: 'dex' | 'address' | null;
  graduatedAt: string | null;
}
