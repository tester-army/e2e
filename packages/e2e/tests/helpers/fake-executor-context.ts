/**
 * A `StepExecutorContext` for unit tests over the tool vocabulary: the whole
 * grammar is declared, a secret is in play, and every action and observation
 * refuses to run, recording what it was asked for. Schema validation is the
 * subject; a tool body that reaches an action is the failure.
 */

import type { ExecutorActions, ExecutorStep, ExecutorVerb, StepExecutorContext } from '../../src/agent/executor.ts';

export interface FakeExecutorContext {
  readonly context: StepExecutorContext;
  /** What tool bodies asked the harness to run, in order; empty while nothing was dispatched. */
  readonly dispatched: string[];
}

export interface FakeExecutorContextOptions {
  /** The verbs the target declares; the whole grammar by default. */
  readonly verbs?: readonly ExecutorVerb[];
  /** The secrets the step declared; one password by default. */
  readonly secrets?: ExecutorStep['secrets'];
  readonly pixelsTainted?: boolean;
}

/** Builds the context; `dispatched` names every action or observation a tool body reached. */
export function fakeExecutorContext(options: FakeExecutorContextOptions = {}): FakeExecutorContext {
  const dispatched: string[] = [];
  const refuse = (name: string) => async (): Promise<never> => {
    dispatched.push(name);
    throw new Error(`${name} must not run in this test`);
  };
  // Typed as the whole grammar, so a verb added to `ExecutorActions` lands here too.
  const actions: ExecutorActions = {
    tap: refuse('tap'),
    doubleTap: refuse('doubleTap'),
    longPress: refuse('longPress'),
    secondaryTap: refuse('secondaryTap'),
    hover: refuse('hover'),
    type: refuse('type'),
    typeSecret: refuse('typeSecret'),
    press: refuse('press'),
    select: refuse('select'),
    check: refuse('check'),
    drag: refuse('drag'),
    scrollTo: refuse('scrollTo'),
    scrollUntil: refuse('scrollUntil'),
    upload: refuse('upload'),
    scroll: refuse('scroll'),
    navigate: refuse('navigate'),
    back: refuse('back'),
    tapAt: refuse('tapAt'),
    hoverAt: refuse('hoverAt'),
    typeText: refuse('typeText'),
    pressKey: refuse('pressKey'),
    dismissKeyboard: refuse('dismissKeyboard'),
    hitTest: refuse('hitTest'),
  };
  const signal = new AbortController().signal;
  const context: StepExecutorContext = {
    step: {
      kind: 'act',
      index: 0,
      instruction: 'exercise the vocabulary',
      params: undefined,
      secrets: options.secrets ?? [{ name: 'admin', purpose: 'password' }],
    },
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    target: { name: 'web', platform: 'web', verbs: new Set(options.verbs ?? (Object.keys(actions) as ExecutorVerb[])) },
    signal,
    model: undefined,
    providerOptions: undefined,
    ledger: '',
    agentContext: undefined,
    budgets: {
      maxActions: 25,
      maxModelCalls: 25,
      actionsUsed: () => 0,
      remainingMs: () => 60_000,
      recordModelCall: () => undefined,
      runTool: (_call, body) => body(),
    },
    observe: refuse('observe'),
    actions,
    pixelsTainted: options.pixelsTainted ?? false,
    attachTranscript: () => undefined,
    attachTurns: () => undefined,
    attachScreenshot: async () => 'screenshot',
  };
  return { context, dispatched };
}
