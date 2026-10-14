/**
 * Dashboard sign-in: one shared password (DASHBOARD_PASSWORD), a signed,
 * expiring, HttpOnly cookie. Web Crypto only, so the same code runs in the
 * edge middleware and in server actions.
 *
 * The signing key comes from SESSION_SECRET, or — if that is unset — from the
 * password itself, so changing the password signs everyone out.
 */
export const SESSION_COOKIE = 'outis_session';
export const SESSION_DAYS = 14;

const enc = new TextEncoder();

export function authRequired(): boolean {
  return Boolean(process.env.DASHBOARD_PASSWORD);
}

/** Deployed without a password: refuse to serve rather than expose wallets and settings. */
export function misconfigured(): boolean {
  return !authRequired() && (process.env.VERCEL === '1' || (process.env.NODE_ENV === 'production' && process.env.ALLOW_OPEN_DASHBOARD !== '1'));
}

async function key(): Promise<CryptoKey> {
  const seed = process.env.SESSION_SECRET || `pw:${process.env.DASHBOARD_PASSWORD ?? ''}`;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`outis-session:${seed}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function createSession(now = Date.now()): Promise<string> {
  const payload = `v1.${now + SESSION_DAYS * 86_400_000}`;
  const sig = await crypto.subtle.sign('HMAC', await key(), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return false;
  try {
    return await crypto.subtle.verify('HMAC', await key(), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
export async function passwordMatches(given: string): Promise<boolean> {
  const want = process.env.DASHBOARD_PASSWORD ?? '';
  if (!want) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(want))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
