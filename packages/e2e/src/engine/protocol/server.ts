/**
 * The server half of the engine protocol: `serveEngine` answers the protocol
 * with an engine built by `defineEngine`, so any engine written in
 * TypeScript can run in a process of its own. An engine in another language
 * implements the same messages; this file is their reference implementation.
 */

import { ENGINE_SPI_VERSION } from '../contract.ts';
import { isEngineHandle } from '../manifest.ts';
import type {
  EngineAttemptContext,
  EngineHandle,
  EngineSnapshot,
  OperationContext,
} from '../index.ts';
import type { Secret } from '../../types.ts';
import { Connection, RPC_ERRORS, RpcError, type MessageStreams } from './connection.ts';
import {
  ENGINE_PROTOCOL_VERSION,
  decodeError,
  encodeError,
  encodeSnapshot,
  type AbortParams,
  type EngineManifest,
  type EngineMethod,
  type InitializeParams,
  type InitializeResult,
  type ReleaseParams,
  type WireCleanup,
  type WireOperation,
  type WireSignal,
} from './protocol.ts';

/** Builds the engine to serve from the options the client passed to `initialize`. */
type EngineFactory = (initializationOptions: unknown) => EngineHandle | Promise<EngineHandle>;

/**
 * Describes an engine as the manifest a server returns from `initialize`:
 * its static members and the methods its declared members answer.
 */
export function describeEngine(engine: EngineHandle): EngineManifest {
  const methods: EngineMethod[] = [];
  const declare = (method: EngineMethod, member: unknown): void => {
    if (member !== undefined) methods.push(method);
  };
  declare('engine/observe', engine.observe);
  declare('engine/locate', engine.locate);
  declare('engine/perform', engine.perform);
  declare('engine/performAt', engine.performAt);
  declare('keyboard/type', engine.keyboard?.type);
  declare('keyboard/press', engine.keyboard?.press);
  declare('keyboard/dismiss', engine.keyboard?.dismiss);
  declare('state/capture', engine.state?.capture);
  declare('state/restore', engine.state?.restore);
  declare('artifacts/screenshot', engine.artifacts?.screenshot);
  declare('artifacts/startVideo', engine.artifacts?.startVideo);
  declare('artifacts/stopVideo', engine.artifacts?.stopVideo);
  declare('session/open', engine.session?.open);
  declare('session/back', engine.session?.back);
  declare('session/restart', engine.session?.restart);
  declare('session/reset', engine.session?.reset);
  declare('lifecycle/prepare', engine.prepare);
  declare('lifecycle/finish', engine.finish);
  declare('lifecycle/init', engine.init);
  declare('lifecycle/startAttempt', engine.startAttempt);
  declare('lifecycle/settleAttempt', engine.settleAttempt);
  declare('lifecycle/endAttempt', engine.endAttempt);
  declare('lifecycle/dispose', engine.dispose);
  return {
    name: engine.name,
    version: engine.version,
    spiVersion: engine.spiVersion,
    ...(engine.platform === undefined ? {} : { platform: engine.platform }),
    ...(engine.workers === undefined ? {} : { workers: engine.workers }),
    methods,
    ...(engine.actions === undefined ? {} : { actions: engine.actions }),
    ...(engine.pointerActions === undefined ? {} : { pointerActions: engine.pointerActions }),
    ...(engine.tapModifiers === true ? { tapModifiers: true } : {}),
  };
}

/**
 * Serves one engine over one connection until the client sends `exit` or
 * the streams close. `engine` is the engine itself, or a factory that builds
 * it from the client's `initializationOptions`. Resolves once the connection
 * is closed; a server process then exits.
 *
 * Defaults to the process's stdin and stdout, the transport a client's
 * `spawnTransport` opens: keep the engine's own logging on stderr.
 */
export function serveEngine(
  engine: EngineHandle | EngineFactory,
  streams: MessageStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
  return new EngineServer(engine, streams).closed;
}

/** The engine context of the attempt a worker connection runs, between `startAttempt` and `endAttempt`. */
interface ServedAttempt {
  readonly attemptId: string;
}

class EngineServer {
  readonly #source: EngineHandle | EngineFactory;
  readonly #connection: Connection;
  readonly #signals = new Map<number, AbortController>();
  #engine: EngineHandle | undefined;
  #attempt: ServedAttempt | undefined;
  #shutdown = false;
  /** Settles once the connection is closed. */
  readonly closed: Promise<void>;

  constructor(source: EngineHandle | EngineFactory, streams: MessageStreams) {
    let onClose: () => void = () => {};
    this.closed = new Promise<void>((resolve) => {
      onClose = resolve;
    });
    this.#source = source;
    this.#connection = new Connection(streams, {
      encodeError,
      onClose: () => {
        // A client that vanished cannot abort what it started; one that shut
        // down cleanly has nothing left running, and its signals stay as it left them.
        if (!this.#shutdown) for (const controller of this.#signals.values()) controller.abort();
        this.#signals.clear();
        onClose();
      },
      requests: {
        initialize: (params) => this.#initialize(params as InitializeParams),
        shutdown: async () => {
          this.#shutdown = true;
          return null;
        },
      },
      notifications: {
        initialized: () => {},
        exit: () => this.#connection.close('the client sent exit'),
        '$/abort': (params) => {
          const { id, reason } = params as AbortParams;
          this.#signals.get(id)?.abort(reason === undefined ? undefined : decodeError(reason));
          this.#signals.delete(id);
        },
        '$/release': (params) => {
          for (const id of (params as ReleaseParams).ids) this.#signals.delete(id);
        },
      },
    });
  }

  async #initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.protocolVersion !== ENGINE_PROTOCOL_VERSION) {
      throw new RpcError({
        code: RPC_ERRORS.invalidRequest,
        message: `this engine server speaks protocol ${ENGINE_PROTOCOL_VERSION}; the client asked for ${String(params.protocolVersion)}`,
      });
    }
    if (this.#engine === undefined) {
      const engine = isEngineHandle(this.#source) ? this.#source : await this.#source(params.initializationOptions);
      if (!isEngineHandle(engine)) throw new Error('the engine factory must return a defineEngine() handle');
      if (engine.spiVersion !== ENGINE_SPI_VERSION) throw new Error(`engine "${engine.name}" declares an unsupported spiVersion`);
      this.#engine = engine;
      this.#register(engine);
    }
    return { protocolVersion: ENGINE_PROTOCOL_VERSION, manifest: describeEngine(this.#engine) };
  }

  /** Registers one request handler per declared member of `engine`. */
  #register(engine: EngineHandle): void {
    const on = <P>(method: EngineMethod, member: unknown, handler: (params: P) => Promise<unknown>): void => {
      if (member === undefined) return;
      this.#connection.onRequest(method, (params) => handler(params as P));
    };
    const { observe, locate, perform, performAt, keyboard, state, artifacts, session } = engine;
    on<{ operation: WireOperation; options?: Parameters<NonNullable<typeof observe>>[1] }>(
      'engine/observe',
      observe,
      async ({ operation, options }) => encodeSnapshot(await observe!(this.#operation(operation), options)),
    );
    on<{ expression: Parameters<NonNullable<typeof locate>>[0]; operation: WireOperation }>(
      'engine/locate',
      locate,
      async ({ expression, operation }) => ({ nodes: await locate!(expression, this.#operation(operation)) }),
    );
    on<{ ref: Parameters<NonNullable<typeof perform>>[0]; action: Parameters<NonNullable<typeof perform>>[1]; operation: WireOperation }>(
      'engine/perform',
      perform,
      ({ ref, action, operation }) => perform!(ref, action, this.#operation(operation)),
    );
    on<{ point: Parameters<NonNullable<typeof performAt>>[0]; action: Parameters<NonNullable<typeof performAt>>[1]; operation: WireOperation }>(
      'engine/performAt',
      performAt,
      ({ point, action, operation }) => performAt!(point, action, this.#operation(operation)),
    );
    on<{ text: string; replace: boolean; operation: WireOperation }>(
      'keyboard/type',
      keyboard?.type,
      ({ text, replace, operation }) => keyboard!.type(text, { replace }, this.#operation(operation)),
    );
    on<{ key: string; operation: WireOperation }>(
      'keyboard/press',
      keyboard?.press,
      ({ key, operation }) => keyboard!.press(key, this.#operation(operation)),
    );
    on<{ operation: WireOperation }>('keyboard/dismiss', keyboard?.dismiss, ({ operation }) => keyboard!.dismiss!(this.#operation(operation)));
    on<{ operation: WireOperation }>('state/capture', state?.capture, ({ operation }) => state!.capture(this.#operation(operation)));
    on<{ state: Parameters<NonNullable<typeof state>['restore']>[0]; operation: WireOperation }>(
      'state/restore',
      state?.restore,
      ({ state: snapshot, operation }) => state!.restore(snapshot, this.#operation(operation)),
    );
    on<{ label?: string; operation: WireOperation }>(
      'artifacts/screenshot',
      artifacts?.screenshot,
      async ({ label, operation }) => ({ path: await artifacts!.screenshot(label, this.#operation(operation)) }),
    );
    on<{ operation: WireOperation }>('artifacts/startVideo', artifacts?.startVideo, ({ operation }) => artifacts!.startVideo!(this.#operation(operation)));
    on<{ operation: WireOperation }>(
      'artifacts/stopVideo',
      artifacts?.stopVideo,
      async ({ operation }) => ({ segments: await artifacts!.stopVideo!(this.#operation(operation)) }),
    );
    on<{ url: string; operation: WireOperation }>('session/open', session?.open, ({ url, operation }) => session!.open!(url, this.#operation(operation)));
    on<{ operation: WireOperation }>('session/back', session?.back, ({ operation }) => session!.back!(this.#operation(operation)));
    on<{ operation: WireOperation }>('session/restart', session?.restart, ({ operation }) => session!.restart!(this.#operation(operation)));
    on<{ operation: WireOperation }>('session/reset', session?.reset, ({ operation }) => session!.reset!(this.#operation(operation)));
    this.#registerLifecycle(engine);
  }

  #registerLifecycle(engine: EngineHandle): void {
    const on = <P>(method: EngineMethod, member: unknown, handler: (params: P) => Promise<unknown>): void => {
      if (member === undefined) return;
      this.#connection.onRequest(method, (params) => handler(params as P));
    };
    const log = (line: string): void => this.#connection.notify('engine/log', { line });
    type PrepareParams = Omit<Parameters<NonNullable<EngineHandle['prepare']>>[0], 'signal' | 'log'> & { signal: WireSignal };
    on<PrepareParams>('lifecycle/prepare', engine.prepare, async ({ signal, ...info }) =>
      (await engine.prepare!({ ...info, signal: this.#signal(signal), log })) ?? null,
    );
    type FinishParams = Omit<Parameters<NonNullable<EngineHandle['finish']>>[0], 'signal' | 'log'> & { signal: WireSignal };
    on<FinishParams>('lifecycle/finish', engine.finish, ({ signal, ...info }) => engine.finish!({ ...info, signal: this.#signal(signal), log }));
    type InitParams = Omit<Parameters<NonNullable<EngineHandle['init']>>[0], 'signal' | 'log'> & { signal: WireSignal };
    on<InitParams>('lifecycle/init', engine.init, ({ signal, ...info }) => engine.init!({ ...info, signal: this.#signal(signal), log }));
    on<{ attemptId: string; artifactsDir: string; signal: WireSignal; screens: boolean }>(
      'lifecycle/startAttempt',
      engine.startAttempt,
      ({ attemptId, artifactsDir, signal, screens }) => {
        this.#attempt = { attemptId };
        return engine.startAttempt!(this.#attemptContext(attemptId, artifactsDir, this.#signal(signal), screens));
      },
    );
    on<WireCleanup>('lifecycle/settleAttempt', engine.settleAttempt, (cleanup) => engine.settleAttempt!(this.#cleanup(cleanup)));
    on<WireCleanup>('lifecycle/endAttempt', engine.endAttempt, async (cleanup) => {
      try {
        await engine.endAttempt!(this.#cleanup(cleanup));
      } finally {
        this.#attempt = undefined;
      }
    });
    on<WireCleanup & { reuseSignal?: WireSignal }>('lifecycle/dispose', engine.dispose, ({ reuseSignal, ...cleanup }) =>
      engine.dispose!({
        ...this.#cleanup(cleanup),
        ...(reuseSignal === undefined ? {} : { reuseSignal: this.#signal(reuseSignal) }),
      }),
    );
  }

  /** The attempt context an engine's `startAttempt` receives, its callbacks routed to the client. */
  #attemptContext(attemptId: string, artifactsDir: string, signal: AbortSignal, screens: boolean): EngineAttemptContext {
    const live = (): boolean => this.#attempt?.attemptId === attemptId;
    const send = (method: string, params: object): void => {
      if (live()) this.#connection.notify(method, { attemptId, ...params });
    };
    return {
      attemptId,
      artifactsDir,
      signal,
      resolveSecret: async (secret: Secret, options) => {
        const { value } = (await this.#call('attempt/resolveSecret', { attemptId, name: secret.name })) as { value: string };
        if (options?.derived !== undefined) {
          await this.#call('attempt/redact', { attemptId, name: secret.name, values: options.derived(value) });
        }
        return value;
      },
      appLog: (entry) => send('attempt/appLog', { entry }),
      navigation: (line) => send('attempt/navigation', { line }),
      environment: (facts) => send('attempt/environment', { facts }),
      ...(screens ? { screen: (snapshot: EngineSnapshot) => send('attempt/screen', { snapshot: encodeSnapshot(snapshot) }) } : {}),
    };
  }

  /** Calls the client, rethrowing its failure as the error the harness raised. */
  async #call(method: string, params: object): Promise<unknown> {
    try {
      return await this.#connection.request(method, params);
    } catch (cause) {
      throw cause instanceof RpcError ? decodeError(cause) : cause;
    }
  }

  #operation(wire: WireOperation): OperationContext {
    return {
      signal: this.#signal(wire.signal),
      timeoutMs: wire.timeoutMs,
      runId: wire.runId,
      attemptId: wire.attemptId,
      origin: wire.origin,
    };
  }

  #cleanup(wire: WireCleanup): { signal: AbortSignal; timeoutMs: number } {
    return { signal: this.#signal(wire.signal), timeoutMs: wire.timeoutMs };
  }

  /** The local signal for a wire signal: one per id, so an engine comparing signals sees the client's identity. */
  #signal(wire: WireSignal): AbortSignal {
    if (wire.aborted === true) return AbortSignal.abort(wire.reason === undefined ? undefined : decodeError(wire.reason));
    let controller = this.#signals.get(wire.id);
    if (controller === undefined) {
      controller = new AbortController();
      this.#signals.set(wire.id, controller);
    }
    return controller.signal;
  }
}
