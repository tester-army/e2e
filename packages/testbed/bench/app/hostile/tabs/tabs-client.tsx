'use client';

import { useState } from 'react';

const WORKSPACES = ['Design', 'Engineering', 'Sales'] as const;

/**
 * Three workspaces as tabs. Every panel has the same controls with the same
 * names — a "Name" field and a "Save" button — so the only thing that tells
 * them apart is which tab is selected. A save in the wrong tab is silent.
 */
export function TabsClient() {
  const [active, setActive] = useState<(typeof WORKSPACES)[number]>('Design');
  const [names, setNames] = useState<Record<string, string>>({ Design: 'Design', Engineering: 'Engineering', Sales: 'Sales' });
  const [drafts, setDrafts] = useState<Record<string, string>>({ Design: '', Engineering: '', Sales: '' });

  return (
    <main>
      <h1>Workspaces</h1>
      <div role="tablist" aria-label="Workspaces">
        {WORKSPACES.map((workspace) => (
          <button key={workspace} role="tab" aria-selected={active === workspace} type="button" onClick={() => setActive(workspace)}>
            {workspace}
          </button>
        ))}
      </div>
      {WORKSPACES.map((workspace) =>
        workspace === active ? (
          <section key={workspace} role="tabpanel" aria-label={`${workspace} settings`}>
            <p role="status" aria-label="Current name">
              Current name: {names[workspace]}
            </p>
            <label htmlFor="workspace-name">Name</label>
            <input
              id="workspace-name"
              value={drafts[workspace] ?? ''}
              onChange={(event) => setDrafts({ ...drafts, [workspace]: event.target.value })}
            />
            <button
              type="button"
              onClick={() => {
                if ((drafts[workspace] ?? '').trim() === '') return;
                setNames({ ...names, [workspace]: drafts[workspace]! });
                setDrafts({ ...drafts, [workspace]: '' });
              }}
            >
              Save
            </button>
          </section>
        ) : null,
      )}
    </main>
  );
}
