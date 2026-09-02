/**
 * Instrumented in-memory driver-1 implementation for runner<->driver contract
 * tests. Runtime classes come from the built package so `instanceof` checks
 * inside the built runner (used by run-project.ts) see the same identities.
 */

import type {
  Driver,
  DriverContext,
  DriverSession,
  DriverState,
  LocatorAction,
  LocatorExpression,
  NodeRef,
  Observation,
  OperationContext,
  SemanticNode,
  Target,
} from '../../src/driver/index.ts';

const builtDriverModule = '../../dist/driver/index.js';
const { defineDriver, DriverError } = (await import(
  builtDriverModule
)) as typeof import('../../src/driver/index.ts');

export { DriverError as BuiltDriverError };

export interface RecordedOperation {
  readonly method: string;
  readonly sessionIndex: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly timeoutMs: number;
  readonly abortedAtCall: boolean;
}

export interface FakeDriverBehavior {
  /** Throw to fail one-time provisioning. Called before any launch. */
  onPrepare?(targets: readonly Target[]): void | Promise<void>;
  /** Throw or hang to fail launches. Called before the session is created. */
  onLaunch?(context: DriverContext, sessionIndex: number): void | Promise<void>;
  /** Throw to fail session close. */
  onClose?(sessionIndex: number): void | Promise<void>;
  /** Throw to fail app.open. */
  onAppOpen?(path: string | undefined, sessionIndex: number): void | Promise<void>;
  /** Overrides screen.resolve; default resolves one stable node. */
  resolve?(
    expression: LocatorExpression,
    operation: OperationContext,
    sessionIndex: number,
  ): readonly NodeRef[] | Promise<readonly NodeRef[]>;
  /** Overrides screen.perform; default succeeds. */
  perform?(
    ref: NodeRef,
    action: LocatorAction,
    operation: OperationContext,
    sessionIndex: number,
  ): void | Promise<void>;
  /** Throw to fail observe; default returns one stable observation. */
  observe?(operation: OperationContext, sessionIndex: number): void | Promise<void>;
  /** Overrides the observed tree; default is one Submit button. */
  tree?: SemanticNode;
  /** Overrides screen.read; default echoes the one stable node. */
  read?(ref: NodeRef, operation: OperationContext, sessionIndex: number): SemanticNode;
  /** Enables captureState/restoreState. */
  state?: boolean;
}

export interface FakeDriverHandle {
  readonly driver: Driver;
  /** Ordered event names, e.g. 'launch:0', 'close:0', 'dispose'. */
  readonly events: string[];
  readonly launches: DriverContext[];
  /** One entry per `prepare` call, holding the targets it received. */
  readonly prepares: (readonly Target[])[];
  readonly operations: RecordedOperation[];
  readonly capturedStates: DriverState[];
  readonly restoredStates: DriverState[];
  stats(): {
    launches: number;
    sessionsOpened: number;
    closes: number;
    disposes: number;
    maxConcurrentSessions: number;
  };
}

const NODE: SemanticNode = {
  ref: { id: 'node-1', revision: 'rev-1' },
  role: 'button',
  name: 'Submit',
  states: { hidden: false },
};

/** Creates a branded, instrumented fake driver. */
export function createFakeDriver(behavior: FakeDriverBehavior = {}): FakeDriverHandle {
  const events: string[] = [];
  const launches: DriverContext[] = [];
  const prepares: (readonly Target[])[] = [];
  const operations: RecordedOperation[] = [];
  const capturedStates: DriverState[] = [];
  const restoredStates: DriverState[] = [];
  let openSessions = 0;
  let sessionsOpened = 0;
  let maxConcurrentSessions = 0;
  let closes = 0;
  let disposes = 0;

  function record(method: string, sessionIndex: number, operation: OperationContext): void {
    operations.push({
      method,
      sessionIndex,
      runId: operation.runId,
      attemptId: operation.attemptId,
      timeoutMs: operation.timeoutMs,
      abortedAtCall: operation.signal.aborted,
    });
  }

  function createSession(sessionIndex: number): DriverSession {
    let closed = false;
    const session: DriverSession = {
      app: {
        async open(path, operation) {
          record(`app.open(${path ?? ''})`, sessionIndex, operation);
          await behavior.onAppOpen?.(path, sessionIndex);
        },
        async restart(operation) {
          record('app.restart', sessionIndex, operation);
        },
        async clearState(operation) {
          record('app.clearState', sessionIndex, operation);
        },
        async back(operation) {
          record('app.back', sessionIndex, operation);
        },
        async deepLink(url, operation) {
          record(`app.deepLink(${url})`, sessionIndex, operation);
        },
      },
      screen: {
        async resolve(expression, operation) {
          record('screen.resolve', sessionIndex, operation);
          if (behavior.resolve !== undefined) {
            return behavior.resolve(expression, operation, sessionIndex);
          }
          return [NODE.ref];
        },
        async read(ref, operation) {
          record(`screen.read(${ref.id})`, sessionIndex, operation);
          return behavior.read?.(ref, operation, sessionIndex) ?? { ...NODE, ref };
        },
        async perform(ref, action, operation) {
          record(`screen.perform(${action.kind})`, sessionIndex, operation);
          await behavior.perform?.(ref, action, operation, sessionIndex);
        },
        async swipe(direction, momentum, operation) {
          record(`screen.swipe(${direction})`, sessionIndex, operation);
        },
      },
      actions: {
        async tap(target, operation) {
          record(`actions.tap(${'ref' in target ? target.ref.id : 'point'})`, sessionIndex, operation);
        },
        async type(target, value, sensitive, operation) {
          record('actions.type', sessionIndex, operation);
        },
        async scroll(direction, options, operation) {
          record('actions.scroll', sessionIndex, operation);
        },
        async press(key, operation) {
          record('actions.press', sessionIndex, operation);
        },
      },
      artifacts: {
        async screenshot(label, operation) {
          record('artifacts.screenshot', sessionIndex, operation);
          return `screenshot-${sessionIndex}.png`;
        },
      },
      async observe(operation) {
        record('observe', sessionIndex, operation);
        await behavior.observe?.(operation, sessionIndex);
        const observation: Observation = {
          revision: 'rev-1',
          capturedAt: new Date().toISOString(),
          tree: behavior.tree ?? NODE,
          viewport: { width: 1280, height: 720, scale: 1 },
          redaction: { secureNodeCount: 0, maskedRegionCount: 0, complete: true },
        };
        return observation;
      },
      async runtime(operation) {
        record('runtime', sessionIndex, operation);
        return { viewport: { width: 1280, height: 720, scale: 1 } };
      },
      async close(context) {
        record('close', sessionIndex, context as OperationContext);
        if (closed) return;
        closed = true;
        openSessions -= 1;
        closes += 1;
        events.push(`close:${sessionIndex}`);
        await behavior.onClose?.(sessionIndex);
      },
    };
    if (behavior.state === true) {
      return {
        ...session,
        async captureState(operation) {
          record('captureState', sessionIndex, operation);
          const state: DriverState = {
            format: 'fake-driver-state',
            version: 1,
            data: { sessionIndex },
          };
          capturedStates.push(state);
          return state;
        },
        async restoreState(state, operation) {
          record('restoreState', sessionIndex, operation);
          restoredStates.push(state);
        },
      };
    }
    return session;
  }

  const driver = defineDriver({
    id: 'fake-driver',
    version: '1.0.0',
    platforms: ['web'],
    spiVersion: 1,
    capabilities: {
      fixtures: ['screen'],
      artifacts: ['screenshot'],
      state: behavior.state === true,
    },
    async prepare(targets) {
      prepares.push(targets);
      events.push(`prepare:${String(targets.length)}`);
      await behavior.onPrepare?.(targets);
    },
    async launch(context) {
      const sessionIndex = launches.length;
      launches.push(context);
      events.push(`launch:${sessionIndex}`);
      await behavior.onLaunch?.(context, sessionIndex);
      openSessions += 1;
      sessionsOpened += 1;
      maxConcurrentSessions = Math.max(maxConcurrentSessions, openSessions);
      return createSession(sessionIndex);
    },
    async dispose() {
      disposes += 1;
      events.push('dispose');
    },
  });

  return {
    driver,
    events,
    launches,
    prepares,
    operations,
    capturedStates,
    restoredStates,
    stats: () => ({
      launches: launches.length,
      sessionsOpened,
      closes,
      disposes,
      maxConcurrentSessions,
    }),
  };
}
