/**
 * `cache-1` path entries: the recorded action wire format and what a runner will
 * refuse to replay.
 *
 * Checked against `spec/schema/cache-v1.schema.json` directly, so an action this
 * runner accepts is always one the standard declares.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { asPathAction, MAX_PATH_ACTIONS } from '../../src/cache/path-action.ts';
import { readCacheEntry } from '../../src/cache/entry.ts';
import { ACTION_SPACE } from '../../src/agent/action-space.ts';
import { storableForNode } from '../../src/agent/storable.ts';
import type { SemanticNode } from '../../src/driver/index.ts';

const SCHEMA = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../../spec/schema/cache-v1.schema.json'),
    'utf8',
  ),
) as object;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const matchesSpec = ajv.compile(SCHEMA);

const LOCATOR = {
  kind: 'query',
  query: {
    kind: 'role',
    value: { kind: 'string', value: 'button', exact: true },
    name: { kind: 'string', value: 'Continue', exact: true },
  },
} as const;

const ACTIONS: readonly Record<string, unknown>[] = [
  { kind: 'tap', target: LOCATOR },
  { kind: 'type', target: LOCATOR, value: 'Acme Inc' },
  { kind: 'type', target: LOCATOR, sensitiveName: 'admin', purpose: 'password' },
  { kind: 'scroll', direction: 'down' },
  { kind: 'scroll', direction: 'up', momentum: 'slow', target: LOCATOR },
  { kind: 'press', key: 'Enter' },
  { kind: 'longPress', target: LOCATOR },
  { kind: 'longPress', target: LOCATOR, durationMs: 500 },
  { kind: 'navigate', url: '/billing' },
];

const entryOf = (actions: readonly unknown[]): Record<string, unknown> => ({
  schemaVersion: 'cache-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'path',
  payload: { type: 'path', actions },
});

describe('cache-1 path actions', () => {
  it('accepts every action the spec declares', () => {
    for (const action of ACTIONS) {
      expect(matchesSpec(entryOf([action])), JSON.stringify(action)).toBe(true);
      expect(asPathAction(action), JSON.stringify(action)).toBeDefined();
    }
  });

  it('refuses an action the spec does not declare', () => {
    for (const action of [
      { kind: 'evaluate', script: '1' },
      { kind: 'tap' },
      { kind: 'tap', target: LOCATOR, extra: 1 },
      { kind: 'press' },
      { kind: 'navigate' },
      { kind: 'scroll', direction: 'sideways' },
      { kind: 'longPress', target: LOCATOR, durationMs: 50 },
      { kind: 'type', target: LOCATOR, value: 'x', sensitiveName: 'admin', purpose: 'password' },
      { kind: 'type', target: LOCATOR, sensitiveName: 'admin', purpose: 'root' },
      { kind: 'observe' },
      { kind: 'conclude', status: 'success' },
    ]) {
      expect(matchesSpec(entryOf([action])), `spec accepts ${JSON.stringify(action)}`).toBe(false);
      expect(asPathAction(action), JSON.stringify(action)).toBeUndefined();
    }
  });

  // Following the remainder of a path with a hole in it runs a different flow
  // than the one that was recorded.
  it('rejects the whole entry when any action is malformed', () => {
    const entry = entryOf([{ kind: 'tap', target: LOCATOR }, { kind: 'evaluate' }]);
    expect(readCacheEntry(entry)).toBeUndefined();
  });

  it('rejects an empty or oversized path', () => {
    expect(readCacheEntry(entryOf([]))).toBeUndefined();
    const many = Array.from({ length: MAX_PATH_ACTIONS + 1 }, () => ({ kind: 'press', key: 'a' }));
    expect(readCacheEntry(entryOf(many))).toBeUndefined();
  });

  it('round-trips a path entry', () => {
    const entry = readCacheEntry(entryOf(ACTIONS));
    expect(entry?.kind).toBe('path');
    expect(entry?.kind === 'path' && entry.payload.actions).toHaveLength(ACTIONS.length);
  });

  // An entry written before path guidance existed carries no kind at all.
  it('still reads a locate entry, with or without a kind', () => {
    const locate = {
      schemaVersion: 'cache-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: { locator: LOCATOR, expected: { role: 'button', name: 'Continue' } },
    };
    expect(readCacheEntry(locate)?.kind).toBe('locate');
    expect(readCacheEntry({ ...locate, kind: 'locate' })?.kind).toBe('locate');
  });
});

describe('recording an action space derivative', () => {
  const node = (over: Partial<SemanticNode> = {}): SemanticNode =>
    ({
      ref: { id: 'n7', revision: 'r1' },
      role: 'button',
      name: 'Continue',
      ...over,
    }) as SemanticNode;

  const locate = (target: SemanticNode) => storableForNode(target, 'data-testid');

  const ARGS: Readonly<Record<string, Record<string, unknown>>> = {
    tap: { target: node() },
    type: { target: node({ role: 'textbox', name: 'Company name' }), value: 'Acme Inc' },
    secretType: {
      target: node({ role: 'textbox', name: 'Password' }),
      sensitiveName: 'admin',
      purpose: 'password',
    },
    scroll: { direction: 'down' },
    press: { key: 'Enter' },
    longPress: { target: node() },
    navigate: { url: '/billing' },
  };

  it('records every action as a spec-legal derivative', () => {
    for (const [name, action] of Object.entries(ACTION_SPACE)) {
      const args = ARGS[name];
      expect(args, `${name} has sample args`).toBeDefined();
      const recorded = action.record?.(args as never, locate);
      expect(recorded, `${name} records something`).toBeDefined();
      expect(matchesSpec(entryOf([recorded])), `${name} is spec-legal`).toBe(true);
      expect(asPathAction(recorded), `${name} reads back`).toEqual(recorded);
    }
  });

  it('never records a secret value, only its name and purpose', () => {
    const recorded = ACTION_SPACE['secretType']?.record?.(ARGS['secretType'] as never, locate);
    expect(JSON.stringify(recorded)).not.toContain('hunter');
    expect(recorded).toMatchObject({ sensitiveName: 'admin', purpose: 'password' });
    expect(recorded && 'value' in recorded).toBe(false);
  });

  // A node with no role, name, or selector cannot be re-found, and storing
  // something that resolves elsewhere is the one thing the cache may not do.
  it('declines to record a node it cannot address', () => {
    const anonymous = { ref: { id: 'n9', revision: 'r1' } } as SemanticNode;
    expect(storableForNode(anonymous, 'data-testid')).toBeUndefined();
    expect(ACTION_SPACE['tap']?.record?.({ target: anonymous } as never, locate)).toBeUndefined();
  });
});
