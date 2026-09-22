/**
 * Instrumented in-memory engine for runner<->engine contract tests. Runtime
 * classes come from the built package so `instanceof` checks inside the built
 * runner (used by run-project.ts) see the same identities.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  EngineAppDeclaration,
  EngineAttemptContext,
  EngineHandle,
  EngineInitInfo,
  EngineState,
  LocatorAction,
  LocatorExpression,
  NodeRef,
  OperationContext,
  SemanticNode,
} from '../../src/engine/index.ts';

const builtEngineModule = '../../dist/engine/index.js';

/** The EBML magic every WebM file starts with, followed by nothing worth decoding. */
const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
/** The PNG signature, followed by nothing worth decoding. */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const { defineEngine, EngineError, ENGINE_SPI_VERSION, LOCATOR_ACTION_KINDS } = (await import(
  builtEngineModule
)) as typeof import('../../src/engine/index.ts');


export interface RecordedOperation {
  readonly method: string;
  readonly attemptIndex: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly timeoutMs: number;
  readonly abortedAtCall: boolean;
}

export interface FakeEngineBehavior {
  /** Throw to fail worker boot. Called before any attempt. */
  onInit?(info: EngineInitInfo): void | Promise<void>;
  /** Throw or hang to fail attempt launches. */
  onStartAttempt?(context: EngineAttemptContext, attemptIndex: number): void | Promise<void>;
  /** Throw to fail attempt close. */
  onEndAttempt?(attemptIndex: number): void | Promise<void>;
  /** Throw to fail worker-end disposal. */
  onDispose?(): void | Promise<void>;
  /** Throw to fail navigation (app.open); backs `session.open`. */
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
  /** What `capture` returns; default is `{ format: 'fake-state', version: 1, data: { ok: true } }`. */
  capturedState?: EngineState;
  /** Declares the artifacts capability (screenshot only). */
  artifacts?: boolean;
  /**
   * Declares video recording on top of screenshots: `stopVideo` writes one
   * small `video/fake.webm` into the attempt directory and reports when the
   * segment began.
   */
  video?: boolean;
  /** Declares the `swipe` action kind, unlocking the agent's scroll verb and `screen.swipe()`. */
  swipe?: boolean;
  /** Throw to fail state restore after startAttempt succeeded. */
  onRestore?(state: EngineState): void | Promise<void>;
  /** Contributes a `gadget` fixture exercising every fixture-context facility. */
  fixtures?: boolean;
  /** What the engine declares about its app; defaults to `FAKE_APP_URL`, which every observation reports as its location. */
  app?: EngineAppDeclaration;
}

/** The app URL the fake serves and declares by default. */
export const FAKE_APP_URL = 'http://127.0.0.1:4599';
export interface FakeEngineHandle {
  readonly engine: EngineHandle;
  /** Ordered event names, e.g. 'init', 'startAttempt:0', 'endAttempt:0', 'dispose'. */
  readonly events: string[];
  readonly inits: EngineInitInfo[];
  readonly attempts: EngineAttemptContext[];
  readonly operations: RecordedOperation[];
  readonly capturedStates: EngineState[];
  readonly restoredStates: EngineState[];
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

const FAKE_NODE: SemanticNode = {
  ref: { id: 'node-1', revision: '' },
  role: 'button',
  name: 'Submit',
  states: { hidden: false },
};

/** Creates a branded, instrumented fake engine. */
export function createFakeEngine(behavior: FakeEngineBehavior = {}): FakeEngineHandle {
  const events: string[] = [];
  const inits: EngineInitInfo[] = [];
  const attempts: EngineAttemptContext[] = [];
  const operations: RecordedOperation[] = [];
  const capturedStates: EngineState[] = [];
  const restoredStates: EngineState[] = [];
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
  let videoStartedAt: string | undefined;

  const engine = defineEngine({
    name: 'fake',
    version: '1.0.0',
    spiVersion: ENGINE_SPI_VERSION,
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
      await behavior.onDispose?.();
    },
    async observe(operation) {
      record('observe', operation);
      await behavior.observe?.(operation, current);
      return { location: `${FAKE_APP_URL}/`, root: tree, viewport: { width: 1280, height: 720 } };
    },
    actions: LOCATOR_ACTION_KINDS.filter((kind) => kind !== 'swipe' || behavior.swipe === true),
    app: behavior.app ?? { url: FAKE_APP_URL },
    session: {
      async open(url, operation) {
        record(`session.open(${url})`, operation);
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
    ...(behavior.state === true
      ? {
          state: {
            async capture(operation) {
              record('state.capture', operation);
              const state: EngineState = behavior.capturedState ?? {
                format: 'fake-state',
                version: 1,
                data: { ok: true },
              };
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
            gadget: (context) => context.fixture('gadget', context.expectable({
              async poke(what: string) {
                fixtureCalls.push(`poke:${what}`);
                return `poked ${what}`;
              },
              async slow(options?: { timeout?: number }) {
                fixtureCalls.push('slow');
                await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50));
                return 'done';
              },
              async hang(_options?: { timeout?: number }) {
                await new Promise(() => undefined);
              },
              async dropFile() {
                // Artifacts are real files under the attempt directory the
                // engine received in startAttempt; the harness hashes them.
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
            }, () => context.fixture('expect', {
              async toBePoked(times: number) {
                const poked = fixtureCalls.filter((call) => call.startsWith('poke:')).length;
                if (poked !== times) throw new Error(`poked ${poked} times, expected ${times}`);
              },
            }, { toBePoked: { kind: 'assertion' } })), {
              poke: { kind: 'resource', label: (what) => what },
              slow: { kind: 'resource', timeout: (options) => options?.timeout },
              hang: { kind: 'resource', timeout: (options) => options?.timeout },
              dropFile: { kind: 'resource' },
              knobs: { turn: { kind: 'resource', label: (name) => name } },
            }),
          },
        }
      : {}),
    ...(behavior.artifacts === true || behavior.video === true
      ? {
          artifacts: {
            async screenshot(label, operation) {
              record(`artifacts.screenshot(${label ?? ''})`, operation);
              // A file the runner can measure, so the artifact record is complete.
              const dir = attempts[current]?.artifactsDir;
              if (dir !== undefined) {
                mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
                writeFileSync(path.join(dir, 'screenshots', 'fake.png'), FAKE_PNG);
              }
              return 'screenshots/fake.png';
            },
            ...(behavior.video === true
              ? {
                  async startVideo(operation) {
                    record('artifacts.startVideo', operation);
                    videoStartedAt = new Date().toISOString();
                  },
                  async stopVideo(operation) {
                    record('artifacts.stopVideo', operation);
                    const dir = attempts[current]?.artifactsDir;
                    if (dir === undefined || videoStartedAt === undefined) return [];
                    mkdirSync(path.join(dir, 'video'), { recursive: true });
                    writeFileSync(path.join(dir, 'video', 'fake.webm'), FAKE_WEBM);
                    const startedAt = videoStartedAt;
                    videoStartedAt = undefined;
                    return [{ path: 'video/fake.webm', startedAt }];
                  },
                }
              : {}),
          },
        }
      : {}),
  });

  return {
    engine,
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

/** A thrown `EngineError` from the built package, for behaviors that fail on purpose. */
export function engineFailure(
  code: ConstructorParameters<typeof EngineError>[0],
  message: string,
  retryable = false,
): InstanceType<typeof EngineError> {
  return new EngineError(code, message, { retryable });
}
