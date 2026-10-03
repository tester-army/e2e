'use client';

import { useState, type FormEvent } from 'react';

export function GreetingForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const [greeted, setGreeted] = useState<string | null>(null);

  function greet(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (value === '') {
      setError(true);
      setGreeted(null);
      return;
    }
    setError(false);
    setGreeted(value);
    setName('');
  }

  return (
    <form className="form" onSubmit={greet}>
      <label className="label" htmlFor="name">
        Name
      </label>
      <div className="row">
        <input
          id="name"
          className="field"
          autoComplete="off"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="button" type="submit">
          Greet
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          Enter a name first.
        </p>
      ) : null}
      {greeted !== null ? (
        <p className="status" role="status">
          Hello, {greeted}!
        </p>
      ) : null}
    </form>
  );
}
