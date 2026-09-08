/** Path comparison for the replay postcondition: exact, or the same shape up to minted ids. */

import { describe, expect, it } from 'vitest';
import { samePathShape, samePathname } from '../../src/cache/decide.ts';

describe('samePathShape', () => {
  it('accepts the same pathname, query aside', () => {
    expect(samePathShape('/projects', '/projects?tab=tests')).toBe(true);
    expect(samePathname('/projects', '/projects?tab=tests')).toBe(true);
  });

  it('accepts a minted id in place of another', () => {
    expect(
      samePathShape('/dashboard/e2e-45961c4c/projects/a77c12665e90', '/dashboard/e2e-45961c4c/projects/0c1d2e3f4a5b'),
    ).toBe(true);
    expect(
      samePathShape('/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/runs/9c858901-8a57-4791-81fe-4c455b099bc9'),
    ).toBe(true);
    expect(samePathShape('/orders/48213', '/orders/48901')).toBe(true);
    expect(samePathShape('/projects/h6oOdrnB-LwS', '/projects/abcdEFGHijkl')).toBe(true);
  });

  it('never takes a plain word for a minted id', () => {
    expect(samePathShape('/projects/integrations', '/projects/testaccounts')).toBe(false);
    expect(samePathShape('/projects/h6oOdrnB-LwS', '/projects/integrations')).toBe(false);
  });

  it('rejects a differing segment that is not minted on both sides', () => {
    expect(samePathShape('/projects/a77c12665e90', '/projects/new')).toBe(false);
    expect(samePathShape('/settings/general', '/settings/members')).toBe(false);
    expect(samePathShape('/projects/a77c12665e90', '/customers/a77c12665e90')).toBe(false);
  });

  it('rejects a different depth', () => {
    expect(samePathShape('/projects/a77c12665e90', '/projects/a77c12665e90/tests')).toBe(false);
    expect(samePathShape('/projects', '/projects/a77c12665e90')).toBe(false);
  });
});
