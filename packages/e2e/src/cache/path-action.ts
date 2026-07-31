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
 */

import type { Secret } from '../types.ts';
import { asCacheLocator, type CacheLocator } from './locator.ts';

export type PathActionKind = 'tap' | 'type' | 'scroll' | 'press' | 'longPress' | 'navigate';

export type PathAction =
  | { readonly kind: 'tap'; readonly target: CacheLocator }
  | { readonly kind: 'type'; readonly target: CacheLocator; readonly value: string }
  | {
      readonly kind: 'type';
      readonly target: CacheLocator;
      readonly sensitiveName: string;
      readonly purpose: Secret['purpose'];
    }
  | {
      readonly kind: 'scroll';
      readonly direction: 'up' | 'down' | 'left' | 'right';
      readonly momentum?: 'none' | 'slow' | 'fast';
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

const VALUE_MAX = 65_536;
const SENSITIVE_NAME_MAX = 128;
const KEY_MAX = 128;
const URL_MAX = 8192;

const PURPOSES = new Set<string>(['password', 'one-time-code', 'generic-secret']);
const DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right']);
const MOMENTUMS = new Set<string>(['none', 'slow', 'fast']);

/**
 * Reads one recorded action, or undefined when it is not a shape this runner can
 * replay. A malformed action makes the whole entry a miss rather than being
 * skipped: a path with a hole in it is not the path that succeeded.
 */
export function asPathAction(value: unknown): PathAction | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  switch (raw['kind']) {
    case 'tap': {
      const target = closed(raw, ['kind', 'target']) ? asCacheLocator(raw['target']) : undefined;
      return target === undefined ? undefined : { kind: 'tap', target };
    }
    case 'type':
      return asTypeAction(raw);
    case 'scroll':
      return asScrollAction(raw);
    case 'press': {
      if (!closed(raw, ['kind', 'key'])) return undefined;
      const key = boundedString(raw['key'], 1, KEY_MAX);
      return key === undefined ? undefined : { kind: 'press', key };
    }
    case 'longPress':
      return asLongPressAction(raw);
    case 'navigate': {
      if (!closed(raw, ['kind', 'url'])) return undefined;
      const url = boundedString(raw['url'], 1, URL_MAX);
      return url === undefined ? undefined : { kind: 'navigate', url };
    }
    default:
      return undefined;
  }
}

function asTypeAction(raw: Record<string, unknown>): PathAction | undefined {
  if (raw['value'] !== undefined) {
    if (!closed(raw, ['kind', 'target', 'value'])) return undefined;
    const target = asCacheLocator(raw['target']);
    const value = boundedString(raw['value'], 0, VALUE_MAX);
    if (target === undefined || value === undefined) return undefined;
    return { kind: 'type', target, value };
  }
  if (!closed(raw, ['kind', 'target', 'sensitiveName', 'purpose'])) return undefined;
  const target = asCacheLocator(raw['target']);
  const sensitiveName = boundedString(raw['sensitiveName'], 1, SENSITIVE_NAME_MAX);
  const purpose = raw['purpose'];
  if (target === undefined || sensitiveName === undefined) return undefined;
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return undefined;
  return { kind: 'type', target, sensitiveName, purpose: purpose as Secret['purpose'] };
}

function asScrollAction(raw: Record<string, unknown>): PathAction | undefined {
  if (!closed(raw, ['kind', 'direction', 'momentum', 'target'])) return undefined;
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
    direction: direction as 'up' | 'down' | 'left' | 'right',
    ...(momentum === undefined ? {} : { momentum: momentum as 'none' | 'slow' | 'fast' }),
    ...(target === undefined ? {} : { target }),
  };
}

function asLongPressAction(raw: Record<string, unknown>): PathAction | undefined {
  if (!closed(raw, ['kind', 'target', 'durationMs'])) return undefined;
  const target = asCacheLocator(raw['target']);
  if (target === undefined) return undefined;
  const durationMs = raw['durationMs'];
  if (durationMs === undefined) return { kind: 'longPress', target };
  if (
    typeof durationMs !== 'number' ||
    !Number.isInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 10_000
  ) {
    return undefined;
  }
  return { kind: 'longPress', target, durationMs };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** True when the record carries no key outside the allowed set. */
function closed(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length < min || value.length > max) return undefined;
  return value;
}
