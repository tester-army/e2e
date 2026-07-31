/**
 * `cache-1` entry reading and writing (spec 13-reporting.md "cache-1").
 *
 * An entry is deliberately small: a schema version, when it was written, and
 * the locator to replay with the identity it had. It does not repeat its own
 * key. The file name is the key digest and the runner only ever opens the digest
 * of the key it just computed, so a file being there already means it is for
 * this call.
 *
 * The one thing worth validating is the locator's shape, because that is what
 * gets handed to the locator engine. Everything else is either informational or
 * cannot affect what runs, so it is read as-is and a malformed entry is a plain
 * miss.
 */

import { asCacheLocator, asSemanticIdentity, type CacheLocator, type SemanticIdentity } from './locator.ts';
import { asPathAction, MAX_PATH_ACTIONS, type PathAction } from './path-action.ts';

export interface LocatePayload {
  readonly locator: CacheLocator;
  readonly expected: SemanticIdentity;
}

export interface PathPayload {
  readonly type: 'path';
  readonly actions: readonly PathAction[];
}

/**
 * One entry's kind and its payload, together. The two travel as a pair because
 * the kind is what says how to read the payload, and a key digest is only ever
 * opened for the kind that computed it.
 */
export type CachePayload =
  | { readonly kind: 'locate'; readonly payload: LocatePayload }
  | { readonly kind: 'path'; readonly payload: PathPayload };

export type CacheEntry = {
  readonly schemaVersion: 'cache-1';
  readonly createdAt: string;
} & CachePayload;

/**
 * Reads one document as a `cache-1` entry, or returns undefined when it is not a
 * shape this runner can replay. A missing `kind` reads as `locate`, which is what
 * every entry written before path guidance existed looks like.
 */
export function readCacheEntry(document: unknown): CacheEntry | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  if (raw['schemaVersion'] !== 'cache-1') return undefined;
  const payload = raw['payload'];
  if (typeof payload !== 'object' || payload === null) return undefined;
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '';

  if (raw['kind'] === 'path') {
    const actions = readPathActions(payload as Record<string, unknown>);
    if (actions === undefined) return undefined;
    return { schemaVersion: 'cache-1', createdAt, kind: 'path', payload: { type: 'path', actions } };
  }
  if (raw['kind'] !== undefined && raw['kind'] !== 'locate') return undefined;

  const { locator, expected } = payload as Record<string, unknown>;
  const validated = asCacheLocator(locator);
  if (validated === undefined) return undefined;
  const identity = asSemanticIdentity(expected);
  if (identity === undefined) return undefined;

  return {
    schemaVersion: 'cache-1',
    createdAt,
    kind: 'locate',
    payload: { locator: validated, expected: identity },
  };
}

/**
 * Reads a recorded action sequence. One malformed action rejects the whole
 * entry: a path with a hole in it is not the path that succeeded, and following
 * the remainder would run a different flow than the one that was recorded.
 */
function readPathActions(payload: Record<string, unknown>): readonly PathAction[] | undefined {
  if (payload['type'] !== 'path') return undefined;
  const raw = payload['actions'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PATH_ACTIONS) return undefined;
  const actions: PathAction[] = [];
  for (const candidate of raw) {
    const action = asPathAction(candidate);
    if (action === undefined) return undefined;
    actions.push(action);
  }
  return actions;
}
