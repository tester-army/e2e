import { useState, type FormEvent } from 'react';

export function App() {
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
    <div className="page">
      <header className="nav">
        <img src="/e2e-logotype-white.svg" alt="e2e" width={69} height={24} />
      </header>

      <main className="hero">
        <p className="eyebrow">[ with-vite ]</p>
        <h1 className="title">say hello</h1>
        <p className="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>

        <form className="form" onSubmit={greet}>
          <div className="field">
            <input
              id="name"
              className="field-input"
              autoComplete="off"
              aria-invalid={error}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label className="field-label" htmlFor="name">
              name
            </label>
          </div>
          <button className="button" type="submit">
            greet
          </button>
          {error ? (
            <p className="error" role="alert">
              enter a name first.
            </p>
          ) : null}
          {greeted !== null ? (
            <p className="status" role="status">
              hello, {greeted}!
            </p>
          ) : null}
        </form>
      </main>

      <footer className="footer">example app for e2e. the tests live in tests/.</footer>
    </div>
  );
}
