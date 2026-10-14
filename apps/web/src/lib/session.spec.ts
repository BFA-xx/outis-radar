import { afterEach, describe, expect, it } from 'vitest';
import { createSession, misconfigured, passwordMatches, verifySession } from './session';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('dashboard session', () => {
  it('accepts its own cookie, rejects tampering and expiry', async () => {
    process.env.DASHBOARD_PASSWORD = 'correct horse';
    const t = await createSession(1_000);
    expect(await verifySession(t, 2_000)).toBe(true);
    expect(await verifySession(t.replace('v1.', 'v1.9'), 2_000)).toBe(false); // extended expiry, old signature
    expect(await verifySession(t, 1_000 + 15 * 86_400_000)).toBe(false); // expired
    expect(await verifySession(undefined)).toBe(false);
    expect(await verifySession('garbage')).toBe(false);
  });

  it('changing the password signs everyone out', async () => {
    process.env.DASHBOARD_PASSWORD = 'one';
    const t = await createSession();
    process.env.DASHBOARD_PASSWORD = 'two';
    expect(await verifySession(t)).toBe(false);
  });

  it('matches the password exactly; no password means nothing matches', async () => {
    process.env.DASHBOARD_PASSWORD = 'pw';
    expect(await passwordMatches('pw')).toBe(true);
    expect(await passwordMatches('pw ')).toBe(false);
    delete process.env.DASHBOARD_PASSWORD;
    expect(await passwordMatches('')).toBe(false);
  });

  it('a Vercel deployment without a password is locked', () => {
    delete process.env.DASHBOARD_PASSWORD;
    process.env.VERCEL = '1';
    expect(misconfigured()).toBe(true);
    process.env.DASHBOARD_PASSWORD = 'x';
    expect(misconfigured()).toBe(false);
  });
});
