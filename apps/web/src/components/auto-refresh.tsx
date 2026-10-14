'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Re-fetches the server-rendered page on an interval. Polling is enough here:
 * the data only changes when a scan runs (minutes apart), and it costs one
 * API call per open tab per interval. Pauses while the tab is hidden.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [last, setLast] = useState(() => Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - last >= seconds * 1000) {
        router.refresh();
        setLast(Date.now());
      }
      tick((n) => n + 1);
    }, 5_000);
    return () => clearInterval(id);
  }, [router, seconds, last]);

  const remaining = Math.max(0, seconds - Math.round((Date.now() - last) / 1000));
  return (
    <button
      type="button"
      onClick={() => {
        router.refresh();
        setLast(Date.now());
      }}
      className="btn-ghost num flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
      title="Reload data from the API"
    >
      <span className="relative inline-flex h-1.5 w-1.5"><span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-50" /><span className="relative h-1.5 w-1.5 rounded-full bg-accent" /></span>
      Live · {remaining}s
    </button>
  );
}
