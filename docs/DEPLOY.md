# Deploying OUTIS RADAR (free tier)

Everything below runs on free plans: **Supabase** (database), **Vercel** (dashboard + API), **GitHub
Actions** (the scanner's clock). No server to keep running.

```
GitHub Actions (every 15 min) ──► scans, risk checks, wallets, evaluation, Telegram alerts ──┐
                                                                                             ▼
Browser ──► Vercel: dashboard (password) ──► Vercel: API (read token) ──────────────► Supabase Postgres
Telegram ──► Vercel: API /telegram/webhook (secret) ─────────────────────────────────────────┘
```

**Secrets never go in a chat, an issue or git.** You paste them into the Vercel / GitHub / Supabase settings
pages yourself. `npm run secrets` prints fresh random values in your own terminal for that.

---

## 1. Put the code on GitHub

Create a repository and push this folder (ask Claude to commit and push it for you).

> **Private or public?** GitHub Actions minutes are unlimited only for **public** repos. A private repo gets
> 2,000 free minutes a month, and the 15-minute schedule needs ~55,000. If you keep it private, change the
> `cron` in `.github/workflows/scan.yml` to every 6 hours (`0 */6 * * *`), or keep scanning from this Mac
> with `npm start`, which writes to the same database. No secrets are in the code, so public is safe.

## 2. Database — Supabase

1. supabase.com → New project. Choose a strong database password and keep it in your password manager.
2. Project → **Connect** → copy two connection strings, filling in the password:
   - **Transaction pooler** (port 6543) → add `?pgbouncer=true&connection_limit=1` → this is `DATABASE_URL`
   - **Session pooler** (port 5432) → this is `DIRECT_URL`
3. Create the tables: put both lines in this Mac's `.env` temporarily *or* (simpler) do step 5 first and run
   GitHub → Actions → **db-migrate** → Run workflow.

## 3. Make your secrets

```bash
npm run secrets
```

Keep that terminal open; you'll paste from it in the next steps. The same value must go everywhere a name
appears twice (e.g. `API_READ_TOKEN` on both Vercel projects).

## 4. Vercel — two projects from the same repo

vercel.com → Add New → Project → import the repo. Do this **twice**:

| | API project | Dashboard project |
|---|---|---|
| Root Directory | `apps/api` | `apps/web` |
| Framework | Other (vercel.json sets it) | Next.js |
| Environment variables | `DATABASE_URL` · `API_READ_TOKEN` · `ADMIN_TOKEN` · `WEB_ORIGIN` = the dashboard URL · optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_WEBHOOK_SECRET`, `RPC_URL_*`, `PAPER_*` | `API_URL` = the API project's URL · `API_READ_TOKEN` · `ADMIN_TOKEN` · `DASHBOARD_PASSWORD` · `SESSION_SECRET` · `DASHBOARD_WRITES` = `1` |

Leave "Include files outside the root directory" on (the default) — both apps use the shared packages.
Deploy the API first, copy its URL into the dashboard's `API_URL`, then deploy the dashboard.

Check: `https://<api>/health` returns `{"ok":true,…}`; `https://<api>/tokens` returns 401 (the read token is
doing its job); the dashboard asks for your password.

Both refuse to run unprotected: an API without `API_READ_TOKEN` answers 503, a dashboard without
`DASHBOARD_PASSWORD` shows only a "set a password" page.

## 5. GitHub Actions — the schedule

Repo → Settings → Secrets and variables → Actions:

- **Secrets:** `DATABASE_URL`, `DIRECT_URL`; optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`,
  `RPC_URL_SOLANA` … `RPC_URL_POLYGON` (wallet tracking on chains with no public source).
- **Variables:** optional `DASHBOARD_URL` (links in alerts), `SCAN_CHAINS`.

Then Actions → **scheduled-scans** → Run workflow once to see it work. GitHub emails you when a run fails.

## 6. Telegram (whenever you're ready)

1. @BotFather → /newbot → copy the token. Use a **new** bot, not one another program already uses.
2. Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and (after step 4) `TELEGRAM_ALLOWED_USER_IDS` on the
   **API** Vercel project, and the token + allowed ids as **GitHub secrets**. Redeploy the API.
3. Point Telegram at the API — on this Mac, with the same token and webhook secret in `.env`:
   ```bash
   node apps/bot/dist/main.js --set-webhook https://<your-api>.vercel.app/telegram/webhook
   ```
4. Send `/start` to your bot. It replies with your user id; put it in `TELEGRAM_ALLOWED_USER_IDS` (Vercel +
   GitHub), redeploy, `/start` again.

Commands are answered by the API instantly; alerts are sent by the scheduled job, so they arrive on the
schedule's rhythm (every 15 min, or whatever you set). While a webhook is set, the local `npm start` bot only
delivers alerts and does not poll; `--delete-webhook` switches back.

## Monitoring

- **Settings** page: which secrets are present (never their values), last good run of every job, alert counts.
- **Health** page: provider errors and rate limits per chain.
- If discovery scans stop succeeding for 60 min (`STALE_SCAN_MINUTES`), every subscribed chat gets one
  "Scans have stopped" message — once per stall, re-armed after the next good scan.
- Failed workflow runs: GitHub's email notifications.

## Costs, honestly

| Service | Free tier limit that matters | What happens at the limit |
|---|---|---|
| Supabase | 500 MB database; pauses after 7 days with no activity | Snapshots pruned after 14 days, dead tokens after 14 (`TOKEN_RETENTION_DAYS`); scheduled scans keep it active |
| Vercel Hobby | non-commercial use; function time per month | Dashboard + API are a few requests per page view |
| GitHub Actions | public repo: unlimited; private: 2,000 min/month | See step 1 |
