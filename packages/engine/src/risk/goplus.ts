/**
 * GoPlus Security (free, keyless) → risk check results.
 *
 * Measured 2026-10-11: one token per call on the free tier (a 25-address batch
 * returned one result), and ~9 calls in a burst before code 4029
 * "too many requests" — sent with HTTP 200, so the body code is what counts.
 *
 * GoPlus encodes booleans as "1"/"0" strings and omits fields it could not
 * determine. An omitted field is "not checked", never "passed". A token it has
 * not indexed yet comes back as an empty object.
 */
import {
  type ChainSpec,
  type CheckResult,
  type Confidence,
  type Severity,
  goplusChainId,
  notChecked,
  requireCheck,
} from '@outis/shared';
import { HttpError, RateLimiter, fetchJson } from '../http';
import type { ProviderContext } from '../providers/types';

export const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const RATE_LIMITED = 4029;

export type GoPlusRecord = Record<string, unknown>;

export type GoPlusLookup =
  | { kind: 'ok'; record: GoPlusRecord }
  | { kind: 'not_indexed' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export class GoPlusProvider {
  readonly id = 'goplus' as const;
  readonly limiter: RateLimiter;

  constructor(
    private readonly ctx: ProviderContext,
    perMinute = 8,
    private readonly baseUrl = GOPLUS_BASE,
  ) {
    this.limiter = new RateLimiter(perMinute, Date.now, ctx.sleep);
  }

  async tokenSecurity(chain: ChainSpec, address: string): Promise<GoPlusLookup> {
    const gp = goplusChainId(chain);
    if (!gp) return { kind: 'unsupported' };
    const url =
      gp === 'solana'
        ? `${this.baseUrl}/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
        : `${this.baseUrl}/token_security/${gp}?contract_addresses=${encodeURIComponent(address)}`;

    // Up to two extra attempts after an in-body rate limit; transport retries are inside fetchJson.
    for (let attempt = 0; attempt < 3; attempt++) {
      let body: unknown;
      try {
        body = await fetchJson(url, {
          limiter: this.limiter,
          fetchImpl: this.ctx.fetchImpl,
          sleep: this.ctx.sleep,
          signal: this.ctx.signal,
          retries: 2,
          rateLimitPauseMs: 60_000,
          onRequest: (r) => this.ctx.health.record('goplus', chain.id, r),
        });
      } catch (err) {
        return { kind: 'error', message: err instanceof HttpError ? err.message : String(err) };
      }
      const b = body as { code?: number; message?: string; result?: Record<string, GoPlusRecord> };
      if (b?.code === RATE_LIMITED) {
        this.ctx.health.record('goplus', chain.id, { url, status: 200, latencyMs: 0, ok: false, rateLimited: true, error: 'code 4029' });
        this.limiter.penalize(60_000);
        continue;
      }
      // 1 = full result. 2 and 3 = partial: some analyses (often the contract scan) are
      // missing; the fields that are present are still real, and the absent ones
      // become "not checked" in interpretation.
      if (b?.code !== 1 && b?.code !== 2 && b?.code !== 3) return { kind: 'error', message: `GoPlus code ${b?.code}: ${String(b?.message ?? '').slice(0, 100)}` };
      const result = b.result ?? {};
      // Keys come back lowercased for EVM; Solana/Tron keep case.
      const record = result[address] ?? result[address.toLowerCase()];
      if (!record || Object.keys(record).length === 0) return { kind: 'not_indexed' };
      return { kind: 'ok', record: b.code === 1 ? record : { ...record, __partial: b.code } };
    }
    return { kind: 'error', message: 'GoPlus rate limit persisted' };
  }
}

// ── Interpretation ────────────────────────────────────────────────────────

const flag = (v: unknown): boolean | null => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : null);
const frac = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);
const isBurn = (a: unknown) => typeof a === 'string' && BURN.has(a.toLowerCase());

const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Finding {
  severity: Severity;
  text: string;
}

/** Build one result from a list of findings: flagged at the worst severity, passed if all known and clean. */
function fromFindings(
  checkId: string,
  findings: Finding[],
  knownAny: boolean,
  okText: string,
  evidence: Record<string, unknown>,
  observedAt: Date,
  confidence: Confidence = 'medium',
): CheckResult {
  const spec = requireCheck(checkId);
  if (!knownAny) return notChecked(spec, 'GoPlus returned no data for these fields.', observedAt);
  if (findings.length === 0) {
    return { checkId, category: spec.category, status: 'passed', severity: 'info', confidence, title: spec.title, explanation: okText, evidence, source: 'goplus', observedAt };
  }
  const worst = findings.reduce((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a.severity] ? b : a));
  return {
    checkId,
    category: spec.category,
    status: 'flagged',
    severity: worst.severity,
    confidence,
    title: spec.title,
    explanation: findings.map((f) => f.text).join(' '),
    evidence,
    source: 'goplus',
    observedAt,
  };
}

const pick = (r: GoPlusRecord, keys: string[]) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));

export function evmChecksFromGoPlus(r: GoPlusRecord, pairAddresses: string[], observedAt: Date): CheckResult[] {
  const out: CheckResult[] = [];
  const pairs = new Set(pairAddresses.map((a) => a.toLowerCase()));
  for (const d of (r.dex as Array<{ pair?: string }> | undefined) ?? []) if (d.pair) pairs.add(d.pair.toLowerCase());

  // Honeypot
  {
    const hp = flag(r.is_honeypot);
    const noSell = flag(r.cannot_sell_all);
    const noBuy = flag(r.cannot_buy);
    const f: Finding[] = [];
    if (hp) f.push({ severity: 'critical', text: 'GoPlus simulation marks this token as a honeypot (it cannot be sold).' });
    if (noSell) f.push({ severity: 'high', text: 'Holders cannot sell their full balance.' });
    if (noBuy) f.push({ severity: 'medium', text: 'Buying is restricted.' });
    out.push(fromFindings('evm.honeypot', f, hp !== null || noSell !== null, 'Buy/sell simulation found no sell restriction.', pick(r, ['is_honeypot', 'cannot_sell_all', 'cannot_buy']), observedAt, hp ? 'high' : 'medium'));
  }
  // Taxes
  {
    const buy = frac(r.buy_tax);
    const sell = frac(r.sell_tax);
    const transfer = frac(r.transfer_tax);
    const modifiable = flag(r.slippage_modifiable);
    const f: Finding[] = [];
    const rate = (label: string, v: number | null) => {
      if (v === null || v <= 0) return;
      const pct = v * 100;
      f.push({ severity: pct >= 50 ? 'critical' : pct >= 10 ? 'high' : pct >= 5 ? 'medium' : 'low', text: `${label} tax ${pct.toFixed(1)}%.` });
    };
    rate('Buy', buy);
    rate('Sell', sell);
    rate('Transfer', transfer);
    if (modifiable) f.push({ severity: 'high', text: 'The owner can change the tax rate at any time.' });
    out.push(fromFindings('evm.tax', f, buy !== null || sell !== null, 'No buy/sell tax and taxes are not modifiable.', pick(r, ['buy_tax', 'sell_tax', 'transfer_tax', 'slippage_modifiable']), observedAt));
  }
  const owner = typeof r.owner_address === 'string' ? r.owner_address : null;
  const ownerActive = owner !== null && owner !== '' && !isBurn(owner);
  const reclaim = flag(r.can_take_back_ownership);
  // Mint
  {
    const mint = flag(r.is_mintable);
    const f: Finding[] = [];
    if (mint) f.push({ severity: ownerActive || reclaim ? 'high' : 'medium', text: ownerActive ? 'Supply can be minted, and the contract has an active owner.' : 'A mint function exists (owner appears renounced).' });
    out.push(fromFindings('evm.mint', f, mint !== null, 'No mint function detected.', pick(r, ['is_mintable', 'owner_address']), observedAt));
  }
  // Ownership
  {
    const hidden = flag(r.hidden_owner);
    const changeBal = flag(r.owner_change_balance);
    const f: Finding[] = [];
    if (changeBal) f.push({ severity: 'critical', text: 'The owner can change holder balances.' });
    if (hidden) f.push({ severity: 'high', text: 'A hidden owner retains control.' });
    if (reclaim) f.push({ severity: 'high', text: 'Ownership can be reclaimed after being renounced.' });
    if (ownerActive) f.push({ severity: 'low', text: `Owner ${owner} has not renounced.` });
    out.push(fromFindings('evm.ownership', f, owner !== null || hidden !== null || reclaim !== null, 'Ownership renounced; no hidden or reclaimable owner.', pick(r, ['owner_address', 'hidden_owner', 'can_take_back_ownership', 'owner_change_balance']), observedAt));
  }
  // Trading controls
  {
    const fields: Array<[string, Severity, string]> = [
      ['transfer_pausable', 'high', 'Transfers can be paused.'],
      ['is_blacklisted', 'high', 'Wallets can be blacklisted.'],
      ['personal_slippage_modifiable', 'high', 'Tax can be set per wallet.'],
      ['is_whitelisted', 'medium', 'A whitelist exists (some wallets may trade when others cannot).'],
      ['trading_cooldown', 'medium', 'Trading cooldown between transactions.'],
      ['anti_whale_modifiable', 'medium', 'Max-transaction / max-wallet limits can be changed.'],
    ];
    const f: Finding[] = [];
    let known = false;
    for (const [k, sev, text] of fields) {
      const v = flag(r[k]);
      if (v !== null) known = true;
      if (v) f.push({ severity: sev, text });
    }
    out.push(fromFindings('evm.trading_controls', f, known, 'No pause, blacklist, whitelist or adjustable limits.', pick(r, fields.map((x) => x[0])), observedAt));
  }
  // Upgradeable
  {
    const proxy = flag(r.is_proxy);
    out.push(fromFindings('evm.upgradeable', proxy ? [{ severity: 'medium', text: 'Upgradeable proxy: the logic can be replaced.' }] : [], proxy !== null, 'Not a proxy.', pick(r, ['is_proxy']), observedAt));
  }
  // Source / dangerous calls
  {
    const open = flag(r.is_open_source);
    const sd = flag(r.selfdestruct);
    const ext = flag(r.external_call);
    const f: Finding[] = [];
    if (open === false) f.push({ severity: 'high', text: 'Source code is not verified — the contract cannot be audited.' });
    if (sd) f.push({ severity: 'high', text: 'Contract can self-destruct.' });
    if (ext) f.push({ severity: 'medium', text: 'Behaviour depends on external contract calls.' });
    out.push(fromFindings('evm.source', f, open !== null, 'Verified source; no self-destruct or external calls.', pick(r, ['is_open_source', 'selfdestruct', 'external_call']), observedAt));
  }
  // Creator history
  {
    const same = flag(r.honeypot_with_same_creator);
    out.push(
      fromFindings('evm.creator_history', same ? [{ severity: 'critical', text: 'The deployer has created honeypot tokens before.' }] : [], same !== null, 'No known honeypots from this deployer.', pick(r, ['honeypot_with_same_creator', 'creator_address']), observedAt, same ? 'high' : 'medium'),
    );
  }
  // Holder concentration (EOAs only; pools, burn and locked balances excluded)
  {
    const holders = (r.holders as Array<{ address: string; percent: string; is_contract: number; is_locked: number; tag?: string }> | undefined) ?? [];
    if (holders.length === 0) {
      out.push(notChecked(requireCheck('holders.concentration'), 'GoPlus has no holder list for this token yet.', observedAt));
    } else {
      const eoa = holders.filter((h) => !pairs.has(h.address.toLowerCase()) && !isBurn(h.address) && !h.is_locked && !h.is_contract);
      const contracts = holders.filter((h) => h.is_contract && !pairs.has(h.address.toLowerCase()));
      const top10 = eoa.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100;
      const contractPct = contracts.reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100;
      const f: Finding[] = [];
      if (top10 >= 50) f.push({ severity: 'high', text: `Top wallets hold ${top10.toFixed(1)}% of supply.` });
      else if (top10 >= 30) f.push({ severity: 'medium', text: `Top wallets hold ${top10.toFixed(1)}% of supply.` });
      out.push(
        fromFindings(
          'holders.concentration',
          f,
          true,
          `Top wallets hold ${top10.toFixed(1)}% of supply.`,
          { top10Pct: Math.round(top10 * 10) / 10, otherContractsPct: Math.round(contractPct * 10) / 10, holderCount: frac(r.holder_count), sampled: holders.length, note: 'Excludes pools, burn addresses and locked balances. Exchange hot wallets are not labelled by the source and can inflate this on mature tokens. Non-pool contracts are reported separately and may also be team-controlled.' },
          observedAt,
        ),
      );
    }
  }
  // Creator / owner allocation
  {
    const creator = frac(r.creator_percent);
    const ownerPct = frac(r.owner_percent);
    const worst = Math.max(creator ?? 0, ownerPct ?? 0) * 100;
    const f: Finding[] = [];
    if (worst >= 20) f.push({ severity: 'high', text: `Deployer/owner holds ${worst.toFixed(1)}% of supply.` });
    else if (worst >= 5) f.push({ severity: 'medium', text: `Deployer/owner holds ${worst.toFixed(1)}% of supply.` });
    out.push(fromFindings('holders.creator', f, creator !== null || ownerPct !== null, `Deployer/owner holds ${worst.toFixed(1)}% of supply.`, pick(r, ['creator_address', 'creator_percent', 'owner_percent']), observedAt));
  }
  // LP control
  {
    const lp = (r.lp_holders as Array<{ address: string; percent: string; is_contract: number; is_locked: number; tag?: string }> | undefined) ?? [];
    if (lp.length === 0) {
      out.push(notChecked(requireCheck('liq.lp_control'), 'GoPlus has no LP holder data for this token.', observedAt));
    } else {
      const unlockedEoa = lp.filter((h) => !h.is_locked && !isBurn(h.address) && !h.is_contract);
      const top = unlockedEoa.reduce((m, h) => Math.max(m, (Number(h.percent) || 0) * 100), 0);
      const lockedOrBurned = lp.filter((h) => h.is_locked || isBurn(h.address)).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100;
      const f: Finding[] = [];
      if (top >= 50) f.push({ severity: 'high', text: `One wallet controls ${top.toFixed(0)}% of the liquidity, unlocked — it can be withdrawn at any time.` });
      else if (top >= 20) f.push({ severity: 'medium', text: `One wallet controls ${top.toFixed(0)}% of the liquidity, unlocked.` });
      out.push(fromFindings('liq.lp_control', f, true, `${lockedOrBurned.toFixed(0)}% of liquidity is locked or burned; no single wallet controls a large unlocked share.`, { topUnlockedWalletPct: Math.round(top), lockedOrBurnedPct: Math.round(lockedOrBurned), lpHolders: lp.length }, observedAt));
    }
  }
  return out;
}

export function solanaChecksFromGoPlus(r: GoPlusRecord, observedAt: Date): CheckResult[] {
  const auth = (v: unknown) => {
    const o = v as { status?: string; authority?: Array<{ address?: string }> } | undefined;
    return { on: flag(o?.status), who: (o?.authority ?? []).map((a) => a.address).filter(Boolean) };
  };
  const out: CheckResult[] = [];
  const mint = auth(r.mintable);
  out.push(fromFindings('sol.mint_authority', mint.on ? [{ severity: 'high', text: `Mint authority is active${mint.who.length ? ` (${mint.who.join(', ')})` : ''}; supply can grow.` }] : [], mint.on !== null, 'Mint authority revoked.', { mintable: r.mintable }, observedAt, 'high'));
  const freeze = auth(r.freezable);
  out.push(fromFindings('sol.freeze_authority', freeze.on ? [{ severity: 'high', text: `Freeze authority is active${freeze.who.length ? ` (${freeze.who.join(', ')})` : ''}; holder accounts can be frozen.` }] : [], freeze.on !== null, 'Freeze authority revoked.', { freezable: r.freezable }, observedAt, 'high'));

  const f: Finding[] = [];
  let known = false;
  const balMut = auth(r.balance_mutable_authority);
  if (balMut.on !== null) known = true;
  if (balMut.on) f.push({ severity: 'critical', text: 'A permanent delegate can move or burn any holder’s balance.' });
  const nonTransferable = flag(r.non_transferable);
  if (nonTransferable !== null) known = true;
  if (nonTransferable) f.push({ severity: 'critical', text: 'Token is non-transferable.' });
  const fee = r.transfer_fee as Record<string, unknown> | undefined;
  if (fee && Object.keys(fee).length > 0) f.push({ severity: 'medium', text: 'Token-2022 transfer fee is configured.' });
  const feeUp = auth(r.transfer_fee_upgradable);
  if (feeUp.on) f.push({ severity: 'high', text: 'Transfer fee can be changed.' });
  const hook = r.transfer_hook as unknown[] | undefined;
  if (Array.isArray(hook) && hook.length > 0) f.push({ severity: 'high', text: 'A transfer hook runs custom code on every transfer.' });
  const hookUp = auth(r.transfer_hook_upgradable);
  if (hookUp.on) f.push({ severity: 'high', text: 'Transfer hook can be changed.' });
  if (r.default_account_state === '2') f.push({ severity: 'high', text: 'New token accounts start frozen.' });
  const closable = auth(r.closable);
  if (closable.on) f.push({ severity: 'low', text: 'Mint can be closed by an authority.' });
  out.push(
    fromFindings('sol.token2022', f, known, 'No transfer fee, hook, permanent delegate or frozen-by-default accounts.', pick(r, ['transfer_fee', 'transfer_hook', 'non_transferable', 'default_account_state', 'balance_mutable_authority']), observedAt, 'high'),
  );
  const meta = auth(r.metadata_mutable);
  out.push(fromFindings('sol.metadata_mutable', meta.on ? [{ severity: 'low', text: 'Name/symbol/image can still be changed.' }] : [], meta.on !== null, 'Metadata is immutable.', { metadata_mutable: r.metadata_mutable }, observedAt));
  return out;
}
