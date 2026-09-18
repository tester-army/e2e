/** The replay precondition: the screen the recording began on, as a route, with the screen itself settling what the route cannot. */

import { describe, expect, it } from 'vitest';
import { describeScreen } from '../../src/cache/anchors.ts';
import { decideTraceReplay, type ReplayContext } from '../../src/cache/decide.ts';
import { buildTraceEntry, type TraceEntry, type TraceTargetDescriptor } from '../../src/cache/trace.ts';
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

function entry(startPath: string, options: { first?: 'tap' | 'navigate'; startAnchors?: readonly TraceTargetDescriptor[] } = {}): TraceEntry {
  return buildTraceEntry({
    actions:
      options.first === 'navigate'
        ? [{ name: 'navigate', summary: 'navigate to "/companies"', url: '/companies' }]
        : [{ name: 'tap', summary: 'tap button "Save"', target: { role: 'button', name: 'Save' } }],
    executor: { name: 'test' },
    summary: 'saved',
    startPath,
    ...(options.startAnchors === undefined ? {} : { startAnchors: options.startAnchors }),
  });
}

function at(path: string | undefined, nodes?: ReadonlyMap<string, SemanticNode>): ReplayContext {
  return { path, nodes, redact };
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
    expect(decideTraceReplay(entry('/settings/billing/history'), at('/settings/members/list'))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(recorded, at(undefined))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('lets the screen settle a slug it cannot recognize, and only the screen', () => {
    const onProduct = entry('/products/summer-sneaker', { startAnchors: describeScreen(productPage, { redact }) });
    expect(decideTraceReplay(onProduct, at('/products/winter-boot', productPage))).toEqual({ action: 'replay' });
    // Same slug shape, another screen: too few of the recorded anchors are there.
    expect(decideTraceReplay(onProduct, at('/products/winter-boot', companyPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
    // No anchors recorded, too few recorded, or no screen observed: a slug difference is another route.
    expect(decideTraceReplay(entry('/products/summer-sneaker'), at('/products/winter-boot', productPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(entry('/products/summer-sneaker', { startAnchors: describeScreen(productPage, { redact }).slice(0, 3) }), at('/products/winter-boot', productPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
    expect(decideTraceReplay(onProduct, at('/products/winter-boot'))).toEqual({ action: 'miss', reason: 'wrong-context' });
    // Two unexplained differences are never the same screen, whatever it shows.
    expect(decideTraceReplay(entry('/shop/summer/sneaker', { startAnchors: describeScreen(productPage, { redact }) }), at('/shop/winter/boot', productPage))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });

  it('needs no starting point when the recording opens with a navigate', () => {
    expect(decideTraceReplay(entry('/anywhere', { first: 'navigate' }), at('/elsewhere'))).toEqual({ action: 'replay' });
  });

  it('compares a device screen title as itself', () => {
    expect(decideTraceReplay(entry('Settings'), at('Settings'))).toEqual({ action: 'replay' });
    expect(decideTraceReplay(entry('Settings'), at('General'))).toEqual({ action: 'miss', reason: 'wrong-context' });
  });
});
