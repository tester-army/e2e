/**
 * `cache-1` entry parsing (spec 13-reporting.md "cache-1").
 *
 * Every entry read from disk is untrusted repository input, so parsing is
 * closed: unknown fields, wrong types, and any shape outside the schema are
 * rejected rather than coerced. Schema validity is necessary but not
 * sufficient — the caller additionally recomputes the key digest and compares
 * the whole key before replay.
 */

import type { QueryKind, TextPattern } from '../driver/index.ts';
import { CACHE_METHODS, type CacheKey, type CacheMethod } from './identity.ts';
import { validateRegexp, type CacheLocator, type CacheQuery, type SemanticIdentity } from './locator.ts';

export interface LocatePayload {
  readonly type: 'locate';
  readonly locator: CacheLocator;
  readonly expected: SemanticIdentity;
}

export interface CacheEntry {
  readonly schemaVersion: 'cache-1';
  readonly kind: 'locate';
  readonly key: CacheKey;
  readonly keyHash: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly payload: LocatePayload;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const QUERY_KINDS: ReadonlySet<string> = new Set<QueryKind>([
  'role',
  'label',
  'placeholder',
  'text',
  'displayValue',
  'testId',
]);

const QUERY_STATES: ReadonlySet<string> = new Set([
  'checked',
  'disabled',
  'selected',
  'expanded',
  'hidden',
]);

const KEY_FIELDS: ReadonlySet<string> = new Set([
  'specVersion',
  'cacheSchema',
  'project',
  'testId',
  'targetId',
  'platform',
  'driverId',
  'driverVersion',
  'driverSpiVersion',
  'method',
  'callIndex',
  'instructionDigest',
  'inputDigest',
  'appIdentity',
  'screenFingerprint',
  'policyVersion',
]);

/** Thrown internally to carry the first rejection reason out of a deep parse. */
class RejectedEntry extends Error {}

export type ParsedEntry =
  | { readonly ok: true; readonly value: CacheEntry }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses one untrusted document into a `cache-1` locate entry. `path` entries
 * are a valid schema shape but have no producer or consumer yet, so they are
 * reported as unsupported rather than silently ignored.
 */
export function parseCacheEntry(document: unknown): ParsedEntry {
  try {
    return { ok: true, value: entry(document) };
  } catch (cause) {
    if (cause instanceof RejectedEntry) return { ok: false, reason: cause.message };
    throw cause;
  }
}

function entry(value: unknown): CacheEntry {
  const raw = object(value, 'entry');
  closed(raw, 'entry', [
    'schemaVersion',
    'kind',
    'key',
    'keyHash',
    'generation',
    'createdAt',
    'payload',
    'extensions',
  ]);
  if (raw['schemaVersion'] !== 'cache-1') reject('schemaVersion must be "cache-1"');
  const kind = raw['kind'];
  if (kind === 'path') reject('path entries are not supported by this runner yet');
  if (kind !== 'locate') reject('kind must be "locate"');
  const generation = raw['generation'];
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    reject('generation must be an integer of at least 1');
  }
  const createdAt = string(raw['createdAt'], 'createdAt');
  if (!TIMESTAMP.test(createdAt)) {
    reject('createdAt must be an RFC 3339 UTC timestamp with millisecond precision');
  }
  return {
    schemaVersion: 'cache-1',
    kind: 'locate',
    key: key(raw['key']),
    keyHash: digest(raw['keyHash'], 'keyHash'),
    generation: generation as number,
    createdAt,
    payload: locatePayload(raw['payload']),
  };
}

function key(value: unknown): CacheKey {
  const raw = object(value, 'key');
  closed(raw, 'key', [...KEY_FIELDS]);
  for (const field of KEY_FIELDS) {
    if (!(field in raw)) reject(`key.${field} is required`);
  }
  if (raw['specVersion'] !== '0.1') reject('key.specVersion must be "0.1"');
  if (raw['cacheSchema'] !== 'cache-1') reject('key.cacheSchema must be "cache-1"');
  if (raw['driverSpiVersion'] !== 1) reject('key.driverSpiVersion must be 1');
  const method = raw['method'];
  if (typeof method !== 'string' || !(CACHE_METHODS as readonly string[]).includes(method)) {
    reject(`key.method "${String(method)}" is not a cacheable method`);
  }
  const callIndex = raw['callIndex'];
  if (!Number.isSafeInteger(callIndex) || (callIndex as number) < 0) {
    reject('key.callIndex must be a nonnegative integer');
  }
  const policyVersion = string(raw['policyVersion'], 'key.policyVersion');
  if (policyVersion.length < 1 || policyVersion.length > 128) {
    reject('key.policyVersion must be 1 through 128 characters');
  }
  return {
    specVersion: '0.1',
    cacheSchema: 'cache-1',
    project: digest(raw['project'], 'key.project'),
    testId: nonEmpty(raw['testId'], 'key.testId'),
    targetId: nonEmpty(raw['targetId'], 'key.targetId'),
    platform: nonEmpty(raw['platform'], 'key.platform'),
    driverId: nonEmpty(raw['driverId'], 'key.driverId'),
    driverVersion: nonEmpty(raw['driverVersion'], 'key.driverVersion'),
    driverSpiVersion: 1,
    method: method as CacheMethod,
    callIndex: callIndex as number,
    instructionDigest: digest(raw['instructionDigest'], 'key.instructionDigest'),
    inputDigest: digest(raw['inputDigest'], 'key.inputDigest'),
    appIdentity: digest(raw['appIdentity'], 'key.appIdentity'),
    screenFingerprint: digest(raw['screenFingerprint'], 'key.screenFingerprint'),
    policyVersion,
  };
}

function locatePayload(value: unknown): LocatePayload {
  const raw = object(value, 'payload');
  closed(raw, 'payload', ['type', 'locator', 'expected']);
  if (raw['type'] !== 'locate') reject('payload.type must be "locate"');
  return {
    type: 'locate',
    locator: locator(raw['locator'], 'payload.locator'),
    expected: expected(raw['expected']),
  };
}

function expected(value: unknown): SemanticIdentity {
  const raw = object(value, 'payload.expected');
  closed(raw, 'payload.expected', ['role', 'name', 'states']);
  const role = nonEmpty(raw['role'], 'payload.expected.role');
  const name = raw['name'] === undefined ? undefined : string(raw['name'], 'payload.expected.name');
  const states =
    raw['states'] === undefined ? undefined : booleanMap(raw['states'], 'payload.expected.states');
  return {
    role,
    ...(name === undefined ? {} : { name }),
    ...(states === undefined ? {} : { states }),
  };
}

function locator(value: unknown, path: string): CacheLocator {
  const raw = object(value, path);
  switch (raw['kind']) {
    case 'query': {
      closed(raw, path, ['kind', 'query', 'scope']);
      const scope = raw['scope'] === undefined ? undefined : locator(raw['scope'], `${path}.scope`);
      return {
        kind: 'query',
        query: query(raw['query'], `${path}.query`),
        ...(scope === undefined ? {} : { scope }),
      };
    }
    case 'filter': {
      closed(raw, path, ['kind', 'source', 'hasText', 'has']);
      const hasText =
        raw['hasText'] === undefined ? undefined : pattern(raw['hasText'], `${path}.hasText`);
      const has = raw['has'] === undefined ? undefined : locator(raw['has'], `${path}.has`);
      if (hasText === undefined && has === undefined) {
        reject(`${path} must constrain by hasText or has`);
      }
      return {
        kind: 'filter',
        source: locator(raw['source'], `${path}.source`),
        ...(hasText === undefined ? {} : { hasText }),
        ...(has === undefined ? {} : { has }),
      };
    }
    case 'index': {
      closed(raw, path, ['kind', 'source', 'index']);
      const index = raw['index'];
      const valid =
        index === 'first' ||
        index === 'last' ||
        (Number.isSafeInteger(index) && (index as number) >= 0);
      if (!valid) reject(`${path}.index must be a nonnegative integer, "first", or "last"`);
      return {
        kind: 'index',
        source: locator(raw['source'], `${path}.source`),
        index: index as number | 'first' | 'last',
      };
    }
    default:
      return reject(`${path}.kind "${String(raw['kind'])}" is not a cacheable locator`);
  }
}

function query(value: unknown, path: string): CacheQuery {
  const raw = object(value, path);
  closed(raw, path, ['kind', 'value', 'name', 'states']);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !QUERY_KINDS.has(kind)) {
    reject(`${path}.kind "${String(kind)}" is not a query kind`);
  }
  const name = raw['name'] === undefined ? undefined : pattern(raw['name'], `${path}.name`);
  const states = raw['states'] === undefined ? undefined : queryStates(raw['states'], path);
  return {
    kind: kind as QueryKind,
    value: pattern(raw['value'], `${path}.value`),
    ...(name === undefined ? {} : { name }),
    ...(states === undefined ? {} : { states }),
  };
}

function queryStates(value: unknown, path: string): Readonly<Record<string, boolean>> {
  const raw = booleanMap(value, `${path}.states`);
  for (const name of Object.keys(raw)) {
    if (!QUERY_STATES.has(name)) reject(`${path}.states has unknown state "${name}"`);
  }
  return raw;
}

function pattern(value: unknown, path: string): TextPattern {
  const raw = object(value, path);
  if (raw['kind'] === 'string') {
    closed(raw, path, ['kind', 'value', 'exact']);
    if (typeof raw['exact'] !== 'boolean') reject(`${path}.exact must be a boolean`);
    return { kind: 'string', value: string(raw['value'], `${path}.value`), exact: raw['exact'] };
  }
  if (raw['kind'] === 'regexp') {
    closed(raw, path, ['kind', 'source', 'flags']);
    const source = string(raw['source'], `${path}.source`);
    const flags = string(raw['flags'], `${path}.flags`);
    const invalid = validateRegexp(source, flags);
    if (invalid !== undefined) reject(`${path}: ${invalid}`);
    return { kind: 'regexp', source, flags };
  }
  return reject(`${path}.kind must be "string" or "regexp"`);
}

function booleanMap(value: unknown, path: string): Readonly<Record<string, boolean>> {
  const raw = object(value, path);
  const out: Record<string, boolean> = {};
  for (const [name, entryValue] of Object.entries(raw)) {
    if (typeof entryValue !== 'boolean') reject(`${path}.${name} must be a boolean`);
    out[name] = entryValue as boolean;
  }
  return out;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Rejects any field outside the schema, so unknown core fields never pass. */
function closed(raw: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const name of Object.keys(raw)) {
    if (!allowed.includes(name)) reject(`${path} has unknown field "${name}"`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') reject(`${path} must be a string`);
  return value as string;
}

function nonEmpty(value: unknown, path: string): string {
  const raw = string(value, path);
  if (raw === '') reject(`${path} must not be empty`);
  return raw;
}

function digest(value: unknown, path: string): string {
  const raw = string(value, path);
  if (!SHA256.test(raw)) reject(`${path} must be a lowercase SHA-256 hex digest`);
  return raw;
}

function reject(reason: string): never {
  throw new RejectedEntry(reason);
}
