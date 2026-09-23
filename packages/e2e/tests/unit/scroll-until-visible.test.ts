/**
 * `screen.scrollUntilVisible`: polls the target through the locator engine
 * and swipes the viewport between polls. What the engine sees is a slow swipe
 * in the requested direction, addressed to the observation root, repeated
 * until the target reads as visible or the deadline passes.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorAction, LocatorActionKind, LocatorExpression, NodeRef, SemanticNode } from '../../src/engine/surface.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import type { Locator } from '../../src/types.ts';

const TARGET: SemanticNode = { ref: { id: 'target', revision: '' }, role: 'button', name: 'Accept', text: 'Accept' };
const HIDDEN_TARGET: SemanticNode = { ...TARGET, states: { hidden: true } };
const FEED: SemanticNode = { ref: { id: 'feed', revision: '' }, role: 'list', name: 'Feed' };
/** Answers the feed for its role query and leaves every other query to the screen. */
const feedScope = (expression: LocatorExpression): readonly SemanticNode[] | undefined =>
  expression.kind === 'query' &&
  expression.query.kind === 'role' &&
  expression.query.value.kind === 'string' &&
  expression.query.value.value === 'list'
    ? [FEED]
    : undefined;
const ROOT: NodeRef = { id: 'root', revision: '' };
const VIEWPORT = { width: 390, height: 844 } as const;
const SWIPE_ONLY: readonly LocatorActionKind[] = ['swipe'];

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
  /** Answers an expression itself, ahead of the current screen; a scope query resolves through it. */
  readonly resolve?: (expression: LocatorExpression) => readonly SemanticNode[] | undefined;
}

/** A screen over a fake engine that pages through `screens` one swipe at a time and logs every swipe. */
function screenOver(script: ScrollScript) {
  const swipes: Swipe[] = [];
  const current = (): readonly SemanticNode[] =>
    script.screens[Math.min(swipes.length, script.screens.length - 1)] ?? [];
  const engine = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    // The root stays one node whatever is on screen, since a viewport swipe is addressed to it.
    observe: async () => ({ root: { ref: ROOT, role: 'root', children: current() }, viewport: VIEWPORT }),
    locate: async (expression) => script.resolve?.(expression) ?? current(),
    ...(script.swipeable === false
      ? {}
      : {
          actions: SWIPE_ONLY,
          perform: async (ref: NodeRef, action: LocatorAction) => {
            if (action.kind !== 'swipe') throw new Error(`unexpected ${action.kind}`);
            swipes.push({ ref: ref.id, direction: action.direction, momentum: action.momentum });
          },
        }),
  });
  const steps = new StepRecorder('attempt');
  const signal = new AbortController().signal;
  const screen = createScreen({
    engine: new LocatorEngine({
      session: createEngineSession({ engine, targetName: 'fake' }),
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      actionTimeout: 1_000,
      assertionTimeout: 1_000,
    }),
    steps,
    secrets: { resolve: async () => 'plaintext' },
  });
  return { screen, steps, swipes };
}

describe('screen.scrollUntilVisible', () => {
  it('on a locator, swipes that node instead of the viewport, so a scroll container pages', async () => {
    const { screen, swipes } = screenOver({ screens: [[], [], [TARGET]], resolve: feedScope });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'feed', direction: 'down', momentum: 'slow' },
      { ref: 'feed', direction: 'down', momentum: 'slow' },
    ]);
  });

  it('takes a momentum for the stride of each step', async () => {
    const { screen, swipes } = screenOver({ screens: [[], [TARGET]], resolve: feedScope });
    await screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { momentum: 'none' });
    expect(swipes).toEqual([{ ref: 'feed', direction: 'down', momentum: 'none' }]);
  });

  it('refuses an option it does not take before any swipe', async () => {
    const { screen, swipes } = screenOver({ screens: [[], [TARGET]] });
    await expect(
      screen.scrollUntilVisible(screen.getByText('Accept'), { speed: 'fast' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(swipes).toEqual([]);
  });

  it('returns at once when the target is already visible, with no swipe', async () => {
    const { screen, swipes } = screenOver({ screens: [[TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([]);
  });

  it('swipes down slowly at the observation root until the target appears, then stops', async () => {
    const { screen, swipes } = screenOver({ screens: [[], [], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toEqual([
      { ref: 'root', direction: 'down', momentum: 'slow' },
      { ref: 'root', direction: 'down', momentum: 'slow' },
    ]);
  });

  it('swipes in the requested direction', async () => {
    const { screen, swipes } = screenOver({ screens: [[], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'), { direction: 'right' });
    expect(swipes).toEqual([{ ref: 'root', direction: 'right', momentum: 'slow' }]);
  });

  it('keeps scrolling past a target the engine reports hidden', async () => {
    const { screen, swipes } = screenOver({ screens: [[HIDDEN_TARGET], [HIDDEN_TARGET], [TARGET]] });
    await screen.scrollUntilVisible(screen.getByText('Accept'));
    expect(swipes).toHaveLength(2);
  });

  it('fails as LOCATOR_NOT_FOUND naming the locator once the deadline passes, and records the failed step', async () => {
    const { screen, steps, swipes } = screenOver({ screens: [[]] });
    const started = Date.now();
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
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
    const { screen, steps, swipes } = screenOver({ screens: [[TARGET]] });
    await expect(screen.scrollUntilVisible({} as unknown as Locator)).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
    });
    expect(steps.all()).toEqual([]);
    expect(swipes).toEqual([]);
  });

  it('records one screen.scrollUntilVisible step labelled with the locator', async () => {
    const { screen, steps } = screenOver({ screens: [[], [TARGET]] });
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

  it('needs the swipe action only once it has to scroll: a visible target passes on an engine without one', async () => {
    const visible = screenOver({ screens: [[TARGET]], swipeable: false });
    await visible.screen.scrollUntilVisible(visible.screen.getByText('Accept'));
    const absent = screenOver({ screens: [[]], swipeable: false });
    await expect(absent.screen.scrollUntilVisible(absent.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });
});
