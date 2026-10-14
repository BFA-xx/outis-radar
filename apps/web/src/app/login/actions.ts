'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DAYS, createSession, passwordMatches } from '@/lib/session';

/** Only same-site paths, so a crafted ?next= cannot bounce a signed-in user elsewhere. */
function safeNext(v: string): string {
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

export async function login(form: FormData) {
  const next = safeNext(String(form.get('next') ?? '/'));
  // A fixed delay on every attempt keeps guessing slow.
  await new Promise((r) => setTimeout(r, 600));
  if (!(await passwordMatches(String(form.get('password') ?? '')))) {
    redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  redirect(next);
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
