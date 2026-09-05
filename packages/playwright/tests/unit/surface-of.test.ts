/**
 * `surfaceOf` hands agent-side code the live page and context behind a
 * `playwright()` handle, and nothing for any other backend. Without an
 * attempt there is nothing live, so both accessors refuse with INVALID_STATE.
 */

import { describe, expect, it } from 'vitest';
import { BackendError, defineBackend } from '@e2edev/e2e/backend';
import { playwright, surfaceOf } from '../../src/index.ts';

describe('surfaceOf', () => {
  it('returns a live surface for a playwright handle and undefined for a foreign one', () => {
    const handle = playwright();
    expect(surfaceOf(handle)).toBeDefined();
    const other = defineBackend({ name: 'other', version: '1', spiVersion: 1 });
    expect(surfaceOf(other)).toBeUndefined();
  });

  it('refuses the page and the context before an attempt is running', () => {
    const live = surfaceOf(playwright());
    expect(live).toBeDefined();
    for (const read of [() => live?.context(), () => live?.page()]) {
      try {
        read();
        throw new Error('expected INVALID_STATE');
      } catch (error) {
        expect(error).toBeInstanceOf(BackendError);
        expect((error as BackendError).code).toBe('INVALID_STATE');
      }
    }
  });
});
