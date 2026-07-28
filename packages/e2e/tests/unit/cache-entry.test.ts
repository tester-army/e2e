/** Untrusted cache-1 parsing (spec 13-reporting.md, CACHE-SCHEMA-001). */

import { describe, expect, it } from 'vitest';
import { parseCacheEntry } from '../../src/cache/index.ts';
import { assertValidCacheEntry, isValidCacheEntry, specFixture } from '../helpers/cache-schema.ts';

const valid = specFixture('cache-v1.valid.json') as Record<string, unknown>;

/** Deep-clones the canonical fixture and applies one mutation. */
function mutated(mutate: (document: Record<string, any>) => void): Record<string, unknown> {
  const clone = structuredClone(valid) as Record<string, any>;
  mutate(clone);
  return clone;
}

function reason(document: unknown): string {
  const parsed = parseCacheEntry(document);
  if (parsed.ok) throw new Error('expected the entry to be rejected');
  return parsed.reason;
}

describe('canonical fixtures', () => {
  it('accepts the spec valid fixture', () => {
    assertValidCacheEntry(valid);
    expect(parseCacheEntry(valid).ok).toBe(true);
  });

  it('rejects the spec invalid fixture', () => {
    const invalid = specFixture('cache-v1.invalid.json');
    expect(isValidCacheEntry(invalid)).toBe(false);
    expect(parseCacheEntry(invalid).ok).toBe(false);
  });
});

describe('the parser is closed', () => {
  it('rejects an unknown core field at the top level', () => {
    expect(reason(mutated((d) => (d['exec'] = 'rm -rf /')))).toContain('unknown field "exec"');
  });

  it('rejects an unknown key field', () => {
    expect(reason(mutated((d) => (d.key['extra'] = 1)))).toContain('unknown field "extra"');
  });

  it('rejects an unknown payload field', () => {
    expect(reason(mutated((d) => (d.payload['script'] = 'x')))).toContain('unknown field "script"');
  });

  it('rejects a missing key field', () => {
    expect(reason(mutated((d) => delete d.key['screenFingerprint']))).toContain(
      'key.screenFingerprint is required',
    );
  });
});

describe('no executable or free-form guidance is accepted', () => {
  it('rejects a raw web selector as a locator', () => {
    const document = mutated((d) => {
      d.payload.locator = { kind: 'web-selector', selector: '#buy' };
    });
    expect(isValidCacheEntry(document)).toBe(false);
    expect(reason(document)).toContain('not a cacheable locator');
  });

  it('rejects a frame locator', () => {
    const document = mutated((d) => {
      d.payload.locator = { kind: 'frame', selector: 'iframe', source: d.payload.locator };
    });
    expect(reason(document)).toContain('not a cacheable locator');
  });

  it('rejects an unknown query kind', () => {
    expect(reason(mutated((d) => (d.payload.locator.query.kind = 'xpath')))).toContain(
      'is not a query kind',
    );
  });

  it('rejects an unknown node state', () => {
    expect(reason(mutated((d) => (d.payload.locator.query.states = { focused: true })))).toContain(
      'unknown state "focused"',
    );
  });

  it('rejects a path entry, which has no consumer yet', () => {
    const document = mutated((d) => {
      d.kind = 'path';
      d.payload = { type: 'path', actions: [] };
    });
    expect(reason(document)).toContain('path entries are not supported');
  });
});

describe('version and type pinning', () => {
  it('rejects a foreign schema version', () => {
    expect(reason(mutated((d) => (d.schemaVersion = 'cache-2')))).toContain('cache-1');
  });

  it('rejects a foreign spec version', () => {
    expect(reason(mutated((d) => (d.key.specVersion = '0.2')))).toContain('specVersion');
  });

  it('rejects a foreign driver SPI version', () => {
    expect(reason(mutated((d) => (d.key.driverSpiVersion = 2)))).toContain('driverSpiVersion');
  });

  it('rejects a method outside the cacheable enum', () => {
    expect(reason(mutated((d) => (d.key.method = 'press')))).toContain('not a cacheable method');
  });

  it('rejects a malformed digest', () => {
    expect(reason(mutated((d) => (d.key.project = 'NOTHEX')))).toContain('SHA-256');
    expect(reason(mutated((d) => (d.key.project = 'A'.repeat(64))))).toContain('SHA-256');
  });

  it('rejects a generation below one', () => {
    expect(reason(mutated((d) => (d.generation = 0)))).toContain('at least 1');
  });

  it('rejects a non-integer call index', () => {
    expect(reason(mutated((d) => (d.key.callIndex = 1.5)))).toContain('nonnegative integer');
  });

  it('rejects a timestamp without millisecond precision', () => {
    expect(reason(mutated((d) => (d.createdAt = '2026-07-24T12:00:00Z')))).toContain('createdAt');
  });
});

describe('regexp ceilings apply to untrusted input', () => {
  it('rejects an oversized source', () => {
    const document = mutated((d) => {
      d.payload.locator.query.value = { kind: 'regexp', source: 'a'.repeat(2000), flags: '' };
    });
    expect(reason(document)).toContain('over the');
  });

  it('rejects mutually exclusive flags', () => {
    const document = mutated((d) => {
      d.payload.locator.query.value = { kind: 'regexp', source: 'a', flags: 'uv' };
    });
    expect(isValidCacheEntry(document)).toBe(false);
    expect(reason(document)).toContain('mutually exclusive');
  });
});

describe('structural hostility', () => {
  it('rejects a non-object document', () => {
    for (const document of [null, 42, 'x', [], true]) {
      expect(parseCacheEntry(document).ok).toBe(false);
    }
  });

  it('rejects a prototype-pollution attempt without following it', () => {
    // Entries arrive through JSON.parse, where "__proto__" becomes a real own
    // property rather than setting the prototype, so the closed field check is
    // what has to catch it.
    const document = JSON.parse(
      JSON.stringify(valid).replace('"expected":{', '"expected":{"__proto__":{"polluted":true},'),
    );
    expect(Object.keys(document.payload.expected)).toContain('__proto__');
    expect(reason(document)).toContain('unknown field "__proto__"');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not stack-overflow on a deeply nested locator', () => {
    const document = mutated((d) => {
      let locator: Record<string, unknown> = d.payload.locator;
      for (let depth = 0; depth < 2_000; depth += 1) {
        locator = { kind: 'index', source: locator, index: 0 };
      }
      d.payload.locator = locator;
    });
    // Either outcome is acceptable; silently accepting an unbounded structure
    // is not, and neither is crashing the runner.
    expect(() => parseCacheEntry(document)).not.toThrow();
  });
});
