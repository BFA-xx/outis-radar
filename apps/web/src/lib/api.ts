/**
 * Server-side API access. Every call reports failure as a value, never a
 * thrown error, so a page can render "API unreachable" instead of crashing —
 * and never substitutes sample data for real data.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
/** Sent on every call when set; the API requires it when deployed. Server-side only. */
const readHeaders = (): Record<string, string> => (process.env.API_READ_TOKEN ? { 'x-api-token': process.env.API_READ_TOKEN } : {});

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

export async function api<T>(path: string, timeoutMs = 8_000): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), headers: readHeaders() });
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) return { ok: false, status: res.status, message: body?.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, data: body as T };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      status: null,
      message: e.name === 'TimeoutError' ? 'API timed out' : `API unreachable (${API_URL})`,
    };
  }
}

/** Whether this dashboard may edit (wallets, watchlists). Off unless DASHBOARD_WRITES=1. */
export function writesEnabled(): boolean {
  return process.env.DASHBOARD_WRITES === '1' && Boolean(process.env.ADMIN_TOKEN);
}

/**
 * Server-side write to the API. The admin token is read here, on the server,
 * and never sent to the browser.
 */
export async function apiWrite<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 15_000): Promise<ApiResult<T>> {
  if (!writesEnabled()) return { ok: false, status: 403, message: 'Editing is disabled on this dashboard (DASHBOARD_WRITES is not 1).' };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...readHeaders(), 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: { message?: string; details?: Array<{ path: string; message: string }> } } | null;
    if (!res.ok) {
      const detail = data?.error?.details?.map((d) => `${d.path}: ${d.message}`).join('; ');
      return { ok: false, status: res.status, message: detail || data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return { ok: false, status: null, message: (err as Error).name === 'TimeoutError' ? 'API timed out' : 'API unreachable' };
  }
}
