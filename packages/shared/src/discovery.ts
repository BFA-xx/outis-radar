import { z } from 'zod';
import { CHAINS } from './chains';

/**
 * Query parameters of the discovery feed. Shared by the API (validation) and
 * the dashboard (building links), so the two can never disagree about a name.
 */
export const DISCOVERY_SORTS = [
  'pairCreatedAt',
  'liquidityUsd',
  'volumeH24',
  'volumeH1',
  'txnsH1',
  'priceChangeH1',
  'marketUpdatedAt',
  'momentumScore',
  'riskScore',
  'graduatedAt',
] as const;
export type DiscoverySort = (typeof DISCOVERY_SORTS)[number];

const optionalNumber = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.coerce.number().finite().nonnegative().optional(),
);

export const discoveryQuerySchema = z.object({
  chain: z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((id) => CHAINS.some((c) => c.id === id)), {
      message: 'Unknown chain id',
    }),
  q: z.string().trim().max(100).optional(),
  minLiquidityUsd: optionalNumber,
  minVolumeH24: optionalNumber,
  minTxnsH1: optionalNumber,
  /** Maximum pair age in hours. */
  maxAgeHours: optionalNumber,
  /** Hide tokens scoring above this risk. Unassessed tokens are hidden too when set. */
  maxRiskScore: optionalNumber,
  minMomentumScore: optionalNumber,
  /** A launchpad id, or "any" for tokens from any known launchpad. */
  launchpad: z.string().trim().max(40).optional(),
  /** Launchpad stage: curve (still on the bonding curve), graduated, launched. */
  stage: z.enum(['curve', 'graduated', 'launched']).optional(),
  /** Only pairs whose market data was refreshed within this many minutes. */
  freshWithinMinutes: optionalNumber,
  sort: z.enum(DISCOVERY_SORTS).default('pairCreatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
