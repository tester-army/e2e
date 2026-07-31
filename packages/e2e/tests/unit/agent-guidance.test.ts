/**
 * The two rules that decide what a planning round is allowed to do:
 * where a recorded route stands, and which action kinds are on the menu.
 *
 * Both are pure, and both had a bug that no integration test could see because
 * the symptom was a *worse suggestion* rather than a failure.
 */

import { describe, expect, it } from 'vitest';
import { offeredKinds, validateToolCall } from '../../src/agent/action-space.ts';
import { Guidance } from '../../src/agent/path-cache.ts';
import type { CacheLocator, PathAction } from '../../src/cache/index.ts';

const locator = (name: string): CacheLocator =>
  ({ kind: 'query', query: 'role', role: 'button', name: { value: name, exact: true } }) as
    unknown as CacheLocator;

const TAP_ONE: PathAction = { kind: 'tap', target: locator('One') };
const TAP_TWO: PathAction = { kind: 'tap', target: locator('Two') };

describe('recorded path guidance', () => {
  it('offers the first recorded step before anything happens', () => {
    const guidance = new Guidance([TAP_ONE, TAP_TWO]);
    expect(guidance.next()).toEqual(TAP_ONE);
  });

  // Agreeing with the recorded step is not the same as taking it. A dispatch
  // that fails leaves the page where that step did not happen, so advancing on
  // the proposal guided the model straight past the one thing it had just been
  // unable to do.
  it('does not advance when the agreed action never commits', () => {
    const guidance = new Guidance([TAP_ONE, TAP_TWO]);
    expect(guidance.reconcile(TAP_ONE)).toBe('agreed');
    expect(guidance.next()).toEqual(TAP_ONE);
  });

  it('advances only once the action has committed', () => {
    const guidance = new Guidance([TAP_ONE, TAP_TWO]);
    expect(guidance.reconcile(TAP_ONE)).toBe('agreed');
    guidance.advance();
    expect(guidance.next()).toEqual(TAP_TWO);
  });

  it('abandons the route when the model chooses something else', () => {
    const guidance = new Guidance([TAP_ONE, TAP_TWO]);
    expect(guidance.reconcile(TAP_TWO)).toBe('abandoned');
    expect(guidance.next()).toBeUndefined();
  });

  // The caller reports the discard, so a repeated `abandoned` would report it
  // once per remaining round.
  it('reports the abandonment exactly once', () => {
    const guidance = new Guidance([TAP_ONE, TAP_TWO]);
    expect(guidance.reconcile(TAP_TWO)).toBe('abandoned');
    expect(guidance.reconcile(TAP_ONE)).toBe('none');
    expect(guidance.reconcile(TAP_TWO)).toBe('none');
  });

  it('treats an unrecordable proposal as divergence', () => {
    const guidance = new Guidance([TAP_ONE]);
    expect(guidance.reconcile(undefined)).toBe('abandoned');
  });

  it('runs out cleanly at the end of the route', () => {
    const guidance = new Guidance([TAP_ONE]);
    guidance.reconcile(TAP_ONE);
    guidance.advance();
    expect(guidance.next()).toBeUndefined();
    expect(guidance.reconcile(TAP_TWO)).toBe('none');
  });

  it('has nothing to offer on a cold run', () => {
    const guidance = new Guidance(undefined);
    expect(guidance.next()).toBeUndefined();
    guidance.advance();
    expect(guidance.next()).toBeUndefined();
  });

  // Both sides of the comparison are built in different modules — one from a live
  // call, one from a file — so equality must not depend on the order two object
  // literals happen to list their fields in.
  it('compares recorded actions regardless of field order', () => {
    const guidance = new Guidance([
      { kind: 'scroll', direction: 'down', momentum: 'slow' } as PathAction,
    ]);
    const reordered = { momentum: 'slow', direction: 'down', kind: 'scroll' } as PathAction;
    expect(guidance.reconcile(reordered)).toBe('agreed');
  });
});

describe('the offered action allowlist', () => {
  const full = offeredKinds({ actionStepsRemaining: 5, committed: false });

  it('offers the whole vocabulary before anything has committed', () => {
    expect(full).toContain('tap');
    expect(full).toContain('navigate');
    expect(full).toContain('conclude');
  });

  // Navigating is how a stuck agent starts over, and starting over is the one
  // recovery that is purely destructive: it discards the state earlier steps of
  // the test set up, and nothing can put it back.
  it('withdraws navigation once an action has committed', () => {
    const narrowed = offeredKinds({ actionStepsRemaining: 5, committed: true });
    expect(narrowed).not.toContain('navigate');
    expect(narrowed).toContain('tap');
    expect(narrowed).toContain('type');
    expect(narrowed).toContain('scroll');
    expect(narrowed).toContain('press');
    expect(narrowed).toContain('conclude');
  });

  it('leaves only reporting once the action budget is spent', () => {
    expect(offeredKinds({ actionStepsRemaining: 0, committed: true })).toEqual([
      'observe',
      'conclude',
    ]);
    // The budget outranks everything: a spent budget on a cold flow is the same.
    expect(offeredKinds({ actionStepsRemaining: 0, committed: false })).toEqual([
      'observe',
      'conclude',
    ]);
  });
});

// Withdrawing navigation is worth nothing if a key can navigate instead. In the
// planning tier the key comes from the model, unlike every other `press` in the
// API, where 02-test-api.md guarantees it comes from test code.
describe('the keys a planning call may press', () => {
  const observation = {
    revision: 'r1',
    nodes: new Map(),
  } as unknown as Parameters<typeof validateToolCall>[1];

  const propose = (key: string): ReturnType<typeof validateToolCall> =>
    validateToolCall(
      { toolVersion: 'agent-tool-1', kind: 'press', key, explanation: 'go' },
      observation,
      ['press'],
    );

  it.each(['Enter', 'Escape', 'Tab', 'Shift+Tab', 'ArrowDown', 'PageDown'])(
    'accepts %s',
    (key) => {
      expect(propose(key).ok, key).toBe(true);
    },
  );

  // Every one of these is a key a real driver honours, and every one of them
  // navigates or reloads the page.
  it.each(['Alt+ArrowLeft', 'BrowserBack', 'BrowserRefresh', 'F5', 'Control+r', 'Meta+['])(
    'refuses %s, which would leave the flow',
    (key) => {
      const result = propose(key);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.issue).toContain('key must be one of');
    },
  );
});
