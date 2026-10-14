'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LIVE = [
  { href: '/', label: 'Overview' },
  { href: '/discover', label: 'Discovery' },
  { href: '/launchpads', label: 'Launchpads' },
  { href: '/chains', label: 'Chains' },
  { href: '/wallets', label: 'Wallets' },
  { href: '/watchlists', label: 'Watchlists' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/paper', label: 'Paper' },
  { href: '/performance', label: 'Performance' },
  { href: '/scoring', label: 'Scoring' },
  { href: '/health', label: 'Health' },
  { href: '/settings', label: 'Settings' },
];


export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href) || (href === '/discover' && path.startsWith('/token')));
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto text-[13px]">
      <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-line bg-black/30 p-1">
        {LIVE.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 transition-all ${
              active(l.href)
                ? 'bg-white/[0.09] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]'
                : 'text-muted hover:bg-white/[0.04] hover:text-ink'
            }`}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
