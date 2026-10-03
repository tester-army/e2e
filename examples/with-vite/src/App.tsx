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
        <img src="/e2e-lockup-32-white.svg" alt="e2e" width={109} height={32} />
      </header>

      <main className="hero">
        <p className="eyebrow">[01] with-vite</p>
        <h1 className="title">Say hello</h1>
        <p className="lede">A demo screen for the e2e examples. Type a name and the app greets you.</p>

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
      </main>

      <footer className="footer">Example app for e2e. The tests live in tests/.</footer>
    </div>
  );
}
