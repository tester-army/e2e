/**
 * `locator.waitFor` waits for each of Playwright's four states against a
 * screen whose nodes arrive and leave on a clock, and refuses a state or an
 * option key it does not know before resolving anything: a typo or an
 * unimplemented state read as `hidden` would pass at once on an absent node.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resolveExpression, type SemanticNode } from '../../src/engine/index.ts';
import type { Locator } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const CHANGE_AFTER_MS = 1_200;

const banner: SemanticNode = { ref: { id: 'banner', revision: '' }, role: 'alert', name: 'Saved', testId: 'banner' };
const hiddenBanner: SemanticNode = { ...banner, states: { hidden: true } };

const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
});

/** A screen whose node list starts as `initial` and becomes `later` after 1200 ms, counting every lookup. */
function changingScreen(initial: readonly SemanticNode[], later: readonly SemanticNode[]) {
  let nodes = initial;
  let lookups = 0;
  timers.push(setTimeout(() => (nodes = later), CHANGE_AFTER_MS));
  const { screen, steps } = screenOver({
    locate: (expression) => {
      lookups += 1;
      return resolveExpression(expression, nodes);
    },
    observe: () => snapshot(nodes),
    timeoutMs: 4_000,
  });
  return { banner: screen.getByTestId('banner'), screen, steps, lookups: () => lookups };
}

/** Milliseconds `locator.waitFor(options)` took to resolve. */
async function timed(locator: Locator, options: Parameters<Locator['waitFor']>[0]): Promise<number> {
  const started = performance.now();
  await locator.waitFor(options);
  return performance.now() - started;
}

describe('locator.waitFor states', () => {
  it.each([
    ['attached', [], [hiddenBanner]],
    ['detached', [hiddenBanner], []],
    ['visible', [hiddenBanner], [banner]],
    ['hidden', [banner], [hiddenBanner]],
    ['hidden', [banner], []],
  ] as const)('waits for %s until the node changes after 1200 ms', async (state, initial, later) => {
    const { banner: locator, steps } = changingScreen(initial, later);
    expect(await timed(locator, { state })).toBeGreaterThanOrEqual(CHANGE_AFTER_MS - 50);
    expect(steps.all()).toEqual([
      expect.objectContaining({ api: 'locator.waitFor', label: `getByTestId("banner") → ${state}`, status: 'passed' }),
    ]);
  });

  it.each([
    ['attached', [hiddenBanner]],
    ['detached', []],
    ['visible', [banner]],
    ['hidden', []],
  ] as const)('passes %s at once when the state already holds', async (state, nodes) => {
    const { banner: locator } = changingScreen(nodes, nodes);
    expect(await timed(locator, { state })).toBeLessThan(CHANGE_AFTER_MS);
  });

  it('attached accepts a hidden node that visible keeps waiting for', async () => {
    const { banner: locator } = changingScreen([hiddenBanner], [hiddenBanner]);
    await locator.waitFor({ state: 'attached' });
    await expect(locator.waitFor({ state: 'visible', timeout: 100 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('did not become visible'),
    });
  });

  it.each([
    ['attached', []],
    ['detached', [hiddenBanner]],
  ] as const)('times out %s with LOCATOR_NOT_FOUND when the state never holds', async (state, nodes) => {
    const { banner: locator } = changingScreen(nodes, nodes);
    await expect(locator.waitFor({ state, timeout: 100 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: `locator did not become ${state}: getByTestId("banner")`,
    });
  });

  it('fails every state at once on several matches', async () => {
    const twin: SemanticNode = { ...banner, ref: { id: 'twin', revision: '' } };
    const { banner: locator } = changingScreen([banner, twin], [banner, twin]);
    for (const state of ['attached', 'detached', 'visible', 'hidden'] as const) {
      await expect(locator.waitFor({ state, timeout: 1_000 })).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    }
  });
});

describe('locator.waitFor validation', () => {
  it.each([
    [{ state: 'atached' }, 'waitFor state must be one of attached, detached, visible, hidden, got "atached"'],
    [{ state: 'Visible' }, 'waitFor state must be one of attached, detached, visible, hidden, got "Visible"'],
    [{ state: null }, 'waitFor state must be one of attached, detached, visible, hidden, got null'],
    [{ state: 'visible', strict: true }, 'waitFor options has no key "strict"; it takes state, timeout'],
    [{ timeoutMs: 100 }, 'waitFor options has no key "timeoutMs" (now "timeout"); it takes state, timeout'],
    ['visible', 'waitFor options must be a plain object'],
  ])('rejects %j before any lookup or step', async (options, message) => {
    const { banner: locator, steps, lookups } = changingScreen([], []);
    await expect(locator.waitFor(invalid(options))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message });
    expect(lookups()).toBe(0);
    expect(steps.all()).toEqual([]);
  });
});
