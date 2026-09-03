'use client';

import { useState } from 'react';

/**
 * Inputs that fight the typist: a card number that re-formats itself into
 * groups of four on every keystroke, an expiry that inserts its own slash, a
 * name field that trims and title-cases on blur, and a Pay button enabled only
 * when all three validate. Real runs lost characters in exactly these fields.
 */
export function PaymentClient() {
  const [card, setCard] = useState('');
  const [expiry, setExpiry] = useState('');
  const [name, setName] = useState('');
  const [paid, setPaid] = useState<string | undefined>();

  const digits = card.replace(/\D/g, '');
  const cardValid = digits.length === 16;
  const expiryValid = /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry);
  const nameValid = name.trim().split(/\s+/).length >= 2;

  return (
    <main>
      <h1>Payment</h1>
      <label htmlFor="card">Card number</label>
      <input
        id="card"
        inputMode="numeric"
        autoComplete="cc-number"
        value={card}
        onChange={(event) => {
          const raw = event.target.value.replace(/\D/g, '').slice(0, 16);
          setCard(raw.replace(/(.{4})/g, '$1 ').trim());
        }}
      />
      <label htmlFor="expiry">Expiry (MM/YY)</label>
      <input
        id="expiry"
        autoComplete="cc-exp"
        value={expiry}
        onChange={(event) => {
          const raw = event.target.value.replace(/\D/g, '').slice(0, 4);
          setExpiry(raw.length > 2 ? `${raw.slice(0, 2)}/${raw.slice(2)}` : raw);
        }}
      />
      <label htmlFor="holder">Name on card</label>
      <input
        id="holder"
        autoComplete="cc-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() =>
          setName(
            name
              .trim()
              .split(/\s+/)
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
              .join(' '),
          )
        }
      />
      <p aria-label="Validation">
        {cardValid ? 'Card ok' : 'Card: 16 digits required'} · {expiryValid ? 'Expiry ok' : 'Expiry: MM/YY'} ·{' '}
        {nameValid ? 'Name ok' : 'Name: first and last'}
      </p>
      <button
        type="button"
        disabled={!(cardValid && expiryValid && nameValid)}
        onClick={() => setPaid(`Payment of €44.95 completed for ${name} (card ending ${digits.slice(-4)})`)}
      >
        Pay €44.95
      </button>
      {paid === undefined ? null : (
        <p role="status" aria-label="Payment result">
          {paid}
        </p>
      )}
    </main>
  );
}
