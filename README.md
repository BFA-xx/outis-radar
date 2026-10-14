# OUTIS RADAR

Multi-chain early-token discovery, wallet intelligence and risk research.
Research data only. Nothing here is a recommendation, and no score means a token is safe.

**Status:** Milestones 1–5, 7 and 8 done: real discovery on 15 chains with launchpad tagging (pump.fun,
four.meme, Pons, …) and graduation alerts, a transparent risk engine (26 checks), an explainable momentum
ranking, wallet tracking with reconstructed PnL, watchlists, Telegram alerts, paper trading with look-ahead-free
signal evaluation, and a password-protected free-tier deployment path. Deploying: [docs/DEPLOY.md](docs/DEPLOY.md).
Progress and the checklist live in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Quick start (already set up on this Mac)

```bash
cd "/Users/adebayodaniel/Outis Radar" && npm start
```

Open http://localhost:3000. That one command runs the API, the dashboard, a scan every 10 minutes and —
once `TELEGRAM_BOT_TOKEN` is set — the Telegram bot.
Ctrl-C stops everything. The setup steps further down are only needed on a new machine.

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | Chain registry (`chains.ts`), provider-independent market types, query schemas |
| `packages/db` | Prisma schema, migrations, client |
| `packages/engine` | Providers → normalization → merge/dedup → persistence; job lease; the bounded scan |
| `apps/worker` | CLI that runs one scan (cron/GitHub Actions) or loops (local) |
| `apps/bot` | Telegram bot: polling locally; webhook + `--once` delivery when deployed |
| `apps/api` | NestJS API for the dashboard; also a Vercel function (`api/index.js`) |
| `apps/web` | Next.js dashboard |

## Local setup

Needs Node ≥ 22.9 and PostgreSQL 16 (Homebrew: `brew install postgresql@16 && brew services start postgresql@16`).

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`: replace `USER` in the three database URLs with your Postgres user (`whoami` on a Homebrew install). Then:

```bash
createdb outis_radar && createdb outis_radar_test
```

```bash
npm run build:packages
```

```bash
npm run db:deploy
```

```bash
npm run test:db && npm test
```

Run both jobs once (≈4 min; discovery and risk checks run in parallel, each inside its own provider's limits):

```bash
npm run build -w @outis/worker && npm run scan
```

Or one job: `npm run scan -- discovery` / `risk` / `wallets`.

Start the API and dashboard (two terminals):

```bash
npm run build -w @outis/api && npm run start -w @outis/api
```

```bash
npm run dev:web
```

Open http://localhost:3000. To keep data flowing locally:

```bash
npm run scan -- all --loop 600
```

## Data sources

All free and keyless:

- **GeckoTerminal** — new-pool feed per chain; the only source with distinct buyers/sellers. ~6 req/min in practice.
- **DEX Screener** — profile/boost/takeover listings, batched market refresh. 60–300 req/min.
- **GoPlus Security** — contract, holder and LP checks (EVM, Tron, Solana). ~8 req/min, one token per call.

Every stored value carries its source and observation time; `null` means "not reported", never zero.
Paid DEX Screener boosts are recorded as a discovery reason and flagged in the UI — not treated as quality.

## Secrets

Note: `npm run build -w @outis/web` and `npm run dev:web` share `apps/web/.next`; stop the dev server before a
production build, or clear `.next` and restart it afterwards.

Never commit `.env`. In hosting, set variables in the provider's settings (Vercel → Project → Environment
Variables; GitHub → Settings → Secrets and variables → Actions). Logs redact database passwords, bot tokens and
API keys in URLs.
