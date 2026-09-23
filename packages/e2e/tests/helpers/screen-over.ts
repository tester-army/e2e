/**
 * A `screen` over an in-memory engine for unit tests of the locator tier: the
 * engine is whatever `locate`, `observe`, `perform`, and `keyboard` the test
 * hands in, wired through the real `LocatorEngine` and `createScreen` with a
 * `StepRecorder` the test reads back. `createScreenFixture` (screen-fixture.ts)
 * is the preset over a fixed node list.
 */

import {
  defineEngine,
  LOCATOR_ACTION_KINDS,
  type EngineKeyboard,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorActionKind,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type SemanticNode,
} from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { Deadline } from '../../src/internal/time.ts';
import { LocatorEngine } from '../../src/locator/engine.ts';
import { createScreen } from '../../src/locator/screen.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import type { Screen } from '../../src/types.ts';

export interface ScreenOverOptions {
  /** Answers every `locate`. */
  readonly locate: (expression: LocatorExpression) => readonly SemanticNode[] | Promise<readonly SemanticNode[]>;
  /** Answers every `observe`; the root's ref is what a viewport swipe is addressed to. */
  readonly observe: () => EngineSnapshot;
  /** Receives every node action with the operation it runs under; without it the engine declares no actions. */
  readonly perform?: (ref: NodeRef, action: LocatorAction, operation: OperationContext) => void | Promise<void>;
  /** Action kinds the engine declares with `perform`; default every kind. */
  readonly actions?: readonly LocatorActionKind[];
  /** The keyboard the engine declares, if any. */
  readonly keyboard?: EngineKeyboard;
  /** Action and assertion timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** A screen and the recorder of its steps over the engine `options` describe. */
export function screenOver(options: ScreenOverOptions): { screen: Screen; steps: StepRecorder } {
  const { perform } = options;
  const engine = defineEngine({
    name: 'fake',
    version: '1',
    spiVersion: 1,
    observe: async () => options.observe(),
    locate: async (expression) => options.locate(expression),
    ...(perform === undefined
      ? {}
      : {
          actions: options.actions ?? LOCATOR_ACTION_KINDS,
          perform: async (ref: NodeRef, action: LocatorAction, operation: OperationContext) => {
            await perform(ref, action, operation);
          },
        }),
    ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
  });
  const steps = new StepRecorder('attempt');
  const signal = new AbortController().signal;
  const screen = createScreen({
    engine: new LocatorEngine({
      session: createEngineSession({ engine, targetName: 'fake' }),
      budget: new AttemptBudget(signal, new Deadline(10_000)),
      runId: 'run',
      attemptId: 'attempt',
      actionTimeout: options.timeoutMs,
      assertionTimeout: options.timeoutMs,
    }),
    steps,
    secrets: { resolve: async () => 'plaintext' },
  });
  return { screen, steps };
}
