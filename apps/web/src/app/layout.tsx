import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: 'OUTIS RADAR',
  description: 'Multi-chain early-token discovery and risk research terminal.',
};

export const viewport: Viewport = { themeColor: '#070708' };

function Mark() {
  // Same geometry as brand/mark.svg: the open O ring, the sweep, the find.
  return (
    <svg viewBox="0 0 64 64" className="h-7 w-7" fill="none" aria-hidden>
      <defs>
        <linearGradient id="mark-sweep" x1="32" y1="32" x2="54" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity=".05" />
          <stop offset="1" stopColor="currentColor" stopOpacity=".6" />
        </linearGradient>
      </defs>
      <path d="M32 6 A26 26 0 1 0 54.52 19" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="15" stroke="currentColor" strokeOpacity=".38" strokeWidth="2.2" />
      <path d="M32 32 L32 6 A26 26 0 0 1 54.52 19 Z" fill="url(#mark-sweep)" />
      <path d="M32 32 L54.52 19" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <circle cx="32" cy="32" r="4" fill="currentColor" />
      <circle cx="44.6" cy="17.4" r="3.6" fill="#EFFFF8" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <div className="ambient" aria-hidden>
          <span />
        </div>
        <div className="grain" aria-hidden />
        <header className="glass-strong sticky top-0 z-30">
          <div className="mx-auto flex max-w-[1520px] items-center gap-5 px-4 py-3 sm:px-6">
            <Link href="/" className="flex shrink-0 items-center gap-2.5 text-accent">
              <Mark />
              <span className="text-[13px] font-semibold tracking-[0.28em] text-ink">
                OUTIS<span className="text-faint">/</span>RADAR
              </span>
            </Link>
            <Nav />
            <form action="/search" className="hidden shrink-0 md:block" role="search">
              <input
                name="q"
                placeholder="Paste a contract address…"
                aria-label="Search by contract address"
                autoComplete="off"
                spellCheck={false}
                className="field h-9 w-64 px-3 text-sm xl:w-80"
              />
            </form>
          </div>
          <form action="/search" className="px-4 pb-3 md:hidden" role="search">
            <input name="q" placeholder="Paste a contract address…" aria-label="Search by contract address" autoComplete="off" spellCheck={false} className="field h-9 w-full px-3 text-sm" />
          </form>
        </header>
        <main className="mx-auto max-w-[1520px] px-4 py-7 sm:px-6">{children}</main>
        <footer className="mx-auto max-w-[1520px] px-4 pb-10 text-xs text-faint sm:px-6">
          Research data only. Nothing here is a recommendation, and no score means a token is safe. Market data: GeckoTerminal,
          DEX Screener · Contract checks: GoPlus.
        </footer>
      </body>
    </html>
  );
}
