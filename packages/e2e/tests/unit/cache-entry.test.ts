/** Reading a `cache-1` locate entry (spec 13-reporting.md, CACHE-SCHEMA-001). */

import { describe, expect, it } from 'vitest';
import { readCacheEntry } from '../../src/cache/index.ts';
import { specFixture } from '../helpers/cache-schema.ts';

const valid = specFixture('cache-v1.valid.json') as Record<string, unknown>;

/** Deep-clones the canonical fixture and applies one mutation. */
function mutated(mutate: (document: Record<string, any>) => void): Record<string, unknown> {
  const clone = structuredClone(valid) as Record<string, any>;
  mutate(clone);
  return clone;
}

describe('the canonical fixture', () => {
  it('reads back as a replayable entry', () => {
    const entry = readCacheEntry(valid);
    expect(entry).toBeDefined();
    expect(entry!.schemaVersion).toBe('cache-1');
    expect(entry!.payload.locator.kind).toBe('query');
    expect(entry!.payload.expected).toEqual({ role: 'button', name: 'Save' });
  });

  it('rejects the spec invalid fixture', () => {
    expect(readCacheEntry(specFixture('cache-v1.invalid.json'))).toBeUndefined();
  });
});

describe('version and kind pinning', () => {
  it('rejects a schema version this runner does not implement', () => {
    expect(readCacheEntry(mutated((d) => (d.schemaVersion = 'cache-2')))).toBeUndefined();
    expect(readCacheEntry(mutated((d) => delete d.schemaVersion))).toBeUndefined();
  });

  it('rejects a path entry, which has no consumer here yet', () => {
    expect(readCacheEntry(mutated((d) => (d.kind = 'path')))).toBeUndefined();
  });
});

describe('only the replayable parts are required', () => {
  it('rejects an entry whose locator is not admissible', () => {
    expect(
      readCacheEntry(mutated((d) => (d.payload.locator = { kind: 'frame', selector: 'iframe', source: {} }))),
    ).toBeUndefined();
    expect(readCacheEntry(mutated((d) => delete d.payload.locator))).toBeUndefined();
  });

  it('rejects an entry with no expected role', () => {
    expect(readCacheEntry(mutated((d) => (d.payload.expected = {})))).toBeUndefined();
    expect(readCacheEntry(mutated((d) => delete d.payload.expected))).toBeUndefined();
  });

  it('rejects a missing or non-object payload', () => {
    for (const payload of [undefined, null, 'x', 7]) {
      expect(readCacheEntry(mutated((d) => (d.payload = payload)))).toBeUndefined();
    }
  });

  it('rejects a document that is not an object', () => {
    for (const document of [null, undefined, 'x', 7, [valid]]) {
      expect(readCacheEntry(document)).toBeUndefined();
    }
  });

  it('tolerates anything else, because nothing else can affect replay', () => {
    // A foreign producer's extra fields, a missing timestamp, or a stale
    // bookkeeping field must not throw away an otherwise usable locator.
    expect(readCacheEntry(mutated((d) => (d.vendorExtension = { anything: true })))).toBeDefined();
    expect(readCacheEntry(mutated((d) => delete d.createdAt))).toBeDefined();
    expect(readCacheEntry(mutated((d) => (d.createdAt = 'not a timestamp')))).toBeDefined();
  });
});
