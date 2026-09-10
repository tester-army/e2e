import { describe, expect, it } from 'vitest';
import { credentialNames } from '../../src/explore/index.ts';

describe('credentialNames', () => {
  it('lists the configured accounts and leaves a malformed value to config resolution', () => {
    expect(credentialNames({ credentials: { ada: { username: 'ada@example.test', password: 'pw' }, bob: { username: 'bob', password: 'pw' } } })).toEqual(['ada', 'bob']);
    expect(credentialNames({})).toEqual([]);
    expect(credentialNames({ credentials: [] as never })).toEqual([]);
  });

  it('rejects an inventory that would not fit a step parameter, before anything starts', () => {
    const credentials = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`account-${String(i)}`, { username: `${'u'.repeat(200)}@example.test`, password: 'pw' }]),
    );
    expect(() => credentialNames({ credentials })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('400 account(s) serialize to') }),
    );
    // A realistic inventory is far under the bound.
    const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`user${String(i)}`, { username: `user${String(i)}@example.test`, password: 'pw' }]));
    expect(credentialNames({ credentials: forty })).toHaveLength(40);
  });
});
