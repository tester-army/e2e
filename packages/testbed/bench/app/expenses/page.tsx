import { listExpenses } from '../../lib/store';
import { ExpensesClient } from './expenses-client';

export const dynamic = 'force-dynamic';

export default function ExpensesPage() {
  return <ExpensesClient initialExpenses={listExpenses()} />;
}
