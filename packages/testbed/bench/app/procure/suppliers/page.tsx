import { readProcure } from '../../../lib/procure';
import { SuppliersClient } from './suppliers-client';

export const dynamic = 'force-dynamic';

export default function SuppliersPage() {
  return <SuppliersClient initial={readProcure()} />;
}
