import Link from 'next/link';
import type { ReactNode } from 'react';
import { logout } from '@/app/login/actions';
import { ApiDown, PageHeader, Panel } from '@/components/ui';
import { api, writesEnabled } from '@/lib/api';
import { ago, usd } from '@/lib/format';
import { authRequired } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Settings {
  host: 'vercel' | 'local';
  security: { apiReadToken: boolean; adminToken: boolean };
  telegram: { botToken: boolean; webhookSecret: boolean; allowedUsers: number; subscribers: number; activeSubscribers: number; sentLastDay: number; lastSentAt: string | null };
  rpc: Array<{ chainId: string; name: string; configured: boolean }>;
  paper: { startingBalanceUsd: number; defaultSizeUsd: number; feeBps: number; slippageBps: number };
  jobs: Array<{ job: string; label: string; lastOkAt: string | null; last: { status: string; trigger: string; startedAt: string; finishedAt: string | null; error: string | null } | null }>;
}

const STALE_MIN = 60;

function Row({ label, ok, children }: { label: string; ok: boolean | null; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.045] px-5 py-2.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right">
        {ok === null ? null : ok ? <span className="text-accent">✓ set</span> : <span className="text-warn">not set</span>}
        {children && <span className="block text-xs text-faint">{children}</span>}
      </span>
    </div>
  );
}

export default async function SettingsPage() {
  const res = await api<Settings>('/settings');
  if (!res.ok) return <ApiDown message={res.message} />;
  const s = res.data;
  const signIn = authRequired();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        sub="What is configured, shown as present or missing — secret values are never displayed or sent to the browser. Values are changed in the host's environment settings (Vercel / GitHub), not here, so a leaked dashboard session cannot read or change them."
        right={
          signIn ? (
            <form action={logout}>
              <button className="btn-ghost px-3 py-1.5 text-xs">Sign out</button>
            </form>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Access">
          <Row label="Dashboard password" ok={signIn}>{signIn ? 'Every page needs sign-in' : s.host === 'local' ? 'Open — fine on your own machine only' : 'Set DASHBOARD_PASSWORD'}</Row>
          <Row label="API read token" ok={s.security.apiReadToken}>{s.security.apiReadToken ? 'API answers only this dashboard' : s.host === 'local' ? 'Optional locally' : 'Set API_READ_TOKEN on both projects'}</Row>
          <Row label="Admin token (writes)" ok={s.security.adminToken}>{s.security.adminToken ? 'Wallets, watchlists, paper trades, scoring can be changed' : 'Read-only'}</Row>
          <Row label="Dashboard editing" ok={writesEnabled()}>{writesEnabled() ? 'DASHBOARD_WRITES=1' : 'DASHBOARD_WRITES is not 1'}</Row>
          <Row label="Running on" ok={null}>{s.host === 'vercel' ? 'Vercel' : 'this computer'}</Row>
        </Panel>

        <Panel title="Scheduled jobs" right={<Link href="/health" className="text-xs text-muted hover:text-ink">Health →</Link>}>
          {s.jobs.map((j) => {
            const stale = !j.lastOkAt || Date.now() - Date.parse(j.lastOkAt) > STALE_MIN * 60_000;
            return (
              <div key={j.job} className="flex items-start justify-between gap-4 border-b border-white/[0.045] px-5 py-2.5 text-sm last:border-0">
                <span className="text-muted">{j.label}</span>
                <span className="text-right">
                  <span className={stale ? 'text-warn' : 'text-accent'}>{j.lastOkAt ? `last good ${ago(j.lastOkAt)}` : 'never succeeded'}</span>
                  {j.last && (
                    <span className="block text-xs text-faint">
                      latest: {j.last.status} · {j.last.trigger} · {ago(j.last.startedAt)}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          <p className="px-5 py-2.5 text-xs text-faint">If scans stop for over {STALE_MIN} min, subscribed Telegram chats get one warning.</p>
        </Panel>

        <Panel title="Telegram">
          <Row label="Bot token" ok={s.telegram.botToken} />
          <Row label="Webhook secret" ok={s.telegram.webhookSecret}>{s.host === 'local' ? 'Only needed when deployed' : 'Needed for commands to reach the deployed bot'}</Row>
          <Row label="Allowed users" ok={s.telegram.allowedUsers > 0}>{s.telegram.allowedUsers} id(s) in TELEGRAM_ALLOWED_USER_IDS</Row>
          <Row label="Subscribed chats" ok={null}>{s.telegram.activeSubscribers} active of {s.telegram.subscribers}</Row>
          <Row label="Alerts sent, last 24h" ok={null}>{s.telegram.sentLastDay}{s.telegram.lastSentAt ? ` · last ${ago(s.telegram.lastSentAt)}` : ''}</Row>
        </Panel>

        <Panel title="Paper trading">
          <Row label="Starting balance" ok={null}>{usd(s.paper.startingBalanceUsd)}</Row>
          <Row label="Default size" ok={null}>{usd(s.paper.defaultSizeUsd)}</Row>
          <Row label="Fee per side" ok={null}>{s.paper.feeBps / 100}%</Row>
          <Row label="Extra slippage per side" ok={null}>{s.paper.slippageBps / 100}%</Row>
        </Panel>
      </div>

      <Panel title="Your RPC endpoints (wallet tracking)">
        <p className="border-b border-line px-5 py-2.5 text-xs text-muted">
          Present on the API host. The scheduled wallet sync reads its own copy — add the same <code className="num">RPC_URL_*</code> values as GitHub secrets.
          Chains without one fall back to the verified public sources listed on <Link href="/wallets" className="text-accent hover:underline">Wallets</Link>, or are unsupported.
        </p>
        <div className="grid gap-x-6 px-5 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {s.rpc.map((r) => (
            <div key={r.chainId} className="flex justify-between py-1">
              <span className="text-muted">{r.name}</span>
              <span className={r.configured ? 'text-accent' : 'text-faint'}>{r.configured ? '✓' : '—'}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
