/**
 * In-memory bench state. Lives on `globalThis` so every route bundle in the
 * Next server shares the one instance; seeded at first access (server start)
 * and restored verbatim by `POST /api/reset`.
 */

export interface Expense {
  id: number;
  title: string;
  amount: number;
  category: 'Travel' | 'Meals' | 'Office';
  approved: boolean;
}

interface BenchStore {
  expenses: Expense[];
  nextId: number;
}

/** Builds a fresh copy of the seed state. */
function seeded(): BenchStore {
  return {
    // Both seeded rows are approved so the bench's approve step has exactly
    // one "Approve …" candidate: this suite times record→replay, and must not
    // conflate journey length with same-role disambiguation flakiness.
    expenses: [
      { id: 1, title: 'Conference flights', amount: 320, category: 'Travel', approved: true },
      { id: 2, title: 'Client dinner', amount: 64, category: 'Meals', approved: true },
    ],
    nextId: 3,
  };
}

const holder = globalThis as typeof globalThis & { e2eBenchStore?: BenchStore };

/** Returns the shared store, seeding it on first access. */
function store(): BenchStore {
  holder.e2eBenchStore ??= seeded();
  return holder.e2eBenchStore;
}

/** Restores the seed state. */
export function resetStore(): void {
  holder.e2eBenchStore = seeded();
}

/** Returns a defensive copy of the current expenses. */
export function listExpenses(): Expense[] {
  return store().expenses.map((expense) => ({ ...expense }));
}

/** Adds an expense and returns the updated list. */
export function addExpense(input: {
  title: string;
  amount: number;
  category: Expense['category'];
}): Expense[] {
  const state = store();
  state.expenses.push({ id: state.nextId, approved: false, ...input });
  state.nextId += 1;
  return listExpenses();
}

/** Toggles the approved flag of one expense and returns the updated list. */
export function toggleApproved(id: number): Expense[] {
  const expense = store().expenses.find((candidate) => candidate.id === id);
  if (expense) expense.approved = !expense.approved;
  return listExpenses();
}

/** Deletes one expense and returns the updated list. */
export function removeExpense(id: number): Expense[] {
  const state = store();
  state.expenses = state.expenses.filter((candidate) => candidate.id !== id);
  return listExpenses();
}
