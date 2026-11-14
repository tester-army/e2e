/** The `e2e-core` agent's guard: rules, decisions, and the stop a recorded trace keeps. */
import { describe, expect, it } from 'vitest';
import { compileGuard, describeProposed } from 'e2e-core/lib/agent/guard';
import type { RedactedNode } from 'e2e-core/lib/agent/observation';
import { readTraceEntry } from 'e2e-core/lib/cache/trace-read';
import { TRACE_SCHEMA_VERSION } from 'e2e-core/lib/cache/trace';
import type { ProposedAction } from 'e2e-core/lib/types';

const node = (role: string, name: string, extra: Partial<RedactedNode> = {}): RedactedNode =>
  ({ ref: { id: 'n1', revision: 'r1' }, role, name, ...extra }) as unknown as RedactedNode;

const tap = (target?: RedactedNode, url = 'https://shop.example.com/cart'): [ProposedAction, boolean, { node?: RedactedNode }] => [
  { kind: 'tap', ...(target === undefined ? {} : { node: { role: target.role!, name: target.name! } }), url },
  true,
  target === undefined ? {} : { node: target },
];

describe('compileGuard', () => {
  it('stops before a matching node, denies another, and allows the rest', async () => {
    const guard = compileGuard({
      stop: [{ role: 'button', name: /pay|place order/i }],
      deny: [{ name: 'Delete account' }, { url: /\/settings/ }],
    });
    expect(await guard.decide(...tap(node('button', 'Pay now')))).toBe('stop');
    expect(await guard.decide(...tap(node('link', 'Pay now')))).toBe('allow');
    expect(await guard.decide(...tap(node('button', 'Delete account')))).toBe('deny');
    expect(await guard.decide(...tap(node('button', 'Save'), 'https://shop.example.com/settings')))
      .toBe('deny');
    expect(await guard.decide(...tap(node('button', 'Add to cart')))).toBe('allow');
  });

  it('matches a name exactly unless a RegExp says otherwise, as getByRole does', async () => {
    const guard = compileGuard({ stop: [{ name: 'Pay' }] });
    expect(await guard.decide(...tap(node('button', 'Pay')))).toBe('stop');
    expect(await guard.decide(...tap(node('button', 'Pay now')))).toBe('allow');
  });

  it('matches keys and action kinds, and never matches a node rule on an action with no node', async () => {
    const guard = compileGuard({ stop: [{ key: 'Enter', url: /checkout/ }], deny: [{ actions: ['navigate'] }, { role: 'button' }] });
    const enter: ProposedAction = { kind: 'pressKey', key: 'Enter', url: 'https://shop.example.com/checkout' };
    expect(await guard.decide(enter, true, {})).toBe('stop');
    expect(await guard.decide({ ...enter, url: 'https://shop.example.com/search' }, true, {})).toBe('allow');
    expect(await guard.decide({ kind: 'navigate', url: 'https://shop.example.com/' }, true, {})).toBe('deny');
    expect(await guard.decide({ kind: 'scroll' }, true, {})).toBe('allow');
    const destinations = compileGuard({ deny: [{ destination: /\/confirm/ }] });
    expect(await destinations.decide({ kind: 'navigate', destination: 'https://shop.example.com/checkout/confirm' }, true, {})).toBe('deny');
    expect(await destinations.decide({ kind: 'navigate', destination: 'https://shop.example.com/cart' }, true, {})).toBe('allow');
    expect(await destinations.decide({ kind: 'tap' }, true, {})).toBe('allow');
  });

  it('denies an action it cannot identify while any rule is set, unless told to allow it', async () => {
    const point: ProposedAction = { kind: 'tapAt' };
    expect(await compileGuard({ stop: [{ name: 'Pay' }] }).decide(point, false, {})).toBe('deny');
    expect(await compileGuard({ stop: [{ name: 'Pay' }], unidentified: 'allow' }).decide(point, false, {})).toBe('allow');
    expect(await compileGuard({}).decide(point, false, {})).toBe('allow');
  });

  it('asks check for what the rules allowed, and refuses an answer it does not know', async () => {
    const seen: ProposedAction[] = [];
    const guard = compileGuard({
      deny: [{ name: 'Delete account' }],
      check: (action) => {
        seen.push(action);
        return action.node?.name === 'Use points' ? 'stop' : 'allow';
      },
    });
    expect(await guard.decide(...tap(node('button', 'Delete account')))).toBe('deny');
    expect(await guard.decide(...tap(node('button', 'Use points')))).toBe('stop');
    expect(seen.map((action) => action.node?.name)).toEqual(['Use points']);
    const confused = compileGuard({ check: () => 'maybe' as never });
    await expect(confused.decide(...tap(node('button', 'Save')))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses a malformed guard when it is created', () => {
    expect(() => compileGuard({ stop: { name: 'Pay' } as never })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => compileGuard({ stop: [{ nme: 'Pay' } as never] })).toThrow(/unknown key "nme"/);
    expect(() => compileGuard({ unidentified: 'maybe' as never })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => compileGuard({ halt: [] } as never)).toThrow(/unknown key "halt"/);
  });

  it('describes an action by its kind, node, and key', () => {
    expect(describeProposed({ kind: 'tap', node: { role: 'button', name: 'Pay now' } })).toBe('tap button "Pay now"');
    expect(describeProposed({ kind: 'pressKey', key: 'Enter' })).toBe('pressKey Enter');
  });
});

describe('a recorded stop', () => {
  const entry = (stop: unknown) => ({
    schemaVersion: TRACE_SCHEMA_VERSION,
    createdAt: '2026-11-13T12:00:00.000Z',
    payload: {
      actions: [{ name: 'navigate', url: 'https://shop.example.com/cart', summary: 'opened the cart' }],
      executor: { name: 'scripted' },
      summary: 'stopped',
      ...(stop === undefined ? {} : { stop }),
    },
  });

  it('reads back the action a guard stopped the step before', () => {
    const stop = { kind: 'tap', node: { role: 'button', name: 'Pay now', testId: 'pay' }, url: 'https://shop.example.com/cart' };
    expect(readTraceEntry(entry(stop))?.payload.stop).toEqual(stop);
    expect(readTraceEntry(entry(undefined))?.payload.stop).toBeUndefined();
    const navigate = { kind: 'navigate', url: 'https://shop.example.com/cart', destination: 'https://shop.example.com/checkout/confirm' };
    expect(readTraceEntry(entry(navigate))?.payload.stop).toEqual(navigate);
    // A space press stores the key as written, whitespace and all.
    expect(readTraceEntry(entry({ kind: 'pressKey', key: ' ' }))?.payload.stop).toEqual({ kind: 'pressKey', key: ' ' });
  });

  it('distrusts a whole entry whose stop is malformed', () => {
    expect(readTraceEntry(entry({ node: { role: 'button', name: 'Pay' } }))).toBeUndefined();
    expect(readTraceEntry(entry({ kind: 'tap', node: { name: 'Pay' } }))).toBeUndefined();
    expect(readTraceEntry(entry({ kind: 'teleport' }))).toBeUndefined();
    expect(readTraceEntry(entry({ kind: 'tool:alert' }))?.payload.stop).toEqual({ kind: 'tool:alert' });
  });
});
