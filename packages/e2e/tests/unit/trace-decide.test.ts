/** The replay precondition: the screen the recording began on, as a route, with the screen itself as the arbiter. */

import { describe, expect, it } from 'vitest';
import { decideTraceReplay, type ReplayContext } from '../../src/cache/decide.ts';
import { screenSignature } from '../../src/cache/route.ts';
import { buildTraceEntry, type TraceEntry } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { createRedactor } from '../../src/internal/redact.ts';

const redact = createRedactor(new Map());

function node(id: string, role: string, name: string): SemanticNode {
  return { ref: { id, revision: 'r' }, role, name };
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, SemanticNode> {
  return new Map(list.map((item) => [item.ref.id, item]));
}

const productPage = screen(
  node('h', 'heading', 'Edit product'),
  node('b1', 'button', 'Save'),
  node('b2', 'button', 'Delete product'),
  node('t1', 'tab', 'General data'),
  node('t2', 'tab', 'Variants'),
  node('l1', 'link', 'Products & services'),
);
const companyPage = screen(
  node('h', 'heading', 'Company'),
  node('b1', 'button', 'Save'),
  node('b2', 'button', 'Delete company'),
  node('t1', 'tab', 'Identity'),
  node('t2', 'tab', 'Contacts'),
  node('l1', 'link', 'Companies'),
);

function entry(startPath: string, options: { first?: 'tap' | 'navigate'; startScreen?: readonly string[] } = {}): TraceEntry {
  return buildTraceEntry({
    actions:
      options.first === 'navigate'
        ? [{ name: 'navigate', summary: 'navigate to "/companies"', url: '/companies' }]
        : [{ name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } }],
    executor: { name: 'test' },
    summary: 'saved',
    startPath,
    ...(options.startScreen === undefined ? {} : { startScreen: options.startScreen }),
  });
}

function at(path: string | undefined, nodes?: ReadonlyMap<string, SemanticNode>, knownValues: readonly string[] = []): ReplayContext {
  return { path, nodes, knownValues, redact };
}

describe('decideTraceReplay', () => {
  it('replays on the same route, whatever the record id, the query, or the fragment', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, at('/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07'))).toEqual({ action: 'replay' });
    expect(decideTraceReplay(recorded, at('/backend/customers/companies-v2/8374a7a7-a64a-422d-9183-4350756c7f07?tab=notes#top'))).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/orders/42'), at('/orders/43917'))).toEqual({ action: 'replay' });
  });

  it('misses on another route, and without a location', () => {
    const recorded = entry('/backend/customers/companies-v2/ad3339e0-074f-45e0-b778-3dee8ab545eb');
    expect(decideTraceReplay(recorded, at('/backend/customers/people-v2/8374a7a7-a64a-422d-9183-4350756c7f07'))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/settings/billing'), at('/settings/members'))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(recorded, at(undefined))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('recognizes a record by the value this call marked, in any spelling a URL gives it', () => {
    // The recorded path reaches the decision with this call's value already filled in (`expandTrace`),
    // so both sides carry the same value, possibly spelled differently by the app and by the recording.
    const known = ['E2E xyz Sneaker'];
    expect(decideTraceReplay(entry('/products/e2e-xyz-sneaker'), at('/products/E2E%20xyz%20Sneaker', undefined, known))).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('/products/E2E xyz Sneaker'), at('/products/e2e-xyz-sneaker', undefined, known))).toEqual({ action: 'replay' });
    // Without the value, a slug is a route word and two of them differ.
    expect(decideTraceReplay(entry('/products/e2e-abc-sneaker'), at('/products/e2e-xyz-sneaker'))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('lets the screen decide a slug it cannot recognize, and only the screen', () => {
    const recordedOnProduct = entry('/products/summer-sneaker', { startScreen: screenSignature(productPage, { redact }) });
    expect(decideTraceReplay(recordedOnProduct, at('/products/winter-boot', productPage))).toEqual({ action: 'replay' });
    // Same slug shape, another screen: the signature does not match.
    expect(decideTraceReplay(recordedOnProduct, at('/products/winter-boot', companyPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
    // No signature recorded, or no screen observed: a slug difference is another route.
    expect(decideTraceReplay(entry('/products/summer-sneaker'), at('/products/winter-boot', productPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(recordedOnProduct, at('/products/winter-boot'))).toEqual({ action: 'miss', reason: 'wrong-context' });
    // Two unexplained differences are never the same screen, whatever it shows.
    expect(decideTraceReplay(entry('/shop/summer/sneaker', { startScreen: screenSignature(productPage, { redact }) }), at('/shop/winter/boot', productPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('needs no starting point when the recording opens with a navigate', () => {
    expect(decideTraceReplay(entry('/anywhere', { first: 'navigate' }), at('/elsewhere'))).toEqual({ action: 'replay' });
  });

  it('compares a device screen title as itself', () => {
    expect(decideTraceReplay(entry('Settings'), at('Settings'))).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('Settings'), at('General'))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });
});
