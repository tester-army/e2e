/**
 * State for the hostile bench: the shapes that made real customer runs fail
 * or flake. Mutations here are eventually consistent, may fail once before
 * succeeding, or may never answer at all, on purpose. Deterministic per reset.
 */

export interface Item {
  id: number;
  name: string;
  folder: string;
  deleted: boolean;
}

interface HostileStore {
  items: Item[];
  /** Deletions the list will only reflect after `LAG_MS`. */
  pendingDeletes: { id: number; at: number }[];
  /** The move the folder view only reflects after `LAG_MS`. */
  pendingMove: { id: number; folder: string; at: number } | undefined;
  /** How many times the flaky save has failed so far (fails once, then works). */
  flakySaveFailures: number;
  savedNote: string;
  consent: boolean;
  nextId: number;
}

/** How long the UI lags behind a mutation: longer than any settle, shorter than a patient check. */
export const LAG_MS = 4_000;

function seeded(): HostileStore {
  const names = ['Quarterly report', 'Quarterly report', 'Budget draft', 'Vendor list', 'Offsite plan'];
  return {
    items: names.map((name, index) => ({ id: index + 1, name, folder: index < 3 ? 'Finance' : 'Ops', deleted: false })),
    pendingDeletes: [],
    pendingMove: undefined,
    flakySaveFailures: 0,
    savedNote: '',
    consent: false,
    nextId: names.length + 1,
  };
}

const holder = globalThis as typeof globalThis & { e2eHostileStore?: HostileStore };

function store(): HostileStore {
  holder.e2eHostileStore ??= seeded();
  return holder.e2eHostileStore;
}

export function resetHostile(): void {
  holder.e2eHostileStore = seeded();
}

/** Applies every pending change whose lag has elapsed. */
function settle(state: HostileStore): void {
  const now = Date.now();
  for (const pending of state.pendingDeletes.filter((entry) => entry.at <= now)) {
    const item = state.items.find((candidate) => candidate.id === pending.id);
    if (item) item.deleted = true;
  }
  state.pendingDeletes = state.pendingDeletes.filter((entry) => entry.at > now);
  if (state.pendingMove && state.pendingMove.at <= now) {
    const item = state.items.find((candidate) => candidate.id === state.pendingMove!.id);
    if (item) item.folder = state.pendingMove.folder;
    state.pendingMove = undefined;
  }
}

export function readHostile(): { items: Item[]; savedNote: string; consent: boolean } {
  const state = store();
  settle(state);
  return JSON.parse(JSON.stringify({ items: state.items.filter((item) => !item.deleted), savedNote: state.savedNote, consent: state.consent }));
}

export type HostileCommand =
  | { type: 'delete'; id: number }
  | { type: 'move'; id: number; folder: string }
  | { type: 'flakySave'; note: string }
  | { type: 'consent' };

export function applyHostile(command: HostileCommand): { ok: boolean; message: string } {
  const state = store();
  settle(state);
  switch (command.type) {
    case 'delete':
      // Acknowledged now, reflected later: the "deleted" toast is honest, the list is not yet.
      state.pendingDeletes.push({ id: command.id, at: Date.now() + LAG_MS });
      return { ok: true, message: 'Item deleted' };
    case 'move':
      state.pendingMove = { id: command.id, folder: command.folder, at: Date.now() + LAG_MS };
      return { ok: true, message: `Moved to ${command.folder}` };
    case 'flakySave':
      if (state.flakySaveFailures === 0) {
        state.flakySaveFailures += 1;
        return { ok: false, message: 'Save failed: temporary error (503). Try again.' };
      }
      state.savedNote = command.note;
      return { ok: true, message: 'Note saved' };
    case 'consent':
      state.consent = true;
      return { ok: true, message: 'Consent recorded' };
  }
}
