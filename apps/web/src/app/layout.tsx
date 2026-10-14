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
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeOpacity=".25" />
      <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" strokeOpacity=".4" />
      <path d="M12 12 L12 1.5 A10.5 10.5 0 0 1 21.6 7.7 Z" fill="currentColor" fillOpacity=".35" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="17" cy="6.5" r="1.1" fill="currentColor" />
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
