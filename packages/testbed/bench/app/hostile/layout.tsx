import Link from 'next/link';
import type { ReactNode } from 'react';

export default function HostileLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav aria-label="Hostile">
        <Link href="/hostile/library">Library</Link> · <Link href="/hostile/notes">Notes</Link> ·{' '}
        <Link href="/hostile/report">Reports</Link> · <Link href="/hostile/tabs">Workspaces</Link> ·{' '}
        <Link href="/hostile/payment">Payment</Link>
      </nav>
      {children}
    </>
  );
}
