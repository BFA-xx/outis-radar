# OUTIS RADAR — implementation log

Updated 2026-10-14 (Milestones 1–5, 7).

## Starting state

The brief described an existing scaffold (`apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/shared`).
The directory was **empty**, so the monorepo was built from scratch to that layout, plus `packages/engine` to keep
ingestion/normalization/persistence separate from the API and worker.

Also found: `~/.git` exists (a repository rooted at the home directory, no commits, untracking `~/.aws`,
`~/.claude.json` …). This project has its own `git init`, so nothing here commits into it — but a stray
`git add -A` run anywhere else in the home directory would stage credentials. Consider removing `~/.git`
if it was not intentional.

## Architecture decisions

**Scheduled, DB-backed jobs instead of BullMQ (for now).** The workload is one periodic, bounded scan. A queue
would add Redis (Upstash free tier caps at 10k commands/day; BullMQ's polling alone eats a large share) and buy
nothing yet. Instead:
- `JobLease` row → only one scan at a time, across GitHub Actions *and* a local worker. A row rather than a
  Postgres advisory lock, because advisory locks bind to one connection and Supabase's pooler does not keep one.
- Leases expire, so a killed runner never blocks the next run.
- Every write is idempotent (upserts; one snapshot per pair/source/minute), so retries never duplicate.
- A wall-clock deadline is checked between steps; the scan always finalizes its `ScanRun` and releases its lease.
- The refresh step takes the least-recently-*attempted* pairs, so consecutive runs walk the whole tracked set
  without an offset cursor, and pairs no provider answers for cannot starve the queue.

Revisit BullMQ when there are many independent job types or per-token fan-out (wallet tracking, alerts).

**Provider-independent model.** Providers only produce `PairObservation`s. Merging is per field, by provider
priority, with each field's winning source recorded. A field missing in a later refresh carries forward with its
*original* timestamp, and is dropped after 6 hours rather than shown as fresh.

**Status is computed, not declared.** A chain is `live` only if it is scanned and a provider answered for it in the
last 2 hours; `partial` if a provider is failing; `disabled` if not scanned; `unavailable` otherwise.

## Measured provider limits (2026-10-11)

| Provider | Documented | Observed | We run at |
|---|---|---|---|
| GeckoTerminal | 30/min | 429s from ~11/min within 30s | 6/min; a 429 pauses the provider 60s |
| DEX Screener listings | 60/min | no 429s seen | 50/min |
| DEX Screener tokens/pairs | 300/min | no 429s seen | 240/min |
| GoPlus Security (keyless) | — | ~9 calls in a burst, then code 4029 **inside an HTTP 200** | 8/min; 4029 pauses 60s |

GoPlus free tier answers **one token per call** (a 25-address batch returned one result). Fresh tokens are often
not indexed yet (empty result) or partially indexed (code 3: holders but no contract scan).

GeckoTerminal is the bottleneck: a scan costs ~1 call per chain (+1 extra page per priority-1 chain).
15 chains ≈ 20 calls ≈ 3.5 minutes.

## Chains

Scanned by default (15): Solana, Base, Ethereum, BNB Smart Chain, Arbitrum One, Optimism, Polygon PoS,
Avalanche C-Chain, Tron, Sonic, HyperEVM, Abstract, Unichain, Monad, Robinhood Chain.
Registered but off (enable via `SCAN_CHAINS`): Blast, Linea, Scroll, Zora, Mantle, Ink, Berachain, World Chain,
Plasma, Sui, TON.

Provider ids for every chain were checked against both APIs. EVM chain ids for Monad and Plasma are left unset
until verified. Tron is its own family (base58, case-sensitive addresses).

## Checklist

### Milestone 1 — scaffold, Prisma, discovery ✅
- [x] npm-workspaces monorepo; TypeScript 5.9, strict
- [x] Prisma 6 schema + initial migration (Prisma's npm `latest` tag is an 8.0 release candidate — avoided)
- [x] Chain registry with per-capability states, provider ids, RPC env-var names (no URLs)
- [x] GeckoTerminal + DEX Screener adapters: zod-validated, malformed items skipped and counted
- [x] Rate limiting, timeouts, retries with backoff, Retry-After, abort on shutdown
- [x] Merge/dedup by (chain, normalized address); EVM lowercased, Solana/Tron case preserved
- [x] Wrapped-native/stable "base" pairs skipped (WETH is not a new token) on P1 chains
- [x] Bounded scan with lease, checkpoints, deadline, graceful SIGTERM; live-verified

### Milestone 2 — persistence + dashboard ✅
- [x] Tokens, pairs (latest state + per-field source/time), per-source snapshots, provider health, scan runs
- [x] Primary pair per token (most liquid) → one feed row per token
- [x] NestJS API: `/tokens`, `/tokens/:chain/:address`, `/chains`, `/providers/health`, `/scans`, `/overview`, `/health`
- [x] zod validation → structured 400s; global error filter (no stack traces out); throttling; CORS; request timeouts
- [x] Dashboard: Overview, Discovery (search/filter/sort/paginate), Token detail (history), Chains, Health
- [x] Freshness badges; estimates marked `~`; source on hover; unknown shown as `—`; scores read "not computed"
- [x] Unbuilt pages shown in nav as disabled with their milestone — no placeholder data anywhere

### Milestone 3 — risk engine + scoring ✅
- [x] Check catalog (26 checks) per chain family — EVM/Tron contract checks never run on Solana and vice versa
- [x] EVM/Tron via GoPlus: honeypot, taxes, mint, ownership, pause/blacklist, proxy, unverified source, deployer
      honeypot history, holder concentration (EOAs, pools/burn/locked excluded), deployer allocation, LP control
- [x] Solana via GoPlus: mint authority, freeze authority, Token-2022 (fee, hook, permanent delegate,
      non-transferable, frozen-by-default), mutable metadata
- [x] Market-derived, every scan: liquidity depth, liquidity removal (from snapshots), implausible liquidity,
      phantom liquidity, no-sells, wash-trading ratio, parabolic move, stale data, missing fields
- [x] Every result: status, severity, confidence, explanation, evidence, source, observation time
- [x] "Not checked" is its own status, shown separately and excluded from "passed"; coverage shown with every
      score; under 60% coverage the level is marked incomplete (`?` in the feed)
- [x] Risk score 0–100: 100·(1−Π(1−pᵢ/100)), pᵢ = severity points × confidence; critical high-confidence floor
- [x] Momentum score, separate from risk: 8 explained factors, unknown factors dropped (not zeroed),
      coverage damping, single-signal cap counting activity factors only
- [x] Weights/thresholds editable without code: `PUT /scoring/config` (zod-validated, admin token), `POST /scoring/rescore`
- [x] Risk job runs separately (own lease, own provider budget): never-checked first, newest first; answered →
      recheck 12h, not indexed → retry 20 min, unsupported chain → parked 7 days
- [x] Assessment history row only when the verdict changes (or every 6h) — kept small for a free-tier DB
- [x] Dashboard: score columns + sort/filter, risk breakdown by category with evidence, momentum factor bars,
      Scoring page (weights in effect + check catalog)
- [x] Calibrated on live data (see "Calibration" below)
- [ ] Bundled/coordinated buying and linked wallets — catalogued, reported as not checked (needs Milestone 4 data)
- [ ] Solana holder concentration — GoPlus returns no holders for Solana; needs an RPC + pool-vault resolution
- [ ] HyperEVM / Zora / Sui / TON contract checks — no free source covers them; reported as not checked

### Milestone 4 — wallet intelligence + watchlists ✅
- [x] Wallet sources verified live 2026-10-14 (see table below); per-chain resolution in `packages/shared/src/wallets.ts`
- [x] Solana: per-transaction net token + SOL deltas from the official public RPC — exact cost basis for swaps
- [x] EVM: wallet-wide `Transfer` logs (adaptive ranges, JSON-RPC batching), ETH paid with buys from `tx.value`
- [x] Newest-first sync with explicit "still to fetch" ranges — recent trades appear first, nothing skipped silently
- [x] Positions + PnL (average cost) in the unit actually paid; incomplete positions say why
- [x] Money in/out panel (native, wrapped native, stablecoins)
- [x] Entry timing (T+ minutes after pair creation), early-entry count, win rate over known closed positions
- [x] Evidence-backed connections only: deployer (GoPlus creator record), co-entries (≤ 10 min), direct transfers
- [x] Tokens a tracked wallet trades enter discovery (`wallet_activity`) → names, prices, risk, valuations
- [x] Watchlists for tokens and wallets with live price/momentum/risk; "+ Watch" on every token page
- [x] Dashboard writes via server actions; admin token stays server-side; off unless `DASHBOARD_WRITES=1`
- [x] Wallet sync job (`wallets`) in the worker: leased, bounded, least-recently-synced first
- [ ] Wallet activity alerts → Milestone 5 (Telegram)
- [ ] Bundled-buy / linked-wallet risk checks: the wallet graph exists now; feeding it into per-token risk is next
- [ ] Wallet tracking on Tron, Sui, TON (not built)

#### Wallet data sources (verified 2026-10-14)

| Chain | Source | Notes |
|---|---|---|
| Solana | official public RPC | exact deltas; slow — set `RPC_URL_SOLANA` to speed up |
| Arbitrum, Optimism, Avalanche | official public RPC | wallet-wide logs allowed; Arbitrum sends `blockTimestamp: 0x0` in logs (handled) |
| Ethereum, Unichain, Ink | Blockscout API (keyless) | |
| Base, BSC, Robinhood, Polygon, others | **your RPC needed** | Base's public RPC: "request limit reached"; BSC: "limit exceeded"; PublicNode needs a contract address; the Base/Arbitrum/Polygon/Robinhood Blockscouts sit behind a Cloudflare challenge |

Known limits: ETH received from a sell arrives as an internal transfer (needs tracing) → sell proceeds paid in ETH
are unknown on EVM; positions bought before tracking started show as incomplete; first sync looks back
`WALLET_BACKFILL_HOURS` (72h). Very active wallets (thousands of transfers/day) take several runs to backfill.

### Milestone 5 — Telegram alerts ✅
- [x] `apps/bot` (grammY 1.46, long polling — no webhook or public URL needed); part of `npm start`
- [x] Default-deny access: `TELEGRAM_ALLOWED_USER_IDS`; unknown users get only their own id; private chats only
- [x] Commands: /start /help /prefs (with on/off buttons) /set /chains /watch /unwatch /wallets /status /pause /resume /test
- [x] Alert kinds: new tokens (your filters), risk escalations (watched or previously announced tokens),
      tracked-wallet trades, watchlist price moves
- [x] Strict defaults: liquidity ≥ $20K, 24h volume ≥ $10K, age ≤ 6h, momentum ≥ 60, risk ≤ 44, ≥ 60% of risk checks run
- [x] Outbox table: unique dedup key per alert per chat → idempotent generation; overlapping windows are safe
- [x] Cooldowns: watch moves once per token/direction per 2h; risk once per level reached; wallet history from
      before tracking never alerts; first run looks back 15 min only
- [x] Hourly cap per chat, shared fairly (risk first, then wallet/watch/discovery take turns); overflow → one summary
- [x] Busy wallets (> 3 trades in a run) → one digest
- [x] Delivery: ~1 msg/s per chat, Telegram retry-after honoured, blocked chats paused, 3 attempts then failed
- [x] Token never logged; message text HTML-escaped; dashboard Alerts page shows everything incl. held-back alerts
- [x] Previewed on live data (temporary subscriber, removed): digest, watchlist drop, new-token alerts all correct

### Milestone 7 — paper trading + signal evaluation ✅
- [x] Every signal recorded automatically, at assessment time, with the scores it had then (no look-ahead):
      three rules side by side — `strict` (alert defaults), `momentum` (ignores risk: the control group),
      `low_risk` (ignores momentum) — one signal per rule per token
- [x] Entry = first price observed ≥ 1 min AFTER the signal (in practice the next scan, ~10 min)
- [x] Outcomes at +15m / +1h / +4h / +24h, net of fee + slippage + constant-product price impact ($100 position)
- [x] Liquidity collapse (< 10% of entry liquidity) = −100%; "no data" kept separate AND folded into a
      pessimistic expectancy as −100% (survivorship bias); n < 30 flagged as noise
- [x] MFE / MAE over the first 24h; breakdowns by chain, pair age, momentum and risk bucket
- [x] Paper trades from any token page: size, take-profit, stop-loss, max hold; refused on prices > 30 min old
      or without enough paper cash; stops fill at the OBSERVED price after a gap, not the stop level
- [x] Portfolio: cash, mark-to-market net of exit costs, realized P&L, equity curve, max drawdown, win rate,
      expectancy, by chain, by exit reason
- [x] `evaluate` job in the worker (DB-only); refresh step prioritises pairs with open signals/trades
- [x] No real trading, no keys, no signing — by design
- [ ] Results need time: +24h outcomes complete a day after each signal; meaningful samples take days

### Launchpads + charts (2026-10-14)

- [x] Launchpad registry (`packages/shared/src/launchpads.ts`): pump.fun, LetsBonk, Raydium LaunchLab, Meteora
      DBC, Bags, Moonit, Boop, Heaven, StonkFun, Daos.fun, four.meme, flap.sh, Zora, Bankr, Virtuals, Pons.
      Venue ids verified against GeckoTerminal's `/dexes` listing and the dexIds DEX Screener returned for our
      own stored pairs; vanity suffixes only where our data shows them (pump 810/810, four.meme ffff/4444, flap 7777)
- [x] Every token tagged: launchpad, stage (curve / graduated / launched), evidence (dex / address), graduatedAt
      (the graduation pool's creation time, else first seen). No evidence = null, shown as "none known"
- [x] Discovery filters: launchpad (or "any"), stage; sort by graduation time; badges on feed and token page
- [x] Launchpads page: per-launchpad new / graduated in 24h (our sample, labelled as such), recent graduates
- [x] Telegram: "Launchpad graduations" alert kind (fresh ≤ 2h, liquidity floor, known-risk ceiling; unassessed
      risk is sent but labelled), `/launchpads` to pick which, `/set gradliq|gradrisk`
- [x] Measured, not assumed: a 4th signal rule "Launchpad graduates" (graduated ≤ 60 min, liq ≥ $5K, no score
      filter) and a by-launchpad breakdown on Performance
- [x] Token page: live DEX Screener / GeckoTerminal chart embed (their data, their renderer), our own
      observations kept separately below
- [ ] Clanker (Base) tokens trade on plain Uniswap v4 pools, so they are not tagged yet; clanker.world has a
      public token API that could fill this in
- [ ] "A launchpad's own official token" (e.g. a platform launching its coin) is not detected — that needs a
      curated list; ask before building it

### Milestone 8 — deploy, sign-in, monitoring (2026-10-14)

- [x] Dashboard sign-in: one password (`DASHBOARD_PASSWORD`), HMAC-signed 14-day HttpOnly cookie, middleware on
      every page and server action, fixed delay per attempt, safe `?next=`. Deployed without a password → locked
- [x] API read token (`API_READ_TOKEN`, `x-api-token`) on every endpoint but `/health` and the Telegram webhook;
      deployed without one → 503. Admin token still separate for writes
- [x] API as a Vercel function (`apps/api/api/index.js` + `vercel.json`), same Nest app as local
      (`app.factory.ts`); exercised locally through the function handler
- [x] Telegram: webhook endpoint (secret-verified, always 200), `bot --once` for scheduled delivery,
      `--set-webhook` / `--delete-webhook`; local polling refuses to steal a deployed webhook
- [x] GitHub Actions: discovery · risk · followups (wallets → evaluate → alerts) every 15 min with a cost
      table; `db-migrate` workflow; CI builds the bot
- [x] Monitoring: Settings page (secrets present/missing — never values, last good run per job, alert counts);
      one "scans have stopped" Telegram warning per stall
- [x] `npm run secrets` prints fresh values locally; `docs/DEPLOY.md` is the step-by-step
- [x] Token cleanup for the 500 MB free database: tokens first seen > 14 days ago (`TOKEN_RETENTION_DAYS`)
      with no market update for 7 days are deleted with their pairs/snapshots/assessments — never one that is
      watched, signalled, paper-traded or in a tracked wallet's transfers. ≤ 2,000 per scan
- [ ] Not deployed yet — needs your Supabase / Vercel / GitHub accounts (docs/DEPLOY.md)

### Milestone 6 — more chains

## Calibration (2026-10-11, live data)

The first version of momentum ranked junk near the top. Fixed and covered by tests:
- **QTC (Ethereum):** $1.07B "liquidity" on a 30-minute-old pair with $25K volume scored momentum 71, risk 0.
  New `liq.implausible` check (liquidity > 3× FDV, or ≥ $5M on a < 24h pair with < 1% turnover); distrusted
  liquidity scores 0 in momentum. Now momentum 32, risk 28.
- **Dacity copies:** +262% "1h change" with zero trades in the hour. A price change with no trades is ignored.
- A risk score resting on few checks counted as a strong signal. Risk now only enters momentum at sufficient
  coverage, and only activity factors count toward the strong-signal threshold.
- Caught live: **URSLIQ (Ethereum)** — liquidity $4.9K → $0, price −99.5% in 70 min, deployer holding 100%:
  risk 84 / severe at 86% coverage.

## Known limitations

- **Solana coverage is a sample.** GeckoTerminal's newest 40 pools per scan ≪ pump.fun's launch rate. Full
  coverage needs a Solana RPC/indexer subscription (Milestone 3–4; e.g. a Helius free tier — to be evaluated).
- No holder, deployer or wallet data yet (needs RPC/indexers).
- Provider "liquidity" on concentrated-liquidity/v4 pools is the provider's valuation, not usable depth
  (partly mitigated by `liq.phantom` / `liq.implausible`).
- Holder concentration counts exchange hot wallets as holders (GoPlus does not label them), which over-flags
  mature tokens like PEPE. Labelling is Milestone 4 work.
- GoPlus is a third-party simulation: a "passed" honeypot check means GoPlus found no restriction, not that one
  cannot exist (e.g. owner-toggleable later). Confidence is "medium" for that reason.
- Many tokens show `?` (incomplete) until the risk job reaches them: ~30 contract checks per run.
- The pair "address" for Uniswap v4 pools is a 32-byte pool id, not a contract.
- Wrapped-native detection only covers chains with `quoteAssets` set (P1 chains).
- `npm audit`: 5 findings remain, all in dev/build tooling (Prisma CLI's deepmerge-ts; Next's bundled postcss).
  None ships in the API or worker runtime path.

## What you need to set up

**Deploying:** follow [DEPLOY.md](DEPLOY.md) — it supersedes points 1–3 below.

1. **Database (hosted):** create a free Supabase project → Project Settings → Database. Put the transaction-pooler
   URL (append `?pgbouncer=true&connection_limit=1`) in `DATABASE_URL` and the session/direct URL in `DIRECT_URL`,
   in your host's env settings — not in chat, not in git. Then run `npm run db:deploy` once with those set.
2. **Scheduled scans:** add `DATABASE_URL` and `DIRECT_URL` as GitHub Actions secrets. Read the cost note in
   `.github/workflows/scan.yml` first: unlimited minutes only if the repo is public.
3. **Dashboard on Vercel:** root directory `apps/web`; set `API_URL` to wherever the API runs. The NestJS API
   needs a Node host; this is open — options are a small always-on host, or moving the read endpoints into
   Next.js route handlers. Decide before Milestone 8.
4. **Admin token (optional):** to change scoring weights, set `ADMIN_TOKEN` on the API (`openssl rand -hex 24`) in
   the host's env settings. Without it, the API stays read-only. A local one is already in your `.env`.
5. **Wallets on Base, BSC, Robinhood, Polygon:** set `RPC_URL_BASE` / `RPC_URL_BSC` / `RPC_URL_ROBINHOOD` /
   `RPC_URL_POLYGON` in `.env` (free Alchemy or QuickNode keys work). Solana, Arbitrum, Optimism, Avalanche,
   Ethereum, Unichain and Ink work with no key.
6. **Telegram alerts:** message @BotFather → /newbot → put the token in `.env` as `TELEGRAM_BOT_TOKEN`
   (use a NEW bot — not the Mintooor one; two programs polling one bot break each other). `npm start`, send
   /start to your bot, copy the id it replies with into `TELEGRAM_ALLOWED_USER_IDS`, restart, /start again.
7. **No API keys are required** for M1–M3: GeckoTerminal, DEX Screener and GoPlus are used keyless.
