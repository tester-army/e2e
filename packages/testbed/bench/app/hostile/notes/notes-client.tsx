'use client';

import { useEffect, useState } from 'react';
import { useHostile, type HostileView } from '../use-hostile';

/**
 * A note form whose Save is disabled until an async validation (1.2 s after
 * the last keystroke) passes, whose first save fails with a 503 toast and
 * succeeds on retry, and which clears the field after a failure — the retry
 * has to type the note again.
 */
export function NotesClient({ initial }: { initial: HostileView }) {
  const { view, apply, toast } = useHostile(initial);
  const [note, setNote] = useState('');
  const [valid, setValid] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setValid(false);
    if (note.trim().length < 3) return;
    setChecking(true);
    const timer = setTimeout(() => {
      setChecking(false);
      setValid(true);
    }, 1_200);
    return () => clearTimeout(timer);
  }, [note]);

  return (
    <main>
      <h1>Notes</h1>
      <p role="status" aria-label="Saved note">
        Saved note: {view.savedNote === '' ? '(none)' : view.savedNote}
      </p>
      <label htmlFor="note">Note</label>
      <input id="note" value={note} onChange={(event) => setNote(event.target.value)} />
      <p aria-label="Validation">{checking ? 'Checking…' : valid ? 'Looks good' : 'Enter at least 3 characters'}</p>
      <button
        type="button"
        disabled={!valid}
        onClick={async () => {
          const result = await apply({ type: 'flakySave', note });
          if (!result.ok) setNote('');
        }}
      >
        Save note
      </button>
      {toast === undefined ? null : (
        <p role={toast.startsWith('Save failed') ? 'alert' : 'status'} aria-label="Notification">
          {toast}
        </p>
      )}
    </main>
  );
}
