import { trimAscii } from './money.mjs';
import { compareCodePoints } from './catalog.mjs';

export const categories = ['Meals', 'Travel', 'Supplies'];
const clock = 1792324800000;

/** Creates the expense account without sharing shop state. */
export function initialExpenses() {
  return { account: { id: 'account-ada', name: 'Ada Green' }, counter: 0, expenses: [
    { id: 'expense-meal', description: 'Lunch', amountCents: 1200, category: 'Meals', createdAt: 1792231200000 },
    { id: 'expense-travel', description: 'Train', amountCents: 2000, category: 'Travel', createdAt: 1792234800000 },
  ] };
}

/** Parses decimal text into cents with no floating-point rounding. */
export function parseAmount(value) {
  const text = trimAscii(value);
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < 1n || cents > 9999999n) throw new Error('Invalid amount. Use $0.01 through $99,999.99.');
  return Number(cents);
}

/** Validates an exact all-record sum before converting it to a safe integer. */
function expenseTotal(expenses) {
  let sum = 0n;
  for (const expense of expenses) {
    if (!Number.isSafeInteger(expense.amountCents) || expense.amountCents < 1) throw new Error('Invalid amount');
    sum += BigInt(expense.amountCents);
  }
  if (sum > 9007199254740991n) throw new Error('Invalid total. The expense total is too large.');
  return Number(sum);
}

/** Selects stable creation order and the total for exactly the visible records. */
export function expenseView(expenses, filter = 'All') {
  if (filter !== 'All' && !categories.includes(filter)) throw new Error('Invalid category');
  const records = expenses.filter(expense => filter === 'All' || expense.category === filter).toSorted((a, b) => a.createdAt - b.createdAt || compareCodePoints(a.id, b.id));
  return { records, total: expenseTotal(records) };
}

/** Changes an expense by ID and commits its fields as one returned aggregate. */
export function changeExpenses(current, command) {
  const state = structuredClone(current);
  let result = null;
  if (command.type === 'reset') return { state: { ...initialExpenses(), counter: current.counter }, result };
  if (command.type === 'expense.delete') {
    if (!state.expenses.some(expense => expense.id === command.id)) throw new Error('Expense not found');
    state.expenses = state.expenses.filter(expense => expense.id !== command.id);
  } else if (command.type === 'expense.add' || command.type === 'expense.edit') {
    const description = trimAscii(command.description);
    if (!description) throw new Error('Description is required');
    if (!categories.includes(command.category)) throw new Error('Invalid category');
    const fields = { description, amountCents: parseAmount(command.amount), category: command.category };
    if (command.type === 'expense.add') {
      if (!Number.isSafeInteger(state.counter + 1)) throw new Error('Expense ID limit reached');
      const id = 'expense-' + String(++state.counter).padStart(16, '0');
      state.expenses.push({ id, ...fields, createdAt: clock });
      result = id;
    } else {
      const expense = state.expenses.find(entry => entry.id === command.id);
      if (!expense) throw new Error('Expense not found');
      Object.assign(expense, fields);
      result = expense.id;
    }
  } else throw new Error('Unknown operation');
  expenseTotal(state.expenses);
  return { state, result };
}
