import { describe, expect, it } from 'vitest';
import { type FetchLike, HttpError, RateLimiter, fetchJson, redactUrl } from './http';
import { CHAINS } from '@outis/shared';
import { loadScanConfig } from './config';
import { redact } from './logger';

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => {
      if (body === 'BROKEN') throw new SyntaxError('bad json');
      return body;
    },
    text: async () => String(body),
  };
}

function scripted(responses: Array<ReturnType<typeof res> | Error>) {
  let i = 0;
  const fetchImpl: FetchLike = async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, calls: () => i };
}

const sleeps: number[] = [];
const fakeSleep = async (ms: number) => {
  sleeps.push(ms);
};
const limiter = () => new RateLimiter(60_000, Date.now, fakeSleep);

describe('fetchJson retries', () => {
  it('retries 5xx then succeeds', async () => {
    const s = scripted([res(502), res(503), res(200, { ok: 1 })]);
    await expect(fetchJson('https://x/y', { limiter: limiter(), fetchImpl: s.fetchImpl, sleep: fakeSleep })).resolves.toEqual({ ok: 1 });
    expect(s.calls()).toBe(3);
  });

  it('honours Retry-After on 429', async () => {
    sleeps.length = 0;
    const s = scripted([res(429, {}, { 'retry-after': '7' }), res(200, [1])]);
    const records: boolean[] = [];
    await fetchJson('https://x/y', {
      limiter: limiter(),
      fetchImpl: s.fetchImpl,
      sleep: fakeSleep,
      onRequest: (r) => records.push(r.rateLimited),
    });
    expect(sleeps.some((ms) => ms >= 7000)).toBe(true);
    expect(records).toEqual([true, false]);
  });

  it('does not retry a 404', async () => {
    const s = scripted([res(404), res(200)]);
    await expect(fetchJson('https://x/y', { limiter: limiter(), fetchImpl: s.fetchImpl, sleep: fakeSleep })).rejects.toBeInstanceOf(HttpError);
    expect(s.calls()).toBe(1);
  });

  it('retries network errors and malformed JSON, then gives up', async () => {
    const s = scripted([new TypeError('fetch failed'), res(200, 'BROKEN'), res(500)]);
    await expect(
      fetchJson('https://x/y', { limiter: limiter(), fetchImpl: s.fetchImpl, sleep: fakeSleep, retries: 2 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(s.calls()).toBe(3);
  });

  it('times out a hung request', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(
      fetchJson('https://x/y', { limiter: limiter(), fetchImpl, sleep: fakeSleep, retries: 0, timeoutMs: 20 }),
    ).rejects.toThrow(/Timed out/);
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = scripted([res(200)]);
    await expect(
      fetchJson('https://x/y', { limiter: limiter(), fetchImpl: s.fetchImpl, signal: controller.signal }),
    ).rejects.toThrow(/Aborted/);
    expect(s.calls()).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('spaces calls evenly', async () => {
    let now = 1_000;
    const waits: number[] = [];
    const rl = new RateLimiter(60, () => now, async (ms) => {
      waits.push(ms);
    });
    await rl.take();
    await rl.take();
    await rl.take();
    expect(waits).toEqual([1000, 2000]);
    now += 10_000;
    await rl.take();
    expect(waits).toHaveLength(2);
  });
});

describe('secret redaction', () => {
  it('strips query strings from logged URLs', () => {
    expect(redactUrl('https://rpc.example/v2?apikey=abc')).toBe('https://rpc.example/v2?…');
  });
  it('redacts DB passwords, bot tokens and key params', () => {
    const out = redact(
      'postgresql://u:hunter2@db/x 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ https://a/b?api_key=zzz https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz',
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('loadScanConfig', () => {
  it('defaults to the registry defaults', () => {
    const c = loadScanConfig({});
    expect(c.chains.map((x) => x.id)).toEqual(CHAINS.filter((x) => x.discoveryEnabledByDefault).map((x) => x.id));
    expect(c.chains.map((x) => x.id)).toEqual(expect.arrayContaining(['solana', 'base', 'ethereum', 'bsc', 'arbitrum']));
    expect(c.newPoolPages).toBe(2);
  });
  it('rejects unknown chains and out-of-range numbers with every problem listed', () => {
    expect(() => loadScanConfig({ SCAN_CHAINS: 'base,narnia' })).toThrow(/narnia/);
    expect(() => loadScanConfig({ SCAN_NEW_POOL_PAGES: '99', SCAN_REFRESH_LIMIT: '-1' })).toThrow(
      /SCAN_NEW_POOL_PAGES.*SCAN_REFRESH_LIMIT/,
    );
  });
});
