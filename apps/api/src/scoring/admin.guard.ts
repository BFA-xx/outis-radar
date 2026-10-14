import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Write endpoints require `x-admin-token` to equal ADMIN_TOKEN. With no
 * ADMIN_TOKEN configured, writes are disabled entirely rather than open.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || expected.length < 16) {
      throw new ForbiddenException({ code: 'writes_disabled', message: 'Set ADMIN_TOKEN (16+ chars) on the API to enable write endpoints.' });
    }
    const got = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers['x-admin-token'] ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Missing or wrong x-admin-token' });
    }
    return true;
  }
}
