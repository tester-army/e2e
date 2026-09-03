'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

export function GateClient() {
  const [code, setCode] = useState('');
  const [colour, setColour] = useState('');
  const [desk, setDesk] = useState('');
  const [result, setResult] = useState<string | undefined>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch('/api/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'enter', code, colour, desk }),
    });
    const body = (await response.json()) as { message: string };
    setResult(body.message);
  }

  return (
    <main>
      <h1>Visitor gate</h1>
      <p>Enter the code, colour and desk number printed on the ticket you were issued.</p>
      <form onSubmit={submit} aria-label="Gate entry">
        <label htmlFor="gate-code">Ticket code</label>
        <input id="gate-code" value={code} onChange={(event) => setCode(event.target.value)} required />
        <label htmlFor="gate-colour">Ticket colour</label>
        <input id="gate-colour" value={colour} onChange={(event) => setColour(event.target.value)} required />
        <label htmlFor="gate-desk">Desk number</label>
        <input id="gate-desk" type="number" value={desk} onChange={(event) => setDesk(event.target.value)} required />
        <button type="submit">Enter</button>
      </form>
      {result === undefined ? null : (
        <p role="status" aria-label="Gate result">
          {result}
        </p>
      )}
      <nav aria-label="Visitor">
        <Link href="/handoff">Ticket desk</Link> · <Link href="/procure/suppliers">Procurement</Link>
      </nav>
    </main>
  );
}
