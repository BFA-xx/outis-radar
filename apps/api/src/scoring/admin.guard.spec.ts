import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminGuard } from './admin.guard';

const ctx = (token?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers: token === undefined ? {} : { 'x-admin-token': token } }) }) }) as never;

describe('AdminGuard', () => {
  const saved = process.env.ADMIN_TOKEN;
  afterEach(() => {
    process.env.ADMIN_TOKEN = saved;
  });

  it('disables writes entirely when no (or a too-short) ADMIN_TOKEN is configured', () => {
    delete process.env.ADMIN_TOKEN;
    expect(() => new AdminGuard().canActivate(ctx('anything'))).toThrow(ForbiddenException);
    process.env.ADMIN_TOKEN = 'short';
    expect(() => new AdminGuard().canActivate(ctx('short'))).toThrow(ForbiddenException);
  });

  it('rejects a missing or wrong token and accepts the right one', () => {
    process.env.ADMIN_TOKEN = 'a'.repeat(32);
    expect(() => new AdminGuard().canActivate(ctx())).toThrow(UnauthorizedException);
    expect(() => new AdminGuard().canActivate(ctx('b'.repeat(32)))).toThrow(UnauthorizedException);
    expect(() => new AdminGuard().canActivate(ctx('a'.repeat(31)))).toThrow(UnauthorizedException);
    expect(new AdminGuard().canActivate(ctx('a'.repeat(32)))).toBe(true);
  });
});
