import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-lg">Not tracked</p>
      <p className="mt-1 text-sm text-muted">This token or page is not in the database. Tokens appear here once a scan discovers them.</p>
      <Link href="/discover" className="mt-4 inline-block text-sm text-accent">Back to discovery</Link>
    </div>
  );
}
