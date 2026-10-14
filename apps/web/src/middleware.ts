import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, authRequired, misconfigured, verifySession } from '@/lib/session';

/** Every page and server action is behind sign-in when DASHBOARD_PASSWORD is set. */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  if (misconfigured() || (authRequired() && !(await verifySession(req.cookies.get(SESSION_COOKIE)?.value)))) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
