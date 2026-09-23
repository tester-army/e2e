/**
 * `screen.scrollUntilVisible`: polls the target through the locator engine
 * and swipes the viewport between polls. What the engine sees is a slow swipe
 * in the requested direction, addressed to the observation root, repeated
 * until the target reads as visible or the deadline passes. Every swipe is
 * bounded by that deadline. The target, like a `dragTo` target and a
 * `filter({ has })` locator, has to come from the same target's screen.
 */

import { describe, expect, it } from 'vitest';
import {
  EngineError,
  type LocatorAction,
  type LocatorActionKind,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '../../src/engine/surface.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline, sleep } from '../../src/internal/time.ts';
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
  /** Every swipe hangs for the whole operation budget, then fails as an engine honouring `timeoutMs` does. */
  readonly hang?: boolean;
  /** The target name the session reports; default `fake`. */
  readonly targetName?: string;
  /** The action timeout of the locator engine; default 1000 ms. */
  readonly actionTimeout?: number;
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
          perform: async (ref: NodeRef, action: LocatorAction, operation: OperationContext) => {
            if (action.kind !== 'swipe') throw new Error(`unexpected ${action.kind}`);
            if (script.hang === true) {
              await sleep(operation.timeoutMs);
              throw new EngineError('OPERATION_TIMEOUT', `swipe exceeded ${operation.timeoutMs} ms`, {
                retryable: false,
              });
            }
            swipes.push({ ref: ref.id, direction: action.direction, momentum: action.momentum });
          },
        }),
  });
  const steps = new StepRecorder('attempt');
  const signal = new AbortController().signal;
  const screen = createScreen({
    engine: new LocatorEngine({
      session: createEngineSession({ engine, targetName: script.targetName ?? 'fake' }),
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      actionTimeout: script.actionTimeout ?? 1_000,
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

  it('bounds a viewport swipe by its own deadline: a hung swipe is LOCATOR_NOT_FOUND within the scroll timeout, not the action timeout', async () => {
    const { screen, steps } = screenOver({ screens: [[]], hang: true, actionTimeout: 5_000 });
    const started = Date.now();
    await expect(screen.scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 })).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: 'target did not become visible while scrolling: getByText("Accept")',
      cause: expect.objectContaining({ code: 'OPERATION_TIMEOUT' }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(steps.all()).toEqual([
      expect.objectContaining({ api: 'screen.scrollUntilVisible', status: 'failed' }),
    ]);
  });

  it('bounds a locator swipe by the same deadline', async () => {
    const { screen } = screenOver({ screens: [[]], hang: true, actionTimeout: 5_000, resolve: feedScope });
    const started = Date.now();
    await expect(
      screen.getByRole('list', { name: 'Feed' }).scrollUntilVisible(screen.getByText('Accept'), { timeout: 250 }),
    ).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects a target that is not an e2e locator before recording a step', async () => {
    const { screen, steps, swipes } = screenOver({ screens: [[TARGET]] });
    await expect(screen.scrollUntilVisible({} as unknown as Locator)).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
      message: 'scrollUntilVisible requires an e2e locator',
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

  it('on a locator, labels the step with the target, whose description carries the scope once', async () => {
    const { screen, steps } = screenOver({ screens: [[], [TARGET]], resolve: feedScope });
    const feed = screen.getByRole('list', { name: 'Feed' });
    await feed.scrollUntilVisible(feed.getByText('Accept'));
    expect(steps.all()).toEqual([
      expect.objectContaining({
        api: 'screen.scrollUntilVisible',
        label: 'getByRole("list", name: "Feed") >> getByText("Accept")',
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

describe("a locator made by another target's screen", () => {
  const FOREIGN = "the one given belongs to another target's screen or another attempt";
  const targets = () => ({
    web: screenOver({ screens: [[TARGET]], targetName: 'web' }),
    mobile: screenOver({ screens: [[TARGET]], targetName: 'mobile' }),
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
    const current = screenOver({ screens: [[TARGET]] });
    const earlier = screenOver({ screens: [[TARGET]] });
    await expect(current.screen.scrollUntilVisible(earlier.screen.getByText('Accept'))).rejects.toMatchObject({
      code: 'INVALID_LOCATOR',
    });
  });
});
