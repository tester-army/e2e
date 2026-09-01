'use client';

import { useEffect, useState } from 'react';

const TOGGLE_NAMES = [
  'Activate plan',
  'Enable notifications',
  'Start sync',
  'Show archive',
  'Mute alerts',
] as const;

/**
 * Relocation stress: roles and accessible names are stable, but every render
 * re-keys the buttons and rewrites their ids and test ids, so any cached node
 * reference or id/testid selector goes stale. A delayed section also bumps the
 * render counter 1s after load to invalidate references taken early.
 */
export function StaleClient() {
  // Per-mount nonce: ids provably differ on every page load — and therefore
  // between a record run and a replay run — not just across the 1s timer
  // race. The accessible tree stays deterministic; only ids/testids churn.
  const [nonce] = useState(() => Math.random().toString(36).slice(2, 8));
  const [renderId, setRenderId] = useState(0);
  const [onStates, setOnStates] = useState<boolean[]>(() => TOGGLE_NAMES.map(() => false));
  const [delayedReady, setDelayedReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDelayedReady(true);
      setRenderId((value) => value + 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  function toggle(index: number) {
    setOnStates((states) => states.map((on, position) => (position === index ? !on : on)));
    setRenderId((value) => value + 1);
  }

  return (
    <main>
      <h1>Stale DOM playground</h1>
      <p>Ids and test ids change on every render; only roles and accessible names are stable.</p>
      <ul aria-label="Toggles">
        {TOGGLE_NAMES.map((name, index) => (
          <li key={`${renderId}-${index}`}>
            <button
              type="button"
              id={`toggle-${nonce}-r${renderId}-${index}`}
              data-testid={`toggle-${nonce}-r${renderId}-${index}`}
              onClick={() => toggle(index)}
            >
              {name}
            </button>
            <span>
              {name} is {onStates[index] ? 'on' : 'off'}
            </span>
          </li>
        ))}
      </ul>
      <section aria-label="Delayed section">
        <h2>Delayed section</h2>
        <p>{delayedReady ? 'Delayed content ready' : 'Loading delayed content…'}</p>
      </section>
    </main>
  );
}
