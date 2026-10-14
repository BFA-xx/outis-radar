'use server';

/**
 * Dashboard writes. Each runs on the server, calls the API with the admin
 * token (never exposed to the browser), then redirects back with a short
 * message the page shows. Disabled unless DASHBOARD_WRITES=1.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiWrite } from '@/lib/api';

function back(path: string, result: { ok: boolean; message?: string }, okText: string): never {
  const q = new URLSearchParams(result.ok ? { msg: okText } : { err: result.message ?? 'Something went wrong' });
  revalidatePath(path);
  redirect(`${path}${path.includes('?') ? '&' : '?'}${q}`);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function addWallet(form: FormData) {
  const res = await apiWrite<{ id: string; support: { state: string; note: string } }>('POST', '/wallets', {
    chainId: str(form, 'chainId'),
    address: str(form, 'address'),
    label: str(form, 'label') || undefined,
  });
  if (!res.ok) back('/wallets', res, '');
  if (res.data.support.state !== 'live') back('/wallets', { ok: true }, `Added — but it cannot sync yet: ${res.data.support.note}`);
  // Kick off the first sync now rather than waiting for the next scheduled run.
  await apiWrite('POST', `/wallets/${res.data.id}/sync`, undefined, 100_000);
  back(`/wallets/${res.data.id}`, { ok: true }, 'Wallet added and synced.');
}

export async function removeWallet(form: FormData) {
  const res = await apiWrite('DELETE', `/wallets/${encodeURIComponent(str(form, 'id'))}`);
  back('/wallets', res, 'Wallet removed.');
}

export async function syncWallet(form: FormData) {
  const id = str(form, 'id');
  const res = await apiWrite<{ status: string; transfers: number; errors: string[] }>('POST', `/wallets/${encodeURIComponent(id)}/sync`, undefined, 100_000);
  if (!res.ok) back(`/wallets/${id}`, res, '');
  back(`/wallets/${id}`, { ok: res.data.status !== 'failed', message: res.data.errors.join('; ') }, `Synced: ${res.data.transfers} new transfer(s)${res.data.status === 'skipped' ? ' (another sync was running — try again shortly)' : ''}.`);
}

export async function createWatchlist(form: FormData) {
  const res = await apiWrite('POST', '/watchlists', { name: str(form, 'name') });
  back('/watchlists', res, 'List created.');
}

export async function deleteWatchlist(form: FormData) {
  const res = await apiWrite('DELETE', `/watchlists/${encodeURIComponent(str(form, 'id'))}`);
  back('/watchlists', res, 'List deleted.');
}

export async function addWatchlistItem(form: FormData) {
  const returnTo = str(form, 'returnTo') || '/watchlists';
  const res = await apiWrite('POST', `/watchlists/${encodeURIComponent(str(form, 'watchlistId'))}/items`, {
    kind: str(form, 'kind'),
    chainId: str(form, 'chainId'),
    address: str(form, 'address'),
    note: str(form, 'note') || undefined,
  });
  back(returnTo, res, 'Added to watchlist.');
}

export async function removeWatchlistItem(form: FormData) {
  const res = await apiWrite('DELETE', `/watchlists/${encodeURIComponent(str(form, 'watchlistId'))}/items/${encodeURIComponent(str(form, 'itemId'))}`);
  back('/watchlists', res, 'Removed.');
}

export async function openPaperTrade(form: FormData) {
  const returnTo = str(form, 'returnTo') || '/paper';
  const res = await apiWrite('POST', '/paper/trades', {
    tokenId: str(form, 'tokenId'),
    sizeUsd: str(form, 'sizeUsd'),
    takeProfitPct: str(form, 'takeProfitPct'),
    stopLossPct: str(form, 'stopLossPct'),
    maxHoldMinutes: str(form, 'maxHoldMinutes'),
    note: str(form, 'note') || undefined,
  });
  back(returnTo, res, 'Paper position opened at the latest observed price.');
}

export async function closePaperTrade(form: FormData) {
  const res = await apiWrite('POST', `/paper/trades/${encodeURIComponent(str(form, 'id'))}/close`);
  back('/paper', res, 'Paper position closed at the latest observed price.');
}
