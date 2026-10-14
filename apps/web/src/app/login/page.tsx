import { authRequired, misconfigured } from '@/lib/session';
import { login } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="glass rounded-2xl p-6">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        {misconfigured() ? (
          <p className="mt-3 text-sm text-warn">
            This dashboard is deployed without a password, so it is locked. Set <code className="num text-ink">DASHBOARD_PASSWORD</code> in the host&apos;s environment
            variables and redeploy.
          </p>
        ) : !authRequired() ? (
          <p className="mt-3 text-sm text-muted">No password is configured — this local dashboard is open. Nothing to do here.</p>
        ) : (
          <form action={login} className="mt-4 space-y-3">
            <input type="hidden" name="next" value={sp.next ?? '/'} />
            <input name="password" type="password" autoComplete="current-password" required autoFocus placeholder="Dashboard password" className="field h-10 w-full px-3" />
            {sp.err && <p className="text-xs text-bad">Wrong password.</p>}
            <button className="btn-primary h-10 w-full text-sm">Sign in</button>
          </form>
        )}
      </div>
    </div>
  );
}
