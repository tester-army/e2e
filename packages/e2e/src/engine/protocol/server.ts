/**
 * The server half of the engine protocol: `serveEngine` answers the protocol
 * with an engine built by `defineEngine`, so any engine written in
 * TypeScript can run in a process of its own. An engine in another language
 * implements the same messages; this file is their reference implementation.
 */

import { obj } from '../../internal/objects.ts';
import { ENGINE_SPI_VERSION } from '../contract.ts';
import { isEngineHandle } from '../manifest.ts';
import type {
  EngineAttemptContext,
  EngineFinishInfo,
  EngineHandle,
  EngineInitInfo,
  EnginePrepareInfo,
  EngineSnapshot,
  OperationContext,
  ResolveSecretOptions,
} from '../index.ts';
import type { Secret } from '../../types.ts';
import { Connection, RPC_ERRORS, RpcError, type MessageStreams } from './connection.ts';
import { describeEngine } from './manifest.ts';
import {
  ENGINE_METHODS,
  ENGINE_PROTOCOL_VERSION,
  METHODS,
  SERVED_METHODS,
  decodeError,
  encodeError,
  encodeSnapshot,
  engineMember,
  type AbortParams,
  type DeriveSecretParams,
  type InitializeParams,
  type InitializeResult,
  type LifecycleMethod,
  type OperationMethod,
  type WireCleanup,
  type WireOperation,
  type WireSignal,
} from './protocol.ts';

/** Builds the engine to serve from the options the client passed to `initialize`. */
type EngineFactory = (initializationOptions: unknown) => EngineHandle | Promise<EngineHandle>;

/** A hook's info on the wire: its signal as a wire signal, its `log` routed back to the client. */
type WireInfo<T> = Omit<T, 'signal' | 'log'> & { readonly signal: WireSignal };

/** Params of `lifecycle/startAttempt`. */
interface StartAttemptParams {
  readonly attemptId: string;
  readonly artifactsDir: string;
  readonly signal: WireSignal;
  readonly screens: boolean;
}

/** Answers one lifecycle method: decodes its params into the hook's argument and calls the hook with it. */
type LifecycleHandler = (hook: (argument: unknown) => Promise<unknown>, params: unknown) => Promise<unknown>;

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

/** The attempt a worker connection runs, between `startAttempt` and `endAttempt`. */
interface ServedAttempt {
  readonly attemptId: string;
  /** Ids of the signals first seen during the attempt, forgotten when it ends. */
  readonly signals: Set<number>;
}

class EngineServer {
  readonly #source: EngineHandle | EngineFactory;
  readonly #connection: Connection;
  readonly #signals = new Map<number, AbortController>();
  /** The `derived` option of each `resolveSecret` in flight, by the id the client asks back with. */
  readonly #derivations = new Map<number, NonNullable<ResolveSecretOptions['derived']>>();
  #nextDerivation = 1;
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
        'attempt/deriveSecret': async (params) => {
          const { derivation, plaintext } = params as DeriveSecretParams;
          const derive = this.#derivations.get(derivation);
          if (derive === undefined) throw new Error(`no secret is being resolved as derivation ${String(derivation)}`);
          return { values: await derive(plaintext) };
        },
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

  /**
   * Registers one request handler per method `engine` answers. The attempt
   * hooks are always answered: the server tracks the attempt for its
   * callbacks and signals whether or not the engine has hooks of its own.
   */
  #register(engine: EngineHandle): void {
    const lifecycle = this.#lifecycleHandlers();
    for (const method of ENGINE_METHODS) {
      const spec = METHODS[method];
      const member = engineMember(engine, spec.member) ?? (SERVED_METHODS.has(method) ? async () => {} : undefined);
      if (member === undefined) continue;
      this.#connection.onRequest(
        method,
        spec.kind === 'operation'
          ? async (params) => encodeResult(spec, await member(...this.#operationArgs(spec, params)))
          : (params) => lifecycle[spec.member](member, params),
      );
    }
  }

  /** The member's arguments, in order, read off its params by name. */
  #operationArgs(spec: OperationMethod, params: unknown): unknown[] {
    const named = params as Readonly<Record<string, unknown>>;
    return spec.args.map((name) => (name === 'operation' ? this.#operation(named['operation'] as WireOperation) : named[name]));
  }

  #lifecycleHandlers(): Readonly<Record<LifecycleMethod['member'], LifecycleHandler>> {
    const log = (line: string): void => this.#connection.notify('engine/log', { line });
    const info = <T>(params: unknown): unknown => {
      const { signal, ...rest } = params as WireInfo<T>;
      return { ...rest, signal: this.#signal(signal), log };
    };
    return {
      prepare: (hook, params) => hook(info<EnginePrepareInfo>(params)),
      finish: (hook, params) => hook(info<EngineFinishInfo>(params)),
      init: (hook, params) => hook(info<EngineInitInfo>(params)),
      startAttempt: (hook, params) => {
        const { attemptId, artifactsDir, signal, screens } = params as StartAttemptParams;
        this.#attempt = { attemptId, signals: new Set() };
        return hook(this.#attemptContext(attemptId, artifactsDir, this.#signal(signal), screens));
      },
      settleAttempt: (hook, params) => hook(this.#cleanup(params as WireCleanup)),
      endAttempt: async (hook, params) => {
        // A hook that outlived its budget settles after the next attempt
        // started: it retires only the attempt it ended.
        const ending = this.#attempt;
        try {
          return await hook(this.#cleanup(params as WireCleanup));
        } finally {
          for (const id of ending?.signals ?? []) this.#signals.delete(id);
          if (this.#attempt === ending) this.#attempt = undefined;
        }
      },
      dispose: (hook, params) => {
        const { reuseSignal, ...cleanup } = params as WireCleanup & { readonly reuseSignal?: WireSignal };
        return hook(obj({ ...this.#cleanup(cleanup), reuseSignal: reuseSignal === undefined ? undefined : this.#signal(reuseSignal) }));
      },
    };
  }

  /** The attempt context an engine's `startAttempt` receives, its callbacks routed to the client. */
  #attemptContext(attemptId: string, artifactsDir: string, signal: AbortSignal, screens: boolean): EngineAttemptContext {
    const send = (method: string, params: object): void => {
      if (this.#attempt?.attemptId === attemptId) this.#connection.notify(method, { attemptId, ...params });
    };
    return {
      attemptId,
      artifactsDir,
      signal,
      resolveSecret: async (secret: Secret, options) => {
        const derived = options?.derived;
        if (derived === undefined) return this.#resolveSecret({ attemptId, name: secret.name });
        const derivation = this.#nextDerivation;
        this.#nextDerivation += 1;
        this.#derivations.set(derivation, derived);
        try {
          return await this.#resolveSecret({ attemptId, name: secret.name, derivation });
        } finally {
          this.#derivations.delete(derivation);
        }
      },
      appLog: (entry) => send('attempt/appLog', { entry }),
      navigation: (line) => send('attempt/navigation', { line }),
      environment: (facts) => send('attempt/environment', { facts }),
      ...(screens ? { screen: (snapshot: EngineSnapshot) => send('attempt/screen', { snapshot: encodeSnapshot(snapshot) }) } : {}),
    };
  }

  /**
   * Resolves a secret on the client. With a `derivation`, the client asks
   * back for the forms the engine derives from the value
   * (`attempt/deriveSecret`) and redacts them before it answers, so the
   * provider runs once.
   */
  async #resolveSecret(params: { attemptId: string; name: string; derivation?: number }): Promise<string> {
    const { value } = (await this.#call('attempt/resolveSecret', params)) as { value: string };
    return value;
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

  /**
   * The local signal for a wire signal: one per id, so an engine comparing
   * signals sees the client's identity. One first seen during an attempt is
   * forgotten when the attempt ends; the rest live as long as the connection.
   */
  #signal(wire: WireSignal): AbortSignal {
    if (wire.aborted === true) return AbortSignal.abort(wire.reason === undefined ? undefined : decodeError(wire.reason));
    let controller = this.#signals.get(wire.id);
    if (controller === undefined) {
      controller = new AbortController();
      this.#signals.set(wire.id, controller);
      this.#attempt?.signals.add(wire.id);
    }
    return controller.signal;
  }
}

/** An operation's result as JSON: a snapshot's pixels as base64, a screenshot as the path the engine wrote. */
function encodeResult(spec: OperationMethod, value: unknown): unknown {
  if (spec.result === 'snapshot') return encodeSnapshot(value as EngineSnapshot);
  if (spec.result === 'screenshot') return { path: value };
  return value;
}
