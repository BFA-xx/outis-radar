import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadGuard } from './read.guard';

const ctx = (path: string, headers: Record<string, string> = {}) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ path, headers }) }) }) as unknown as ExecutionContext;
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('ReadGuard', () => {
  const g = new ReadGuard();
  it('open locally when no token is set; locked on Vercel', () => {
    delete process.env.API_READ_TOKEN;
    delete process.env.VERCEL;
    expect(g.canActivate(ctx('/wallets'))).toBe(true);
    process.env.VERCEL = '1';
    expect(() => g.canActivate(ctx('/wallets'))).toThrow(/API_READ_TOKEN/);
    expect(g.canActivate(ctx('/health'))).toBe(true);
  });
  it('requires the exact token, except on /health and the Telegram webhook', () => {
    process.env.API_READ_TOKEN = 'abcdefghijklmnop';
    expect(() => g.canActivate(ctx('/wallets'))).toThrow();
    expect(() => g.canActivate(ctx('/wallets', { 'x-api-token': 'abcdefghijklmnoq' }))).toThrow();
    expect(g.canActivate(ctx('/wallets', { 'x-api-token': 'abcdefghijklmnop' }))).toBe(true);
    expect(g.canActivate(ctx('/health/'))).toBe(true);
    expect(g.canActivate(ctx('/telegram/webhook'))).toBe(true);
  });
});
