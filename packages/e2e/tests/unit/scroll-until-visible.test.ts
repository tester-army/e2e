/**
 * `screen.scrollUntilVisible`: polls the target through the locator engine
 * and swipes the viewport between polls. What the engine sees is a slow swipe
 * in the requested direction, addressed to the observation root, repeated
 * until the target reads as visible or the deadline passes. Every swipe is
 * bounded by that deadline. The target, like a `dragTo` target and a
 * `filter({ has })` locator, has to come from the same target's screen.
 */

import { describe, expect, it } from 'vitest';
import { EngineError, resolveExpression, type NodeRef, type SemanticNode } from '../../src/engine/index.ts';
import { sleep } from '../../src/internal/time.ts';
import type { Locator, Screen } from '../../src/types.ts';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';

const TARGET: SemanticNode = { ref: { id: 'target', revision: '' }, role: 'button', name: 'Accept', text: 'Accept' };
const HIDDEN_TARGET: SemanticNode = { ...TARGET, states: { hidden: true } };
/** The scroll container every screen shows, with whatever it has scrolled to as its children. */
const feed = (...children: readonly SemanticNode[]): SemanticNode => ({
  ref: { id: 'feed', revision: '' },
  role: 'list',
  name: 'Feed',
  ...(children.length === 0 ? {} : { children }),
});
const ROOT: NodeRef = { id: 'root', revision: '' };
const VIEWPORT = { width: 390, height: 844 } as const;
type ScrollOptions = Parameters<Screen['scrollUntilVisible']>[1];

interface Swipe {
  readonly ref: string;
  readonly direction: string;
  readonly momentum: string | undefined;
}

interface ScrollScript {
  /** What the screen shows before any swipe, then after each; the last entry stays. */
  readonly screens: readonly (readonly SemanticNode[])[];
  /** Whether the engine declares the swipe action; default true. */
  readonly swipeable?: boolean;
  /**
   * Every swipe hangs, then fails as an engine reporting a timeout does: `true`
   * for the whole operation budget, as one honouring `timeoutMs` does, or a
   * number of milliseconds of its own clock.
   */
  readonly hang?: boolean | number;
  /** The action timeout of the locator engine; default 1000 ms. */
  readonly actionTimeout?: number;
}

/** A screen over a fake engine that pages through `screens` one swipe at a time and logs every swipe. */
function scrollScreen(script: ScrollScript) {
  const swipes: Swipe[] = [];
  const current = (): readonly SemanticNode[] =>
    script.screens[Math.min(swipes.length, script.screens.length - 1)] ?? [];
  const { screen, steps } = screenOver({
    // The root stays one node whatever is on screen, since a viewport swipe is addressed to it.
    observe: () => ({ root: { ref: ROOT, role: 'root', children: current() }, viewport: VIEWPORT }),
    locate: (expression) => resolveExpression(expression, current()),
    ...(script.swipeable === false
      ? {}
      : {
          actions: ['swipe'],
          perform: async (ref, action, operation) => {
            if (action.kind !== 'swipe') throw new Error(`unexpected ${action.kind}`);
            if (script.hang !== undefined && script.hang !== false) {
              const budget = script.hang === true ? operation.timeoutMs : script.hang;
              await sleep(budget);
              throw new EngineError('OPERATION_TIMEOUT', `swipe exceeded ${budget} ms`, { retryable: false });
            }
            swipes.push({ ref: ref.id, direction: action.direction, momentum: action.momentum });
          },
        }),
    timeoutMs: script.actionTimeout ?? 1_000,
  });
  return { screen, steps, swipes };
}

describe('screen.scrollUntilVisible', () => {
  it('on a locator, swipes that node instead of the viewport, so a scroll container pages', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[feed()], [feed()], [feed(TARGET)]] });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'feed', direction: 'down', momentum: 'slow' },
      { ref: 'feed', direction: 'down', momentum: 'slow' },
    ]);
  });

  it('takes a momentum for the stride of each step', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[feed()], [feed(TARGET)]] });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { momentum: 'none' });
    expect(swipes).toEqual([{ ref: 'feed', direction: 'down', momentum: 'none' }]);
  });

  it('refuses an option it does not take before any swipe', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [TARGET]] });
    await expect(
      screen.scrollUntilVisible(screen.getByText('Accept'), invalid<ScrollOptions>({ speed: 'fast' })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(swipes).toEqual([]);
  });

  it('returns at once when the target is already visible, with no swipe', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([]);
  });

  it('swipes down slowly at the observation root until the target appears, then stops', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'root', direction: 'down', momentum: 'slow' },
      { ref: 'root', direction: 'down', momentum: 'slow' },
    ]);
  });

  it('swipes in the requested direction', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'), { direction: 'right' });
    expect(swipes).toEqual([{ ref: 'root', direction: 'right', momentum: 'slow' }]);
  });

  it('keeps scrolling past a target the engine reports hidden', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[HIDDEN_TARGET], [HIDDEN_TARGET], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toHaveLength(2);
  });

  it('fails as LOCATOR_NOT_FOUND naming the locator once the deadline passes, and records the failed step', async () => {
    const { screen, steps, swipes } = scrollScreen({ screens: [[]] });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      details: { locator: 'getByText("Accept")', name: 'Accept', waitedMs: expect.any(Number) },
    });
    expect(swipes.length).toBeGreaterThanOrEqual(1);
    expect(steps.all()).toEqual([
      expect.objectContaining({
        api: 'screen.scrollUntilVisible',
        status: 'failed',
        error: expect.objectContaining({ code: 'LOCATOR_NOT_FOUND' }),
      }),
    ]);
  });

  it('bounds a viewport swipe by its own deadline: a hung swipe is LOCATOR_NOT_FOUND within the scroll timeout, not the action timeout', async () => {
    const { screen, steps } = scrollScreen({ screens: [[]], hang: true, actionTimeout: 5_000 });
    const started = Date.now();
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(steps.all()).toEqual([expect.objectContaining({ api: 'screen.scrollUntilVisible', status: 'failed' })]);
  });

  it('bounds a locator swipe by the same deadline', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()]], hang: true, actionTimeout: 5_000 });
    const started = Date.now();
    await expect(
      screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 }),
    ).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      cause: expect.objectContaining({ code: 'ACTION_FAILED', cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }) }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(steps.all()).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'LOCATOR_NOT_FOUND' }) }),
    ]);
  });

  it('owns the outcome whichever timer fires first: a swipe timing out on the budget the deadline left it is LOCATOR_NOT_FOUND', async () => {
    // A swipe whose budget is the deadline's remainder, ending on the engine's
    // own clock a moment before this one reads the deadline as passed.
    const { screen } = scrollScreen({ screens: [[]], hang: 110, actionTimeout: 5_000 });
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 200 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
  });

  it('still swipes with less than a poll interval of the budget left', async () => {
    const { screen, swipes } = scrollScreen({ screens: [[], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 50 });
    expect(swipes).toEqual([{ ref: 'root', direction: 'down', momentum: 'slow' }]);
  });

  it('keeps an engine timeout far from the deadline as the action failure it is', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()]], hang: 20, actionTimeout: 5_000 });
    await expect(
      screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { timeout: 30_000 }),
    ).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'operation timed out: getByRole("list", name: "Feed")',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
    expect(steps.all()).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'ACTION_FAILED' }) }),
    ]);
  });

  it('rejects a target that is not an e2e locator before recording a step', async () => {
    const { screen, steps, swipes } = scrollScreen({ screens: [[TARGET]] });
    await expect(screen.scrollUntilVisible(invalid<Locator>({}))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
      message: 'scrollUntilVisible requires an e2e locator',
    });
    expect(steps.all()).toEqual([]);
    expect(swipes).toEqual([]);
  });

  it('records one screen.scrollUntilVisible step labelled with the locator', async () => {
    const { screen, steps } = scrollScreen({ screens: [[], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(steps.all()).toEqual([
      expect.objectContaining({
        kind: 'screen',
        api: 'screen.scrollUntilVisible',
        label: 'getByText("Accept")',
        status: 'passed',
      }),
    ]);
  });

  it('on a locator, labels the step with the target, whose description carries the scope once', async () => {
    const { screen, steps } = scrollScreen({ screens: [[feed()], [feed(TARGET)]] });
    const container = screen.getByRole('list', { name: 'Feed' });
    await container.scrollUntilVisible(container.getByText('Accept'));
    expect(steps.all()).toEqual([
      expect.objectContaining({
        api: 'screen.scrollUntilVisible',
        label: 'getByRole("list", name: "Feed") >> getByText("Accept")',
        status: 'passed',
      }),
    ]);
  });

  it('needs the swipe action only once it has to scroll: a visible target passes on an engine without one', async () => {
    const visible = scrollScreen({ screens: [[TARGET]], swipeable: false });
    await visible.screen.scrollUntilVisible(visible.screen.getByText('Accept'));
    const absent = scrollScreen({ screens: [[]], swipeable: false });
    await expect(absent.screen.scrollUntilVisible(absent.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});

describe("a locator made by another target's screen", () => {
  const FOREIGN = "the one given belongs to another target's screen or another attempt";
  const targets = () => ({
    web: scrollScreen({ screens: [[TARGET]] }),
    mobile: scrollScreen({ screens: [[TARGET]] }),
  });

  it('is refused by scrollUntilVisible before any step on either target', async () => {
    const { web, mobile } = targets();
    await expect(web.screen.scrollUntilVisible(mobile.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
      message: `scrollUntilVisible requires a locator made by this screen; ${FOREIGN}`,
    });
    expect(web.steps.all()).toEqual([]);
    expect(web.swipes).toEqual([]);
    expect(mobile.swipes).toEqual([]);
  });

  it('is refused by dragTo', () => {
    const { web, mobile } = targets();
    expect(() => web.screen.getByText('Accept').dragTo(mobile.screen.getByText('Accept'))).toThrowError(
      expect.objectContaining({
        code: 'INVALID_LOCATOR',
        message: `dragTo requires a locator made by this screen; ${FOREIGN}`,
      }),
    );
    expect(web.steps.all()).toEqual([]);
  });

  it('is refused by filter({ has })', () => {
    const { web, mobile } = targets();
    expect(() => web.screen.getByRole('list').filter({ has: mobile.screen.getByText('Accept') })).toThrowError(
      expect.objectContaining({
        code: 'INVALID_LOCATOR',
        message: `filter({ has }) requires a locator made by this screen; ${FOREIGN}`,
      }),
    );
  });

  it('is refused for a stale locator of the same target from an earlier attempt', async () => {
    const current = scrollScreen({ screens: [[TARGET]] });
    const earlier = scrollScreen({ screens: [[TARGET]] });
    await expect(current.screen.scrollUntilVisible(earlier.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
    });
  });
});
