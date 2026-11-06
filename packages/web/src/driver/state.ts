/**
 * Saved sessions: a user context's cookies, and the
 * localStorage and IndexedDB of every web origin its documents were at.
 * Each origin's storage is read and written from a blank document served at
 * that origin in a scratch tab, so the app's server sees no request and the
 * attempt's tab is untouched.
 */

import type { Network } from 'webdriver-bidi-protocol';
import { EngineError, type EngineState } from 'e2e/engine';
import { releaseQuietly } from '../errors.ts';
import { SCRATCH_PARAM, type BidiSession } from './session.ts';
import type { PageJson } from './script.ts';

const STATE_FORMAT = 'bidi-storage-state';

/**
 * A stored value as JSON. A date, a non-finite number, and `undefined` are
 * one-key objects tagged `$date`, `$number`, `$undefined`; an object key of
 * the value's own that starts with `$` gains another, so no value reads as a
 * tag.
 */
type StoredValue = PageJson;

/** One IndexedDB object store: its shape and records; a key is kept only for a store with no key path. */
type StoredObjectStore = {
  readonly name: string;
  readonly keyPath: string | string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: { readonly name: string; readonly keyPath: string | string[]; readonly unique: boolean; readonly multiEntry: boolean }[];
  readonly records: { readonly key: StoredValue; readonly value: StoredValue }[];
};

/** One origin's storage in a saved state. */
type StoredOrigin = {
  readonly origin: string;
  readonly localStorage: readonly { readonly name: string; readonly value: string }[];
  readonly indexedDB: readonly { readonly name: string; readonly version: number; readonly stores: StoredObjectStore[] }[];
};

/** What a saved BiDi state holds. */
type BidiStorageState = {
  readonly cookies: readonly Network.Cookie[];
  readonly origins: readonly StoredOrigin[];
};

/** True for the saved-state shape; anything else is refused before it reaches the browser. */
function isStorageState(data: unknown): data is BidiStorageState {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { cookies?: unknown }).cookies) &&
    Array.isArray((data as { origins?: unknown }).origins)
  );
}

/**
 * Reads the document origin's localStorage and IndexedDB. A record value
 * is kept as JSON with dates tagged; one that is neither (a Blob, a class
 * instance) is refused by name, since restoring it would lose it.
 */
async function readOriginStorage(): Promise<StoredOrigin | string> {
  const encode = (value: unknown, where: string): StoredValue => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
    if (value instanceof Date) return { $date: value.getTime() };
    if (Array.isArray(value)) return value.map((each) => encode(each, where));
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, each]) => [key.startsWith('$') ? `$${key}` : key, encode(each, where)]));
    }
    if (value === undefined) return { $undefined: true };
    throw new Error(`${where} holds a ${Object.prototype.toString.call(value).slice(8, -1)}, which a saved session cannot keep`);
  };
  const request = <T>(op: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
    op.addEventListener('success', () => resolve(op.result));
    op.addEventListener('error', () => reject(op.error));
  });
  const localItems = Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) ?? '' }));
  const databases: StoredOrigin['indexedDB'][number][] = [];
  try {
    for (const info of await indexedDB.databases()) {
      if (info.name === undefined) continue;
      const db = await request(indexedDB.open(info.name));
      try {
        const stores: StoredObjectStore[] = [];
        for (const storeName of db.objectStoreNames) {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName);
          const keys = await request(store.getAllKeys());
          const values = await request(store.getAll());
          const where = `IndexedDB ${info.name}/${storeName}`;
          stores.push({
            name: storeName,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: [...store.indexNames].map((indexName) => {
              const index = store.index(indexName);
              return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
            }),
            records: keys.map((key, at) => ({ key: store.keyPath === null ? encode(key, where) : null, value: encode(values[at], where) })),
          });
        }
        databases.push({ name: info.name, version: db.version, stores });
      } finally {
        db.close();
      }
    }
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return { origin: location.origin, localStorage: localItems, indexedDB: databases };
}

/** Writes one saved origin's localStorage and IndexedDB into the document's origin, replacing what it held. */
async function writeOriginStorage(origin: StoredOrigin): Promise<void> {
  const decode = (value: StoredValue): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (value === null || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value['$date'] === 'number') return new Date(value['$date']);
    if (keys.length === 1 && typeof value['$number'] === 'string') return Number(value['$number']);
    if (keys.length === 1 && value['$undefined'] === true) return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key.startsWith('$$') ? key.slice(1) : key, decode(each)]));
  };
  localStorage.clear();
  for (const { name, value } of origin.localStorage) localStorage.setItem(name, value);
  for (const saved of origin.indexedDB) {
    await new Promise<void>((resolve, reject) => {
      const deleting = indexedDB.deleteDatabase(saved.name);
      deleting.addEventListener('success', () => resolve());
      deleting.addEventListener('error', () => reject(deleting.error));
    });
    const opening = indexedDB.open(saved.name, saved.version);
    opening.addEventListener('upgradeneeded', () => {
      for (const stored of saved.stores) {
        const store = opening.result.createObjectStore(stored.name, { keyPath: stored.keyPath, autoIncrement: stored.autoIncrement });
        for (const index of stored.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        for (const record of stored.records) {
          if (stored.keyPath === null) store.put(decode(record.value), decode(record.key) as IDBValidKey);
          else store.put(decode(record.value));
        }
      }
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.addEventListener('success', () => resolve(opening.result));
      opening.addEventListener('error', () => reject(opening.error));
    });
    db.close();
  }
}

/** The user context's cookies and the storage of every web origin the attempt's documents were at. */
export async function captureState(session: BidiSession): Promise<EngineState> {
  const { cookies } = await session.connection.send('storage.getCookies', { partition: session.partition() });
  const origins: StoredOrigin[] = [];
  await atEachOrigin(session, [...session.visited], async (origin, context) => {
    const stored = await session.run(readOriginStorage, [], context);
    if (typeof stored === 'string') throw new EngineError('UNSUPPORTED_CAPABILITY', `state capture: ${origin}: ${stored}`, { retryable: false });
    if (stored.localStorage.length > 0 || stored.indexedDB.length > 0) origins.push(stored);
  });
  const data: BidiStorageState = { cookies, origins };
  return { format: STATE_FORMAT, version: 1, data };
}

/** Replaces the user context with a clean one holding the snapshot: cookies through `storage.setCookie`, each origin's storage from its blank document. */
export async function restoreState(session: BidiSession, state: EngineState, signal: AbortSignal): Promise<void> {
  if (state.format !== STATE_FORMAT || state.version !== 1 || !isStorageState(state.data)) {
    throw new EngineError('INVALID_STATE', `unsupported state format ${state.format}@${String(state.version)}`, { retryable: false });
  }
  const { cookies, origins } = state.data;
  await session.replaceUserContext(signal);
  for (const { size: _size, ...cookie } of cookies) {
    await session.connection.send('storage.setCookie', { cookie, partition: session.partition() });
  }
  const byOrigin = new Map(origins.map((origin) => [origin.origin, origin]));
  await atEachOrigin(session, [...byOrigin.keys()], async (origin, context) => {
    await session.run(writeOriginStorage, [byOrigin.get(origin)!], context);
  });
}

/**
 * Runs `work` in a scratch tab of the user context at each origin in turn,
 * on a blank document the network serves and the app's init scripts skip
 * (`SCRATCH_PARAM`), so reading or writing storage changes nothing else;
 * the tab is closed after.
 */
async function atEachOrigin(session: BidiSession, origins: readonly string[], work: (origin: string, context: string) => Promise<void>): Promise<void> {
  if (origins.length === 0) return;
  const connection = session.connection;
  const { context } = await connection.send('browsingContext.create', {
    type: session.browser.traits.newContext,
    userContext: session.userContext,
    background: true,
  });
  try {
    const undo = await session.network.serveBlank(context);
    try {
      for (const origin of origins) {
        await connection.send('browsingContext.navigate', { context, url: `${origin}/?${SCRATCH_PARAM}`, wait: 'complete' });
        await work(origin, context);
      }
    } finally {
      await undo();
    }
  } finally {
    await releaseQuietly(connection.send('browsingContext.close', { context }));
  }
}
