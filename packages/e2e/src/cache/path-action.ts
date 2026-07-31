/**
 * `cache-1` path actions (spec/schema/cache-v1.schema.json `toolAction`).
 *
 * A recorded action is a normalized derivative of a successful `agent-tool-1`
 * call: the revision-bound node ref is replaced by a semantic locator and the
 * protocol envelope is dropped. It carries semantic targets and non-secret
 * values only, and no arbitrary options — a sensitive fill records the secret's
 * name and purpose, never its value.
 *
 * There is deliberately no recorded identity to check a replayed target against.
 * Guidance is advisory: the agent sees a fresh observation and decides whether
 * the next recorded action still applies (10-determinism.md), so a locator that
 * no longer resolves costs a discarded suggestion rather than a wrong action.
 *
 * This module owns the wire shape in both directions and nothing else. The
 * agent-side concerns of one action — how it is dispatched, how it is recorded,
 * how it reads back as a hint — all live on its single entry in
 * `agent/action-space.ts`. The bounds below are exported for that reason: the
 * writer and the reader of the same field must not each carry their own number.
 */

import { asRecord, boundedString, closedRecord } from '../internal/json.ts';
import type { Secret } from '../types.ts';
import { asCacheLocator, type CacheLocator } from './locator.ts';

export type PathActionKind = 'tap' | 'type' | 'scroll' | 'press' | 'longPress' | 'navigate';

export type ScrollPathDirection = 'up' | 'down' | 'left' | 'right';
export type ScrollPathMomentum = 'none' | 'slow' | 'fast';

export type PathAction =
  | { readonly kind: 'tap'; readonly target: CacheLocator }
  | { readonly kind: 'type'; readonly target: CacheLocator }
  | {
      readonly kind: 'type';
      readonly target: CacheLocator;
      readonly sensitiveName: string;
      readonly purpose: Secret['purpose'];
    }
  | {
      readonly kind: 'scroll';
      readonly direction: ScrollPathDirection;
      readonly momentum?: ScrollPathMomentum;
      readonly target?: CacheLocator;
    }
  | { readonly kind: 'press'; readonly key: string }
  | {
      readonly kind: 'longPress';
      readonly target: CacheLocator;
      readonly durationMs?: number;
    }
  | { readonly kind: 'navigate'; readonly url: string };

/** Recorded actions per entry, per the spec's `maxItems`. */
export const MAX_PATH_ACTIONS = 100;

/**
 * Field bounds of the recorded action shape, mirroring the spec schema.
 *
 * The single source for both directions: `agent/action-space.ts` declares the
 * same fields to the model against these, so a value a model may send is by
 * construction a value the cache can read back.
 */
export const PATH_LIMITS = {
  sensitiveName: 128,
  key: 128,
  url: 8_192,
  /** Plain typed text, which is bounded for the model but never recorded. */
  value: 65_536,
  longPressMs: { min: 100, max: 10_000 },
} as const;

export const SECRET_PURPOSES = ['password', 'one-time-code', 'generic-secret'] as const;
export const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export const SCROLL_MOMENTUMS = ['none', 'slow', 'fast'] as const;

const PURPOSES = new Set<string>(SECRET_PURPOSES);
const DIRECTIONS = new Set<string>(SCROLL_DIRECTIONS);
const MOMENTUMS = new Set<string>(SCROLL_MOMENTUMS);

/** Per-kind readers, so a new `PathActionKind` cannot compile without one. */
const READERS: {
  readonly [K in PathActionKind]: (raw: Record<string, unknown>) => PathAction | undefined;
} = {
  tap: (raw) => {
    if (!closedRecord(raw, ['kind', 'target'])) return undefined;
    const target = asCacheLocator(raw['target']);
    return target === undefined ? undefined : { kind: 'tap', target };
  },
  type: (raw) => {
    // A plain fill records only its target. The literal it typed is not stored,
    // so the two fills are told apart by the secret's name rather than a value.
    if (raw['sensitiveName'] === undefined && raw['purpose'] === undefined) {
      if (!closedRecord(raw, ['kind', 'target'])) return undefined;
      const target = asCacheLocator(raw['target']);
      return target === undefined ? undefined : { kind: 'type', target };
    }
    if (!closedRecord(raw, ['kind', 'target', 'sensitiveName', 'purpose'])) return undefined;
    const target = asCacheLocator(raw['target']);
    const sensitiveName = boundedString(raw['sensitiveName'], 1, PATH_LIMITS.sensitiveName);
    const purpose = raw['purpose'];
    if (target === undefined || sensitiveName === undefined) return undefined;
    if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return undefined;
    return { kind: 'type', target, sensitiveName, purpose: purpose as Secret['purpose'] };
  },
  scroll: (raw) => {
    if (!closedRecord(raw, ['kind', 'direction', 'momentum', 'target'])) return undefined;
    const direction = raw['direction'];
    if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) return undefined;
    const momentum = raw['momentum'];
    if (momentum !== undefined && (typeof momentum !== 'string' || !MOMENTUMS.has(momentum))) {
      return undefined;
    }
    let target: CacheLocator | undefined;
    if (raw['target'] !== undefined) {
      target = asCacheLocator(raw['target']);
      if (target === undefined) return undefined;
    }
    return {
      kind: 'scroll',
      direction: direction as ScrollPathDirection,
      ...(momentum === undefined ? {} : { momentum: momentum as ScrollPathMomentum }),
      ...(target === undefined ? {} : { target }),
    };
  },
  press: (raw) => {
    if (!closedRecord(raw, ['kind', 'key'])) return undefined;
    const key = boundedString(raw['key'], 1, PATH_LIMITS.key);
    return key === undefined ? undefined : { kind: 'press', key };
  },
  longPress: (raw) => {
    if (!closedRecord(raw, ['kind', 'target', 'durationMs'])) return undefined;
    const target = asCacheLocator(raw['target']);
    if (target === undefined) return undefined;
    const durationMs = raw['durationMs'];
    if (durationMs === undefined) return { kind: 'longPress', target };
    const { min, max } = PATH_LIMITS.longPressMs;
    if (
      typeof durationMs !== 'number' ||
      !Number.isInteger(durationMs) ||
      durationMs < min ||
      durationMs > max
    ) {
      return undefined;
    }
    return { kind: 'longPress', target, durationMs };
  },
  navigate: (raw) => {
    if (!closedRecord(raw, ['kind', 'url'])) return undefined;
    const url = boundedString(raw['url'], 1, PATH_LIMITS.url);
    return url === undefined ? undefined : { kind: 'navigate', url };
  },
};

/**
 * Reads one recorded action, or undefined when it is not a shape this runner can
 * replay. A malformed action makes the whole entry a miss rather than being
 * skipped: a path with a hole in it is not the path that succeeded.
 */
export function asPathAction(value: unknown): PathAction | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(READERS, kind)) return undefined;
  return READERS[kind as PathActionKind](raw);
}
