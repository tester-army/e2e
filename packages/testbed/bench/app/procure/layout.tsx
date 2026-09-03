import Link from 'next/link';
import type { ReactNode } from 'react';

export default function ProcureLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav aria-label="Procurement">
        <Link href="/procure/suppliers">Suppliers</Link> · <Link href="/procure/catalog">Catalog</Link>{' '}
        · <Link href="/procure/orders">Orders</Link>
      </nav>
      {children}
    </>
  );
}
