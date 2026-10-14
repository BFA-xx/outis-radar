import { AutoRefresh } from '@/components/auto-refresh';
import { ApiDown, PageHeader, Panel, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface AlertsResponse {
  telegramConfigured: boolean;
  allowedUsers: number;
  subscribers: Array<{ id: string; username: string | null; active: boolean; createdAt: string }>;
  last24h: Array<{ kind: string; status: string; count: number }>;
  events: Array<{ id: string; kind: string; status: string; text: string; createdAt: string; sentAt: string | null; error: string | null; attempts: number }>;
}

const KIND_LABEL: Record<string, string> = { discovery: 'New token', risk: 'Risk', wallet: 'Wallet', watch: 'Watchlist', summary: 'Summary' };

/** Telegram HTML → plain text for display (never rendered as HTML here). */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const status = ['pending', 'sent', 'failed', 'suppressed'].includes(sp.status ?? '') ? sp.status : undefined;
  const res = await api<AlertsResponse>(`/alerts?limit=100${status ? `&status=${status}` : ''}`);
  if (!res.ok) return <ApiDown message={res.message} />;
  const d = res.data;
  const count = (st: string) => d.last24h.filter((c) => c.status === st).reduce((s, c) => s + c.count, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alerts"
        sub="Everything the Telegram bot generated — including alerts held back by your hourly cap. Settings live in the bot: /prefs, /set, /chains."
        right={<AutoRefresh seconds={30} />}
      />

      {!d.telegramConfigured && (
        <Panel title="Set up Telegram (2 minutes)">
          <ol className="list-decimal space-y-1.5 py-4 pl-10 pr-5 text-sm text-muted">
            <li>
              In Telegram, message <span className="text-ink">@BotFather</span> → <code className="num">/newbot</code> → pick a name. Copy the token it gives you.
            </li>
            <li>
              Put it in <code className="num text-ink">.env</code> as <code className="num text-ink">TELEGRAM_BOT_TOKEN=…</code> (on your machine — never paste it into a chat).
            </li>
            <li>
              Restart with <code className="num text-ink">npm start</code>, open your bot, send <code className="num">/start</code>. It replies with your user id.
            </li>
            <li>
              Put that id in <code className="num text-ink">TELEGRAM_ALLOWED_USER_IDS</code>, restart, send <code className="num">/start</code> again. Done.
            </li>
          </ol>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Sent · 24h', count('sent')],
          ['Pending', count('pending')],
          ['Held back · 24h', count('suppressed')],
          ['Failed · 24h', count('failed')],
        ].map(([l, v]) => (
          <div key={l as string} className="glass rounded-2xl px-5 py-4">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{l}</div>
            <div className="num mt-2 text-[26px] leading-none">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={`Subscribers (${d.subscribers.length})`}>
          {d.subscribers.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">
              {d.telegramConfigured ? (d.allowedUsers ? 'Nobody has sent /start yet.' : 'No allowed users yet — see step 4 above.') : 'Telegram is not configured.'}
            </p>
          ) : (
            <ul className="divide-y divide-white/[0.045] text-sm">
              {d.subscribers.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-5 py-2.5">
                  <span>{s.username ? `@${s.username}` : 'private chat'}</span>
                  <StatusPill status={s.active ? 'live' : 'disabled'} title={s.active ? 'Receiving alerts' : 'Paused (or the bot was blocked)'} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent alerts"
          className="lg:col-span-2"
          right={
            <div className="flex gap-1 text-xs">
              {[undefined, 'sent', 'pending', 'suppressed', 'failed'].map((st) => (
                <a key={st ?? 'all'} href={st ? `/alerts?status=${st}` : '/alerts'} className={`rounded-md px-2 py-1 ${status === st ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}>
                  {st ?? 'all'}
                </a>
              ))}
            </div>
          }
        >
          {d.events.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">No alerts yet. They appear when new data matches a subscriber’s filters.</p>
          ) : (
            <ul className="max-h-[640px] divide-y divide-white/[0.045] overflow-auto">
              {d.events.map((e) => (
                <li key={e.id} className="px-5 py-3">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <StatusPill status={e.status === 'sent' ? 'ok' : e.status === 'suppressed' ? 'skipped' : e.status} />
                    <span className="ml-auto text-faint">{ago(e.createdAt)}</span>
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink/90">{plain(e.text)}</pre>
                  {e.error && <p className="mt-1 text-xs text-bad">{e.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
