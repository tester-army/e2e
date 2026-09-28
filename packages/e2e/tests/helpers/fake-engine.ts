/**
 * Instrumented in-memory engine for runner<->engine tests. It records the
 * lifecycle, state, artifacts, video, and contributed-fixture calls the
 * contract suite reads. Over a `scene` it is the scripted screen the
 * deterministic-tier suites drive through the real runner. Runtime classes
 * come from the built package (engine-runtime.ts) so `instanceof` checks
 * inside the built runner see the same identities.
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
  LocatorActionKind,
  LocatorExpression,
  NodeRef,
  OperationContext,
  PointerAction,
  PointerActionKind,
  SemanticNode,
  ViewportPoint,
} from '../../src/engine/index.ts';
import { defineEngine, ENGINE_SPI_VERSION, LOCATOR_ACTION_KINDS } from './engine-runtime.ts';
import { createScene, type Scene, type ScriptedNode, type Stage } from './scripted-scene.ts';

/** The EBML magic every WebM file starts with, followed by nothing worth decoding. */
const FAKE_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
/** The PNG signature, followed by nothing worth decoding. */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_VIEWPORT = { width: 1280, height: 720 } as const;

/** One engine call with the operation context it arrived with. */
export interface RecordedOperation {
  readonly method: string;
  readonly attemptIndex: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly timeoutMs: number;
  readonly abortedAtCall: boolean;
}

export interface RecordedPerform {
  readonly kind: 'perform';
  readonly attemptId: string;
  readonly id: string;
  readonly action: LocatorAction;
}

export interface RecordedPointerAction {
  readonly kind: 'performAt';
  readonly attemptId: string;
  readonly point: ViewportPoint;
  readonly action: PointerAction;
}

export interface RecordedKey {
  readonly kind: 'keyboard';
  readonly attemptId: string;
  readonly method: 'type' | 'press';
  /** The text typed, or the key pressed. */
  readonly text: string;
  readonly replace?: boolean;
}

export interface RecordedSessionCall {
  readonly kind: 'session';
  readonly attemptId: string;
  readonly method: 'open' | 'back' | 'restart' | 'reset';
  readonly url?: string;
}

/** What the test's actions asked the engine to do, with their payloads. */
export type RecordedCall = RecordedPerform | RecordedPointerAction | RecordedKey | RecordedSessionCall;

export interface FakeEngineBehavior {
  /** Throw to fail worker boot. Called before any attempt. */
  onInit?(info: EngineInitInfo): void | Promise<void>;
  /** Throw or hang to fail attempt launches. */
  onStartAttempt?(context: EngineAttemptContext, attemptIndex: number): void | Promise<void>;
  /** Throw to fail attempt close. */
  onEndAttempt?(attemptIndex: number): void | Promise<void>;
  /** Declares `settleAttempt`, called with the current attempt index; throw to hand the attempt a late failure. */
  onSettleAttempt?(attemptIndex: number): void | Promise<void>;
  /** Throw to fail worker-end disposal. */
  onDispose?(): void | Promise<void>;
  /** Throw to fail navigation (app.open); backs `session.open`. */
  onNavigate?(url: string, attemptIndex: number): void | Promise<void>;
  /** Overrides locate; default resolves one stable node, or the scene. */
  locate?(
    expression: LocatorExpression,
    operation: OperationContext,
    attemptIndex: number,
  ): readonly SemanticNode[] | Promise<readonly SemanticNode[]>;
  /** Runs on every perform, after the scene's own semantics; throw to fail it. */
  perform?(
    ref: NodeRef,
    action: LocatorAction,
    operation: OperationContext,
    attemptIndex: number,
  ): void | Promise<void>;
  /** Throw to fail observe; default returns one stable observation, or the scene. */
  observe?(operation: OperationContext, attemptIndex: number): void | Promise<void>;
  /** Overrides the observed tree; default is one Submit button. A scene replaces it. */
  tree?: SemanticNode;
  /**
   * A scripted screen, built once per attempt with a stage for timed
   * mutations: `observe` reports it, `locate` resolves over it with the
   * contract's `resolveExpression`, `perform` applies each action's in-memory
   * semantics and the node's own hooks, the keyboard edits the focused
   * field, and `perform(root, swipe)` reveals what `appearsAfterSwipes` hides.
   */
  scene?(stage: Stage): ScriptedNode[];
  /** Action kinds `perform` honors; default every kind but `swipe`, so the scroll verb and `screen.swipe()` stay absent unless declared. */
  actions?: readonly LocatorActionKind[];
  /** Declares `performAt` for these pointer kinds; every call is a `performAt` record. */
  pointerActions?: readonly PointerActionKind[];
  /** Declares a keyboard; every call is a `keyboard` record. */
  keyboard?: boolean;
  /** Declares `tapModifiers`, so modifiers on the tap actions reach `perform`. */
  tapModifiers?: boolean;
  /** Declares `session.back`, `restart`, and `reset` beside `open`; with a scene, the last two close the app. */
  navigation?: boolean;
  /** Declares the state capability. */
  state?: boolean;
  /** Declares the artifacts capability (screenshot only). */
  artifacts?: boolean;
  /**
   * Declares video recording on top of screenshots: `stopVideo` writes one
   * small `video/fake.webm` into the attempt directory and reports when the
   * segment began.
   */
  video?: boolean;
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
  /** Every engine call in order, with the operation context it carried. */
  readonly operations: RecordedOperation[];
  readonly capturedStates: EngineState[];
  readonly restoredStates: EngineState[];
  /** Calls the contributed `gadget` fixture received, in order. */
  readonly fixtureCalls: string[];
  /** Every recorded call of one attempt in order, or only those of one kind. */
  callsOf(attemptId: string): RecordedCall[];
  callsOf<K extends RecordedCall['kind']>(attemptId: string, kind: K): Extract<RecordedCall, { kind: K }>[];
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
  const calls: RecordedCall[] = [];
  const capturedStates: EngineState[] = [];
  const restoredStates: EngineState[] = [];
  const fixtureCalls: string[] = [];
  const scenes = new Map<string, Scene>();
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

  function callsOf(attemptId: string): RecordedCall[];
  function callsOf<K extends RecordedCall['kind']>(attemptId: string, kind: K): Extract<RecordedCall, { kind: K }>[];
  function callsOf(attemptId: string, kind?: RecordedCall['kind']): RecordedCall[] {
    return calls.filter((call) => call.attemptId === attemptId && (kind === undefined || call.kind === kind));
  }

  /** The scene of the attempt an operation belongs to; absent without a `scene`, and never absent with one. */
  const sceneOf = (operation: OperationContext): Scene | undefined => {
    if (behavior.scene === undefined) return undefined;
    const scene = scenes.get(operation.attemptId);
    if (scene === undefined) throw new Error(`no attempt ${operation.attemptId} is open`);
    return scene;
  };

  const tree = behavior.tree ?? FAKE_NODE;
  const location = `${FAKE_APP_URL}/`;
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
      if (behavior.scene !== undefined) scenes.set(context.attemptId, createScene(behavior.scene, location));
      await behavior.onStartAttempt?.(context, index);
    },
    ...(behavior.onSettleAttempt === undefined
      ? {}
      : {
          async settleAttempt() {
            await behavior.onSettleAttempt?.(current);
          },
        }),
    async endAttempt() {
      const index = current;
      openAttempts -= 1;
      attemptsEnded += 1;
      events.push(`endAttempt:${index}`);
      const attemptId = attempts[index]?.attemptId;
      if (attemptId !== undefined) {
        scenes.get(attemptId)?.dispose();
        scenes.delete(attemptId);
      }
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
      const scene = sceneOf(operation);
      return {
        location: scene?.location ?? location,
        root: scene?.root() ?? tree,
        viewport: FAKE_VIEWPORT,
      };
    },
    actions: behavior.actions ?? LOCATOR_ACTION_KINDS.filter((kind) => kind !== 'swipe'),
    app: behavior.app ?? { url: FAKE_APP_URL },
    session: {
      async open(url, operation) {
        record(`session.open(${url})`, operation);
        calls.push({ kind: 'session', attemptId: operation.attemptId, method: 'open', url });
        sceneOf(operation)?.open(url);
        await behavior.onNavigate?.(url, current);
      },
      ...(behavior.navigation === true
        ? {
            async back(operation) {
              record('session.back', operation);
              calls.push({ kind: 'session', attemptId: operation.attemptId, method: 'back' });
            },
            async restart(operation) {
              record('session.restart', operation);
              calls.push({ kind: 'session', attemptId: operation.attemptId, method: 'restart' });
              sceneOf(operation)?.close();
            },
            async reset(operation) {
              record('session.reset', operation);
              calls.push({ kind: 'session', attemptId: operation.attemptId, method: 'reset' });
              sceneOf(operation)?.close();
            },
          }
        : {}),
    },
    async locate(expression, operation) {
      record('locate', operation);
      if (behavior.locate !== undefined) return behavior.locate(expression, operation, current);
      return sceneOf(operation)?.locate(expression) ?? [FAKE_NODE];
    },
    async perform(ref, action, operation) {
      record(`perform(${ref.id},${action.kind})`, operation);
      calls.push({ kind: 'perform', attemptId: operation.attemptId, id: ref.id, action });
      sceneOf(operation)?.perform(ref.id, action);
      await behavior.perform?.(ref, action, operation, current);
    },
    ...(behavior.tapModifiers === undefined ? {} : { tapModifiers: behavior.tapModifiers }),
    ...(behavior.pointerActions === undefined
      ? {}
      : {
          pointerActions: behavior.pointerActions,
          async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext) {
            record('performAt', operation);
            calls.push({ kind: 'performAt', attemptId: operation.attemptId, point, action });
          },
        }),
    ...(behavior.keyboard === true
      ? {
          keyboard: {
            async type(text: string, options: { readonly replace: boolean }, operation: OperationContext) {
              record('keyboard.type', operation);
              calls.push({ kind: 'keyboard', attemptId: operation.attemptId, method: 'type', text, replace: options.replace });
              sceneOf(operation)?.type(text, options.replace);
            },
            async press(key: string, operation: OperationContext) {
              record('keyboard.press', operation);
              calls.push({ kind: 'keyboard', attemptId: operation.attemptId, method: 'press', text: key });
              sceneOf(operation)?.press(key);
            },
          },
        }
      : {}),
    ...(behavior.state === true
      ? {
          state: {
            async capture(operation) {
              record('state.capture', operation);
              const state: EngineState = { format: 'fake-state', version: 1, data: { ok: true } };
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
              // A file the runner can measure, so the artifact record is
              // complete; its bytes differ per attempt, as a screen's would.
              const dir = attempts[current]?.artifactsDir;
              if (dir !== undefined) {
                mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
                writeFileSync(
                  path.join(dir, 'screenshots', 'fake.png'),
                  Buffer.concat([FAKE_PNG, Buffer.from(operation.attemptId, 'utf8')]),
                );
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
    callsOf,
    stats: () => ({
      inits: inits.length,
      attemptsStarted,
      attemptsEnded,
      disposes,
      maxConcurrentAttempts,
    }),
  };
}
