/**
 * Instrumented in-memory backend for runner<->backend contract tests. Runtime
 * classes come from the built package so `instanceof` checks inside the built
 * runner (used by run-project.ts) see the same identities.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BackendAttemptContext,
  BackendHandle,
  BackendInitInfo,
  BackendState,
  LocatorAction,
  LocatorExpression,
  NodeRef,
  OperationContext,
  SemanticNode,
} from '../../src/backend/index.ts';

const builtBackendModule = '../../dist/backend/index.js';
const { defineBackend, BackendError, BACKEND_SPI_VERSION } = (await import(
  builtBackendModule
)) as typeof import('../../src/backend/index.ts');

export { BackendError as BuiltBackendError };

export interface RecordedOperation {
  readonly method: string;
  readonly attemptIndex: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly timeoutMs: number;
  readonly abortedAtCall: boolean;
}

export interface FakeBackendBehavior {
  /** Throw to fail worker boot. Called before any attempt. */
  onInit?(info: BackendInitInfo): void | Promise<void>;
  /** Throw or hang to fail attempt launches. */
  onStartAttempt?(context: BackendAttemptContext, attemptIndex: number): void | Promise<void>;
  /** Throw to fail attempt close. */
  onEndAttempt?(attemptIndex: number): void | Promise<void>;
  /** Throw to fail navigation (app.open). */
  onNavigate?(url: string, attemptIndex: number): void | Promise<void>;
  /** Overrides locate; default resolves one stable node. */
  locate?(
    expression: LocatorExpression,
    operation: OperationContext,
    attemptIndex: number,
  ): readonly SemanticNode[] | Promise<readonly SemanticNode[]>;
  /** Overrides perform; default succeeds. */
  perform?(
    ref: NodeRef,
    action: LocatorAction,
    operation: OperationContext,
    attemptIndex: number,
  ): void | Promise<void>;
  /** Throw to fail observe; default returns one stable observation. */
  observe?(operation: OperationContext, attemptIndex: number): void | Promise<void>;
  /** Overrides the observed tree; default is one Submit button. */
  tree?: SemanticNode;
  /** Declares the state capability. */
  state?: boolean;
  /** Declares the artifacts capability (screenshot only). */
  artifacts?: boolean;
  /** Throw to fail state restore after startAttempt succeeded. */
  onRestore?(state: BackendState): void | Promise<void>;
  /** Contributes a `gadget` fixture exercising every fixture-context facility. */
  fixtures?: boolean;
}

export interface FakeBackendHandle {
  readonly backend: BackendHandle;
  /** Ordered event names, e.g. 'init', 'startAttempt:0', 'endAttempt:0', 'dispose'. */
  readonly events: string[];
  readonly inits: BackendInitInfo[];
  readonly attempts: BackendAttemptContext[];
  readonly operations: RecordedOperation[];
  readonly capturedStates: BackendState[];
  readonly restoredStates: BackendState[];
  /** Calls the contributed `gadget` fixture received, in order. */
  readonly fixtureCalls: string[];
  stats(): {
    inits: number;
    attemptsStarted: number;
    attemptsEnded: number;
    disposes: number;
    maxConcurrentAttempts: number;
  };
}

export const FAKE_NODE: SemanticNode = {
  ref: { id: 'node-1', revision: '' },
  role: 'button',
  name: 'Submit',
  states: { hidden: false },
};

/** Creates a branded, instrumented fake backend. */
export function createFakeBackend(behavior: FakeBackendBehavior = {}): FakeBackendHandle {
  const events: string[] = [];
  const inits: BackendInitInfo[] = [];
  const attempts: BackendAttemptContext[] = [];
  const operations: RecordedOperation[] = [];
  const capturedStates: BackendState[] = [];
  const restoredStates: BackendState[] = [];
  const fixtureCalls: string[] = [];
  let openAttempts = 0;
  let attemptsStarted = 0;
  let attemptsEnded = 0;
  let maxConcurrentAttempts = 0;
  let disposes = 0;
  let current = -1;

  function record(method: string, operation: OperationContext): void {
    operations.push({
      method,
      attemptIndex: current,
      runId: operation.runId,
      attemptId: operation.attemptId,
      timeoutMs: operation.timeoutMs,
      abortedAtCall: operation.signal.aborted,
    });
  }

  const tree = behavior.tree ?? FAKE_NODE;

  const backend = defineBackend({
    name: 'fake',
    version: '1.0.0',
    spiVersion: BACKEND_SPI_VERSION,
    async init(info) {
      events.push('init');
      inits.push(info);
      await behavior.onInit?.(info);
    },
    async startAttempt(context) {
      const index = attemptsStarted;
      current = index;
      attemptsStarted += 1;
      openAttempts += 1;
      maxConcurrentAttempts = Math.max(maxConcurrentAttempts, openAttempts);
      events.push(`startAttempt:${index}`);
      attempts.push(context);
      await behavior.onStartAttempt?.(context, index);
    },
    async endAttempt() {
      const index = current;
      openAttempts -= 1;
      attemptsEnded += 1;
      events.push(`endAttempt:${index}`);
      await behavior.onEndAttempt?.(index);
    },
    async dispose() {
      disposes += 1;
      events.push('dispose');
    },
    async observe(operation) {
      record('observe', operation);
      await behavior.observe?.(operation, current);
      return { nodes: [tree], viewport: { width: 1280, height: 720, scale: 1 } };
    },
    actions: {
      async tap(target, operation) {
        record(`actions.tap(${target.ref.id})`, operation);
      },
      async type(target, value, operation) {
        record(`actions.type(${target.ref.id},${value.length})`, operation);
      },
      async scroll(direction, _target, operation) {
        record(`actions.scroll(${direction})`, operation);
      },
      async navigate(url, operation) {
        record(`actions.navigate(${url})`, operation);
        await behavior.onNavigate?.(url, current);
      },
    },
    async locate(expression, operation) {
      record('locate', operation);
      if (behavior.locate !== undefined) return behavior.locate(expression, operation, current);
      return [FAKE_NODE];
    },
    async perform(ref, action, operation) {
      record(`perform(${ref.id},${action.kind})`, operation);
      await behavior.perform?.(ref, action, operation, current);
    },
    async url(operation) {
      record('url', operation);
      return 'http://127.0.0.1:4599/';
    },
    ...(behavior.state === true
      ? {
          state: {
            async capture(operation) {
              record('state.capture', operation);
              const state: BackendState = { format: 'fake-state', version: 1, data: { ok: true } };
              capturedStates.push(state);
              return state;
            },
            async restore(state, operation) {
              record('state.restore', operation);
              await behavior.onRestore?.(state);
              restoredStates.push(state);
            },
          },
        }
      : {}),
    ...(behavior.fixtures === true
      ? {
          fixtures: {
            gadget: (context) => context.expectable({
              async poke(what: string) {
                fixtureCalls.push(`poke:${what}`);
                return `poked ${what}`;
              },
              async slow(options?: { timeout?: number }) {
                fixtureCalls.push('slow');
                await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50));
                return 'done';
              },
              async hang() {
                await new Promise(() => undefined);
              },
              async dropFile() {
                // Artifacts are real files under the attempt directory the
                // backend received in startAttempt; the harness hashes them.
                const dir = attempts.at(-1)!.artifactsDir;
                mkdirSync(path.join(dir, 'gadget'), { recursive: true });
                writeFileSync(path.join(dir, 'gadget', 'log.txt'), 'gadget log\n');
                context.attachArtifact('log', 'gadget/log.txt');
                return 'attached';
              },
              describe(): string {
                return `gadget on ${context.targetName}`;
              },
              broken(): never {
                throw new Error('accessor broke');
              },
              knobs: {
                async turn(name: string) {
                  fixtureCalls.push(`turn:${name}`);
                },
              },
            }, () => ({
              async toBePoked(times: number) {
                const poked = fixtureCalls.filter((call) => call.startsWith('poke:')).length;
                if (poked !== times) throw new Error(`poked ${poked} times, expected ${times}`);
              },
            })),
          },
        }
      : {}),
    ...(behavior.artifacts === true
      ? {
          artifacts: {
            async screenshot(label, operation) {
              record(`artifacts.screenshot(${label ?? ''})`, operation);
              return 'screenshots/fake.png';
            },
          },
        }
      : {}),
  });

  return {
    backend,
    events,
    inits,
    attempts,
    operations,
    capturedStates,
    restoredStates,
    fixtureCalls,
    stats: () => ({
      inits: inits.length,
      attemptsStarted,
      attemptsEnded,
      disposes,
      maxConcurrentAttempts,
    }),
  };
}

/** A thrown `BackendError` from the built package, for behaviors that fail on purpose. */
export function backendFailure(
  code: ConstructorParameters<typeof BackendError>[0],
  message: string,
  retryable = false,
): InstanceType<typeof BackendError> {
  return new BackendError(code, message, { retryable });
}
