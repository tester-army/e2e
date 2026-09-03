'use client';

import { useState } from 'react';
import { useHostile, type HostileView } from '../use-hostile';

/**
 * A document library with every hazard the real failed runs had: two items
 * with the same name told apart only by their folder, deletes and moves the
 * list reflects four seconds late, a consent banner that covers the toolbar
 * until accepted, and a toast that is gone in 2.5 s.
 */
export function LibraryClient({ initial }: { initial: HostileView }) {
  const { view, apply, toast } = useHostile(initial);
  const [folder, setFolder] = useState('Finance');
  const [moving, setMoving] = useState<number | undefined>();
  const [target, setTarget] = useState('Ops');
  const folders = ['Finance', 'Ops', 'Archive'];
  const visible = view.items.filter((item) => item.folder === folder);

  return (
    <main>
      <h1>Library</h1>
      {view.consent ? null : (
        <div
          role="dialog"
          aria-label="Cookie consent"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, background: '#333', color: '#fff', padding: '1.25rem', zIndex: 10 }}
        >
          <p>We use cookies to run this library. Accept to continue.</p>
          <button type="button" onClick={() => void apply({ type: 'consent' })}>
            Accept cookies
          </button>
        </div>
      )}
      <div role="toolbar" aria-label="Library toolbar">
        <label htmlFor="folder">Folder</label>
        <select id="folder" value={folder} onChange={(event) => setFolder(event.target.value)}>
          {folders.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {toast === undefined ? null : (
        <p role="status" aria-label="Notification">
          {toast}
        </p>
      )}
      <p aria-label="Folder summary">
        {folder}: {visible.length} item(s)
      </p>
      <table aria-label="Documents">
        <thead>
          <tr>
            <th>Name</th>
            <th>Folder</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.folder}</td>
              <td>
                <button type="button" onClick={() => setMoving(item.id)}>
                  Move
                </button>
                <button type="button" onClick={() => void apply({ type: 'delete', id: item.id })}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {visible.length === 0 ? (
            <tr>
              <td colSpan={3}>This folder is empty</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {moving === undefined ? null : (
        <div role="dialog" aria-label="Move document" className="panel">
          <p>Move “{view.items.find((item) => item.id === moving)?.name}” to</p>
          <label htmlFor="move-target">Destination folder</label>
          <select id="move-target" value={target} onChange={(event) => setTarget(event.target.value)}>
            {folders.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={async () => {
              await apply({ type: 'move', id: moving, folder: target });
              setMoving(undefined);
            }}
          >
            Move
          </button>
          <button type="button" onClick={() => setMoving(undefined)}>
            Cancel
          </button>
        </div>
      )}
    </main>
  );
}
