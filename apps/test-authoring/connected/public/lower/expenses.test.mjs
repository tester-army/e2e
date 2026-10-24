import test from 'node:test';
import assert from 'node:assert/strict';
import { initialExpenses, changeExpenses, expenseView, parseAmount } from '../expenses-domain.mjs';

test('editing by ID atomically replaces fields and retains its position', () => {
  const original = initialExpenses();
  const state = changeExpenses(original, { type: 'expense.edit', id: 'expense-meal', description: 'Team lunch', amount: '15.00', category: 'Travel' }).state;
  assert.deepEqual(state.expenses.map(expense => [expense.id, expense.description, expense.amountCents, expense.category]), [['expense-meal', 'Team lunch', 1500, 'Travel'], ['expense-travel', 'Train', 2000, 'Travel']]);
  assert.equal(state.expenses[0].createdAt, 1792231200000);
  assert.equal(original.expenses[0].amountCents, 1200);
});
test('filtered membership and total include only visible records', () => {
  const state = initialExpenses();
  assert.deepEqual(expenseView(state.expenses, 'Meals').records.map(expense => expense.id), ['expense-meal']);
  assert.equal(expenseView(state.expenses, 'Meals').total, 1200);
  assert.equal(expenseView(state.expenses).total, 3200);
  assert.deepEqual(expenseView(state.expenses, 'Supplies'), { records: [], total: 0 });
});
test('decimal amounts use exact cents and reject implicit rounding', () => {
  assert.equal(parseAmount(' 00015.01\t'), 1501);
  assert.equal(parseAmount('0.01'), 1);
  assert.equal(parseAmount('99999.99'), 9999999);
  assert.throws(() => parseAmount('12.345'), /Invalid amount/);
});
