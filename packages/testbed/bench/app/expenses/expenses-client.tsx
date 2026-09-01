'use client';

import { useState, type FormEvent } from 'react';
import type { Expense } from '../../lib/store';

/**
 * The interactive expenses list. The server page provides the seeded state;
 * every mutation round-trips through the API and re-renders from the
 * server's answer, so the list always mirrors the shared store.
 */
export function ExpensesClient({ initialExpenses }: { initialExpenses: Expense[] }) {
  const [expenses, setExpenses] = useState(initialExpenses);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Travel');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, amount: Number(amount), category }),
    });
    setExpenses(await response.json());
    setTitle('');
    setAmount('');
  }

  async function toggleApprove(id: number) {
    const response = await fetch(`/api/expenses/${id}`, { method: 'PATCH' });
    setExpenses(await response.json());
  }

  async function remove(id: number) {
    const response = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    setExpenses(await response.json());
  }

  return (
    <main>
      <h1>Expenses</h1>
      <form onSubmit={submit}>
        <label htmlFor="title">Title</label>
        <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <label htmlFor="amount">Amount</label>
        <input
          id="amount"
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
        />
        <label htmlFor="category">Category</label>
        <select id="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option>Travel</option>
          <option>Meals</option>
          <option>Office</option>
        </select>
        <button type="submit">Add expense</button>
      </form>
      <ul aria-label="Expenses">
        {expenses.map((expense) => (
          <li key={expense.id}>
            <span>
              {expense.title} — ${expense.amount.toFixed(2)} ({expense.category})
            </span>
            {expense.approved ? <span className="badge">Approved</span> : null}
            <button type="button" onClick={() => toggleApprove(expense.id)}>
              {expense.approved ? `Unapprove ${expense.title}` : `Approve ${expense.title}`}
            </button>
            <button type="button" onClick={() => remove(expense.id)}>
              Delete {expense.title}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
