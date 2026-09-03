'use client';

import { useState, type FormEvent } from 'react';
import type { ProcureState, Terms } from '../../../lib/procure';
import { useProcure } from '../use-procure';

export function SuppliersClient({ initial }: { initial: ProcureState }) {
  const { state, apply } = useProcure(initial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('Germany');
  const [terms, setTerms] = useState<Terms>('Net 30');
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.includes('@')) {
      setError('Email must contain @');
      return;
    }
    setError(undefined);
    await apply({ type: 'addSupplier', name: name.trim(), email: email.trim(), country, terms });
    setName('');
    setEmail('');
  }

  return (
    <main>
      <h1>Suppliers</h1>
      <form onSubmit={submit} aria-label="New supplier">
        <label htmlFor="supplier-name">Supplier name</label>
        <input id="supplier-name" value={name} onChange={(event) => setName(event.target.value)} required />
        <label htmlFor="supplier-email">Contact email</label>
        <input id="supplier-email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <label htmlFor="supplier-country">Country</label>
        <select id="supplier-country" value={country} onChange={(event) => setCountry(event.target.value)}>
          {['Germany', 'Poland', 'Spain', 'Sweden', 'Netherlands', 'Italy'].map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
        <label htmlFor="supplier-terms">Payment terms</label>
        <select id="supplier-terms" value={terms} onChange={(event) => setTerms(event.target.value as Terms)}>
          <option>Net 30</option>
          <option>Net 60</option>
          <option>Prepaid</option>
        </select>
        {error === undefined ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit">Add supplier</button>
      </form>
      <table aria-label="Suppliers">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Country</th>
            <th>Terms</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {state.suppliers.map((supplier) => (
            <tr key={supplier.id}>
              <td>{supplier.name}</td>
              <td>{supplier.email}</td>
              <td>{supplier.country}</td>
              <td>{supplier.terms}</td>
              <td>
                <span className="badge">{supplier.active ? 'Active' : 'Inactive'}</span>
              </td>
              <td>
                <button type="button" onClick={() => apply({ type: 'toggleSupplier', id: supplier.id })}>
                  {supplier.active ? `Deactivate ${supplier.name}` : `Reactivate ${supplier.name}`}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
