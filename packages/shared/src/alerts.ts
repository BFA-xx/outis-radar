/**
 * Alert preferences and the pure matching rules behind each alert kind.
 *
 * Defaults are deliberately strict: a new subscriber should get a handful of
 * meaningful alerts a day, not a firehose of fresh pump.fun launches.
 */
import { z } from 'zod';
import { CHAINS } from './chains';
import { LAUNCHPADS } from './launchpads';

/**
 * alpha     — the calls: alpha score ≥ minScore, clean contract, one per token
 * sweep     — an hourly digest of "watch"-tier tokens (close, not yet a call)
 * followup  — replies under a call when it hits 2×/5×/10×, or when it rugs
 * recap     — once a day: every call of the last 24h and how it did
 * discovery / launchpad — the raw feeds (every new token / every graduation); off by default
 */
export const ALERT_KINDS = ['alpha', 'sweep', 'followup', 'recap', 'risk', 'wallet', 'watch', 'discovery', 'launchpad'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const alertPrefsSchema = z.object({
  kinds: z.object({
    alpha: z.boolean(),
    sweep: z.boolean(),
    followup: z.boolean(),
    recap: z.boolean(),
    discovery: z.boolean(),
    launchpad: z.boolean(),
    risk: z.boolean(),
    wallet: z.boolean(),
    watch: z.boolean(),
  }),
  /** Empty = all scanned chains. */
  chains: z.array(z.string().refine((c) => CHAINS.some((x) => x.id === c), 'Unknown chain')).max(30),
  discovery: z.object({
    minLiquidityUsd: z.number().min(0).max(1e9),
    minVolumeH24: z.number().min(0).max(1e10),
    /** Only pairs younger than this. */
    maxAgeMinutes: z.number().int().min(5).max(7 * 24 * 60),
    minMomentum: z.number().min(0).max(100),
    /** Tokens scoring above this are not announced. */
    maxRisk: z.number().min(0).max(100),
    /** Also require at least this share of risk checks to have run. */
    minRiskCoverage: z.number().min(0).max(1),
  }),
  alpha: z.object({
    /** Calls need at least this alpha score (the engine's own bar is 70). */
    minScore: z.number().min(55).max(100),
  }),
  /** Tokens this chat never wants to hear about again (token ids). */
  mutedTokens: z.array(z.string().max(40)).max(500),
  /** Hour (UTC) the daily recap is sent. */
  recapHourUtc: z.number().int().min(0).max(23),
  /** Launchpad graduations: a token leaving its bonding curve for an open pool. */
  launchpad: z.object({
    /** Launchpad ids to alert on; empty = every known launchpad. */
    ids: z.array(z.string().refine((id) => LAUNCHPADS.some((l) => l.id === id), 'Unknown launchpad')).max(40),
    minLiquidityUsd: z.number().min(0).max(1e9),
    /** Skip tokens whose risk is already known to be above this. Unassessed tokens are still sent, labelled as such. */
    maxRisk: z.number().min(0).max(100),
  }),
  watch: z.object({
    /** Alert when a watched token moves this much in 1h (either way). */
    priceMovePct: z.number().min(1).max(10_000),
  }),
  wallet: z.object({
    /** Ignore wallet trades smaller than this (in the chain's native coin, or USD for stablecoin trades). */
    minNative: z.number().min(0),
    minUsd: z.number().min(0),
  }),
  /** Max alerts sent to this chat per hour; the rest are summarized. */
  maxPerHour: z.number().int().min(1).max(200),
});

export type AlertPrefs = z.infer<typeof alertPrefsSchema>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  kinds: { alpha: true, sweep: true, followup: true, recap: true, discovery: false, launchpad: false, risk: true, wallet: true, watch: true },
  chains: [],
  discovery: {
    minLiquidityUsd: 20_000,
    minVolumeH24: 10_000,
    maxAgeMinutes: 6 * 60,
    minMomentum: 60,
    maxRisk: 44,
    minRiskCoverage: 0.6,
  },
  alpha: { minScore: 70 },
  mutedTokens: [],
  recapHourUtc: 7,
  launchpad: { ids: [], minLiquidityUsd: 10_000, maxRisk: 69 },
  watch: { priceMovePct: 25 },
  wallet: { minNative: 0, minUsd: 0 },
  maxPerHour: 20,
};

/** Stored prefs merged over defaults; invalid stored values fall back rather than crash the bot. */
export function readPrefs(stored: unknown): AlertPrefs {
  // Prefs saved before alpha calls existed had the raw feeds on by default;
  // upgrade them once to the new defaults (calls on, raw feeds off).
  const kinds = (stored as { kinds?: Record<string, unknown> } | null)?.kinds;
  if (kinds && !('alpha' in kinds)) stored = { ...(stored as object), kinds: { ...kinds, discovery: false, launchpad: false } };
  const merged = deepMerge(DEFAULT_ALERT_PREFS, stored);
  const parsed = alertPrefsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_ALERT_PREFS;
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export interface DiscoveryCandidate {
  chainId: string;
  liquidityUsd: number | null;
  volumeH24: number | null;
  ageMinutes: number | null;
  momentumScore: number | null;
  riskScore: number | null;
  riskCoverage: number | null;
}

/**
 * Does a newly seen token meet this subscriber's bar? Unknown values never
 * pass a threshold — a token with no liquidity figure is not "≥ $20K".
 */
export function matchesDiscovery(c: DiscoveryCandidate, p: AlertPrefs): { ok: boolean; reason: string } {
  const d = p.discovery;
  if (p.chains.length > 0 && !p.chains.includes(c.chainId)) return { ok: false, reason: 'chain not selected' };
  if (c.ageMinutes === null || c.ageMinutes > d.maxAgeMinutes) return { ok: false, reason: 'too old or age unknown' };
  if (c.liquidityUsd === null || c.liquidityUsd < d.minLiquidityUsd) return { ok: false, reason: 'liquidity below floor or unknown' };
  if (c.volumeH24 === null || c.volumeH24 < d.minVolumeH24) return { ok: false, reason: 'volume below floor or unknown' };
  if (c.momentumScore === null || c.momentumScore < d.minMomentum) return { ok: false, reason: 'momentum below floor or not scored' };
  if (c.riskScore === null || c.riskScore > d.maxRisk) return { ok: false, reason: 'risk above ceiling or not assessed' };
  if (c.riskCoverage === null || c.riskCoverage < d.minRiskCoverage) return { ok: false, reason: 'too few risk checks have run' };
  return { ok: true, reason: 'matches' };
}

export interface GraduationCandidate {
  chainId: string;
  launchpad: string | null;
  liquidityUsd: number | null;
  riskScore: number | null;
}

/**
 * Should this graduation be announced? Unknown liquidity never passes the floor;
 * unknown risk does pass (it is minutes old — checks have not run yet) and the
 * alert says so plainly instead of implying it is safe.
 */
export function matchesGraduation(c: GraduationCandidate, p: AlertPrefs): { ok: boolean; reason: string } {
  const l = p.launchpad;
  if (!c.launchpad) return { ok: false, reason: 'no known launchpad' };
  if (p.chains.length > 0 && !p.chains.includes(c.chainId)) return { ok: false, reason: 'chain not selected' };
  if (l.ids.length > 0 && !l.ids.includes(c.launchpad)) return { ok: false, reason: 'launchpad not selected' };
  if (c.liquidityUsd === null || c.liquidityUsd < l.minLiquidityUsd) return { ok: false, reason: 'liquidity below floor or unknown' };
  if (c.riskScore !== null && c.riskScore > l.maxRisk) return { ok: false, reason: 'risk above ceiling' };
  return { ok: true, reason: 'matches' };
}

/** Settable from Telegram: `/set <key> <value>`. */
export const PREF_SETTERS: Record<string, { path: [keyof AlertPrefs, string?]; label: string; parse: (v: string) => number }> = {
  minliq: { path: ['discovery', 'minLiquidityUsd'], label: 'Min liquidity (USD)', parse: Number },
  minvol: { path: ['discovery', 'minVolumeH24'], label: 'Min 24h volume (USD)', parse: Number },
  maxage: { path: ['discovery', 'maxAgeMinutes'], label: 'Max pair age (minutes)', parse: (v) => Math.round(Number(v)) },
  minmomentum: { path: ['discovery', 'minMomentum'], label: 'Min momentum (0–100)', parse: Number },
  maxrisk: { path: ['discovery', 'maxRisk'], label: 'Max risk (0–100)', parse: Number },
  coverage: { path: ['discovery', 'minRiskCoverage'], label: 'Min risk-check coverage (0–1)', parse: Number },
  minalpha: { path: ['alpha', 'minScore'], label: 'Min alpha score for calls (55–100)', parse: Number },
  recaphour: { path: ['recapHourUtc'], label: 'Daily recap hour (UTC, 0–23)', parse: (v) => Math.round(Number(v)) },
  gradliq: { path: ['launchpad', 'minLiquidityUsd'], label: 'Graduation alerts: min liquidity (USD)', parse: Number },
  gradrisk: { path: ['launchpad', 'maxRisk'], label: 'Graduation alerts: max known risk (0–100)', parse: Number },
  move: { path: ['watch', 'priceMovePct'], label: 'Watchlist move alert (% in 1h)', parse: Number },
  walletmin: { path: ['wallet', 'minNative'], label: 'Min wallet trade (native coin)', parse: Number },
  perhour: { path: ['maxPerHour'], label: 'Max alerts per hour', parse: (v) => Math.round(Number(v)) },
};

/** Apply one setter and re-validate. Returns the error message instead of throwing. */
export function applyPrefSetting(prefs: AlertPrefs, key: string, raw: string): { ok: true; prefs: AlertPrefs } | { ok: false; error: string } {
  const setter = PREF_SETTERS[key.toLowerCase()];
  if (!setter) return { ok: false, error: `Unknown setting "${key}". Options: ${Object.keys(PREF_SETTERS).join(', ')}` };
  const v = setter.parse(raw.replace(/[$,_k]/gi, (m) => (m.toLowerCase() === 'k' ? '000' : '')));
  if (!Number.isFinite(v)) return { ok: false, error: `"${raw}" is not a number.` };
  const next = structuredClone(prefs) as Record<string, unknown>;
  const [a, b] = setter.path;
  if (b) (next[a] as Record<string, unknown>)[b] = v;
  else next[a] = v;
  const parsed = alertPrefsSchema.safeParse(next);
  if (!parsed.success) return { ok: false, error: `${setter.label}: ${parsed.error.issues[0].message}` };
  return { ok: true, prefs: parsed.data };
}
