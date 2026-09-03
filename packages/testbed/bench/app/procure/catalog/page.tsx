import { readProcure } from '../../../lib/procure';
import { CatalogClient } from './catalog-client';

export const dynamic = 'force-dynamic';

export default function CatalogPage() {
  return <CatalogClient initial={readProcure()} />;
}
