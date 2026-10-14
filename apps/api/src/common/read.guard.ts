import { type CanActivate, type ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/** Reachable without the read token: uptime checks and Telegram (which carries its own secret). */
const OPEN_PATHS = new Set(['/health', '/telegram/webhook']);

/**
 * Every endpoint requires `x-api-token` = API_READ_TOKEN when that is set —
 * wallets, watchlists and paper trades are personal. Deployed (Vercel) without
 * a token, the API refuses rather than serving them to anyone with the URL.
 */
@Injectable()
export class ReadGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ path?: string; url?: string; headers: Record<string, string | undefined> }>();
    const path = (req.path ?? req.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
    if (OPEN_PATHS.has(path)) return true;
    const expected = process.env.API_READ_TOKEN ?? '';
    if (!expected) {
      if (process.env.VERCEL === '1') throw new ServiceUnavailableException({ code: 'locked', message: 'Set API_READ_TOKEN on the API deployment.' });
      return true; // local development
    }
    const a = Buffer.from(req.headers['x-api-token'] ?? '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException({ code: 'unauthorized', message: 'Missing or wrong x-api-token' });
    return true;
  }
}
