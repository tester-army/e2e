/**
 * `screen.scrollUntilVisible`: polls the target through the locator engine
 * and swipes the viewport between polls. What the engine sees is a slow swipe
 * in the requested direction, addressed to the observation root, repeated
 * until the target reads as visible or the deadline passes.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type NodeRef, type SemanticNode } from '../../src/engine/index.ts';
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
          perform: (ref, action) => {
            if (action.kind !== 'swipe') throw new Error(`unexpected ${action.kind}`);
            swipes.push({ ref: ref.id, direction: action.direction, momentum: action.momentum });
          },
        }),
    timeoutMs: 1_000,
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

  it('rejects a target that is not an e2e locator before recording a step', async () => {
    const { screen, steps, swipes } = scrollScreen({ screens: [[TARGET]] });
    await expect(screen.scrollUntilVisible(invalid<Locator>({}))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
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
