/** Path comparison for the replay precondition and postcondition: exact, or the same shape up to minted ids. */

import { describe, expect, it } from 'vitest';
import { decideTraceReplay, samePathShape, samePathname } from '../../src/cache/decide.ts';
import { buildTraceEntry, type TraceEntry } from '../../src/cache/trace.ts';

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

describe('decideTraceReplay', () => {
  const entry = (startPath: string, first: 'tap' | 'navigate' = 'tap'): TraceEntry =>
    buildTraceEntry({
      actions:
        first === 'navigate'
          ? [{ name: 'navigate', summary: 'navigate to "/companies"', url: '/companies' }]
          : [{ name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } }],
      executor: { name: 'test' },
      summary: 'saved',
      startPath,
    });

  it('replays on the page the recording began on, up to the id the app minted for the record', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, '/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(recorded, '/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07?tab=notes')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/backend/sales/documents/01dbf481-05ee-4522-ba14-f91737953533?kind=quote'), '/backend/sales/documents/f08b47d3-7fda-43c3-a2e3-09f5c365fb44?kind=quote')).toEqual({ action: 'replay' });
  });

  it('still misses on another page, and on a plain word in place of another', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, '/backend/customers/people-v2/8374a7a7-a64a-422d-9183-4350756c7f07')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/settings/billing'), '/settings/members')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(recorded, undefined)).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('needs no starting point when the recording opens with a navigate', () => {
    expect(decideTraceReplay(entry('/anywhere', 'navigate'), '/elsewhere')).toEqual({ action: 'replay' });
  });
});
