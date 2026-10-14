/**
 * HTTP for provider calls: per-provider rate limiting, timeouts, and retries
 * with backoff. Every provider request in the system goes through `fetchJson`.
 */

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; method?: string; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spaces requests so a provider never sees more than `perMinute` from us.
 * Spacing (rather than bursting a full bucket) is deliberate: both providers
 * we use rate-limit per rolling window and punish bursts with 429s.
 */
export class RateLimiter {
  private nextSlot = 0;
  private readonly intervalMs: number;

  constructor(
    perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    this.intervalMs = Math.ceil(60_000 / perMinute);
  }

  async take(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  /** After a 429, push every queued caller back. */
  penalize(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, this.now() + ms);
  }
}

export interface RequestRecord {
  url: string;
  status: number | null;
  latencyMs: number;
  ok: boolean;
  rateLimited: boolean;
  error?: string;
}

export interface FetchJsonOptions {
  limiter: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  sleep?: Sleep;
  signal?: AbortSignal;
  /** POST a JSON body (JSON-RPC). GET when absent. */
  body?: unknown;
  /** How long to pause this provider after a 429 that carries no Retry-After. */
  rateLimitPauseMs?: number;
  /** Called once per attempt — feeds provider health. */
  onRequest?: (r: RequestRecord) => void;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : null;
}

/** Strip query strings: some RPC/indexer URLs carry API keys there. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}

export async function fetchJson(url: string, opts: FetchJsonOptions): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const sleep = opts.sleep ?? realSleep;
  let lastError: HttpError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new HttpError('Aborted', null, false);
    await opts.limiter.take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'outis-radar/0.1',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { method: 'POST', body: JSON.stringify(opts.body) } : {}),
      });
      const latencyMs = Date.now() - started;

      if (res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          // A 200 with a broken body is a provider fault worth one retry.
          throw new HttpError('Malformed JSON body', res.status, true);
        }
        opts.onRequest?.({ url: redactUrl(url), status: res.status, latencyMs, ok: true, rateLimited: false });
        return body;
      }

      const rateLimited = res.status === 429;
      const retryable = rateLimited || res.status >= 500 || res.status === 408;
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const pause = rateLimited ? (retryAfterMs ?? opts.rateLimitPauseMs ?? 15_000) : null;
      if (pause !== null) opts.limiter.penalize(pause);
      opts.onRequest?.({
        url: redactUrl(url),
        status: res.status,
        latencyMs,
        ok: false,
        rateLimited,
        error: `HTTP ${res.status}`,
      });
      // The limiter now holds every caller back by `pause`; the retry waits on it there.
      lastError = new HttpError(`HTTP ${res.status} from ${redactUrl(url)}`, res.status, retryable, retryAfterMs);
    } catch (err) {
      if (err instanceof HttpError) {
        opts.onRequest?.({
          url: redactUrl(url),
          status: err.status,
          latencyMs: Date.now() - started,
          ok: false,
          rateLimited: false,
          error: err.message,
        });
        lastError = err;
      } else {
        const aborted = controller.signal.aborted;
        const message = aborted
          ? opts.signal?.aborted
            ? 'Aborted'
            : `Timed out after ${timeoutMs}ms`
          : `Network error: ${(err as Error).message}`;
        opts.onRequest?.({
          url: redactUrl(url),
          status: null,
          latencyMs: Date.now() - started,
          ok: false,
          rateLimited: false,
          error: message,
        });
        lastError = new HttpError(`${message} (${redactUrl(url)})`, null, !opts.signal?.aborted);
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    if (!lastError.retryable || attempt === retries) break;
    const backoff = Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
    await sleep(Math.max(backoff, lastError.retryAfterMs ?? 0));
  }

  throw lastError ?? new HttpError(`Request failed: ${redactUrl(url)}`, null, false);
}
