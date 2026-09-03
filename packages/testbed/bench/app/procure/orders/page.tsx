import { readProcure } from '../../../lib/procure';
import { OrdersClient } from './orders-client';

export const dynamic = 'force-dynamic';

export default function OrdersPage() {
  return <OrdersClient initial={readProcure()} />;
}
