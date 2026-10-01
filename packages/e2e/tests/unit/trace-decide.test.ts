/** The replay precondition: the screen the recording began on, as a route. */

import { describe, expect, it } from 'vitest';
import { decideTraceReplay } from '../../src/cache/decide.ts';
import { buildTraceEntry, type TraceEntry } from '../../src/cache/trace.ts';

function entry(startPath: string, first: 'tap' | 'navigate' = 'tap'): TraceEntry {
  return buildTraceEntry({
    actions:
      first === 'navigate'
        ? [{ name: 'navigate', summary: 'navigate to "/companies"', url: '/companies' }]
        : [{ name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } }],
    executor: { name: 'test' },
    summary: 'saved',
    startPath,
  });
}

describe('decideTraceReplay', () => {
  it('replays on the same route, whatever the record id or the fragment', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, '/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(recorded, '/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07#top')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/companies?id=42'), '/companies?id=7')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/orders/42'), '/orders/43917')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/#/orders/42'), '/#/orders/7')).toEqual({ action: 'replay' });
  });

  it('misses on another route, on a slug it cannot tell from a route word, and without a location', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, '/backend/customers/people-v2/8374a7a7-a64a-422d-9183-4350756c7f07')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/settings/billing'), '/settings/members')).toEqual({ action: 'miss', reason: 'wrong-context' });
    // Nothing recorded at the start is specific to the screen, so an undecided route is another screen.
    expect(decideTraceReplay(entry('/products/summer-sneaker'), '/products/winter-boot')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(recorded, undefined)).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('misses on another query value or origin, so a mode or an environment the recording never saw runs live', () => {
    expect(decideTraceReplay(entry('/task?mode=safe'), '/task?mode=unsafe')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/companies'), '/companies?tab=notes')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/shop'), 'http://localhost:4400/shop')).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('http://localhost:4400/shop'), 'http://localhost:4400/shop')).toEqual({ action: 'replay' });
  });

  it('needs no starting point when the recording opens with a navigate', () => {
    expect(decideTraceReplay(entry('/anywhere', 'navigate'), '/elsewhere')).toEqual({ action: 'replay' });
  });

  it('compares a device screen title as itself', () => {
    expect(decideTraceReplay(entry('Settings'), 'Settings')).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('Settings'), 'General')).toEqual({ action: 'miss', reason: 'wrong-context' });
  });
});
