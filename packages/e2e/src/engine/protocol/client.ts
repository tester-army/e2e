/**
 * The client half of the engine protocol: `connectEngine` turns an engine
 * server into an ordinary engine handle, so the harness drives a server in
 * another process, on another machine, or in another language exactly as it
 * drives an engine in its own process. Nothing past this file knows the
 * difference.
 *
 * A handle opens at most two kinds of connection in one process, mirroring
 * where the harness calls an engine: a `run` connection per target from
 * `prepare` to `finish`, in the runner, and a `worker` connection from
 * `init` to `dispose`, in each worker. Neither shares state with the other,
 * exactly as a runner and its child-process workers share none.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InfrastructureError } from '../../internal/errors.ts';
import { obj } from '../../internal/objects.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { relativeToProjectRoot } from '../../internal/paths.ts';
import { cancelledError, withAbort } from '../../internal/time.ts';
import { secretHandle } from '../../secrets.ts';
import { EngineError } from '../contract.ts';
import { defineEngine } from '../manifest.ts';
import { resolveExpression } from '../resolve.ts';
import type {
  Engine,
  EngineAppInfo,
  EngineAttemptContext,
  EngineCleanupContext,
  EngineDisposeContext,
  EngineFinishInfo,
  EngineHandle,
  EngineInitInfo,
  EnginePrepareInfo,
  EnginePrepareResult,
  EngineSession,
  LocatorExpression,
  OperationContext,
} from '../index.ts';
import type { JsonValue, Secret } from '../../types.ts';
import { Connection, RpcError, RPC_ERRORS } from './connection.ts';
import { checkManifest, describeEngine, manifestMismatch } from './manifest.ts';
import {
  ENGINE_PROTOCOL_VERSION,
  METHODS,
  decodeError,
  decodeSnapshot,
  encodeAbortReason,
  encodeError,
  type ConnectionRole,
  type EngineManifest,
  type EngineMethod,
  type InitializeParams,
  type InitializeResult,
  type OperationMethod,
  type WireOperation,
  type WireSignal,
  type WireSnapshot,
} from './protocol.ts';
import { loopbackTransport, type EngineTransport, type TransportConnection } from './transport.ts';

/** Options of `connectEngine`. */
export interface ConnectEngineOptions {
  /**
   * What the server is: its name, version, platform, and the methods it
   * answers. The harness reads it at config load; the server's own manifest
   * from `initialize` must match it.
   */
  readonly manifest: EngineManifest;
  /** How to reach the server: `spawnTransport`, `socketTransport`, or `loopbackTransport`. */
  readonly transport: EngineTransport;
  /** Engine options the server receives in `initialize`, as JSON. */
  readonly initializationOptions?: JsonValue;
  /** The `secrets.get()` handles the server may resolve; see `Engine.secrets`. */
  readonly secrets?: readonly Secret[];
  /**
   * Fixtures this process contributes; see `Engine.fixtures`. They run on
   * the client, beside the test, and reach the server through methods of
   * their own.
   */
  readonly fixtures?: Engine['fixtures'];
  /** Checks the target's app at config load, on the client; see `Engine.validateApp`. */
  readonly validateApp?: Engine['validateApp'];
  /**
   * Answers locators on the client for a server without `engine/locate`:
   * each `locate` observes and resolves the expression over the tree with
   * the reference semantics (`resolveExpression`), so a server only has to
   * produce a tree.
   */
  readonly resolveLocators?: boolean;
  /**
   * Session hooks this process answers instead of the server, such as a
   * relaunch the host makes from outside a device. Each one wins over the
   * server's method of the same name.
   */
  readonly session?: EngineSession;
}

/**
 * The result of `artifacts/screenshot`: the path a server wrote under the
 * attempt's artifact directory, or, for a server that cannot reach it (on a
 * device, on another machine), the image itself for the client to write.
 */
type ScreenshotResult = { readonly path: string } | { readonly data: string; readonly mediaType: 'image/png' };

/** Budget of the `shutdown` handshake when a connection closes outside a cleanup hook. */
const DEFAULT_CLOSE_MS = 5000;

/** The runner version `initialize` reports; servers check the protocol version, never this. */
const CLIENT_VERSION = packageVersion(import.meta.url, '../../../package.json', '0.0.0');

/** What opening a connection needs from the hook that opens it. */
interface OpenContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly app: EngineAppInfo;
  readonly log: (line: string) => void;
}

/** One open connection and the state that lives exactly as long as it. */
interface Link {
  readonly connection: Connection;
  readonly transport: TransportConnection;
  readonly signals: SignalEncoder;
}

/**
 * Connects to an engine server and returns it as an engine handle, the
 * value a target's `engine` takes. The handle is built from the manifest
 * and checked by `defineEngine`, so a manifest is held to every rule an
 * engine in this process is.
 */
export function connectEngine(options: ConnectEngineOptions): EngineHandle {
  const handle = defineEngine(new EngineClient(checkManifest(options.manifest), options).engine());
  clients.add(handle);
  return handle;
}

declare const engineClientBrand: unique symbol;

/** An engine handle the harness drives over the protocol: one `connectEngine` made. The harness holds no other kind. */
export type EngineClientHandle = EngineHandle & { readonly [engineClientBrand]: true };

/** Handles `connectEngine` made, which already speak the protocol. */
const clients = new WeakSet<EngineHandle>();

function isEngineClient(engine: EngineHandle): engine is EngineClientHandle {
  return clients.has(engine);
}

/** The client each in-process engine is served through, so every config load gets the same one. */
const loopbacks = new WeakMap<EngineHandle, EngineClientHandle>();

/**
 * The engine as the harness drives it: over the protocol. A `connectEngine`
 * handle already is; an engine in this process is served over
 * `loopbackTransport`, so every call crosses the wire format a remote engine
 * would receive. Fixtures, the app check, and the declared secrets stay the
 * engine's own: they belong to the client half of any engine. One engine
 * always gets the same client, so a handle two targets or two config loads
 * share stays one instance.
 */
export function protocolEngine(engine: EngineHandle): EngineClientHandle {
  if (isEngineClient(engine)) return engine;
  let client = loopbacks.get(engine);
  if (client === undefined) {
    const connected = connectEngine(
      obj({
        manifest: describeEngine(engine),
        transport: loopbackTransport(engine),
        secrets: engine.secrets,
        fixtures: engine.fixtures,
        validateApp: engine.validateApp,
      }),
    );
    if (!isEngineClient(connected)) throw new Error('connectEngine returned a handle it did not make');
    client = connected;
    loopbacks.set(engine, client);
  }
  return client;
}

/** The engine half of `connectEngine`: one server's connections, and the engine members that drive them. */
class EngineClient {
  readonly #manifest: EngineManifest;
  readonly #options: ConnectEngineOptions;
  readonly #secrets: ReadonlyMap<string, Secret>;
  /** One run connection per target: a handle two targets share is prepared and finished once for each. */
  readonly #runs = new Map<string, Promise<Link>>();
  /**
   * Worker connections, oldest first. A handle one process shares (an MCP
   * session closing while the next opens) runs `init` again before the
   * previous `dispose`: calls go to the newest, `dispose` ends the oldest.
   */
  readonly #workers: Promise<Link>[] = [];
  #attempt: EngineAttemptContext | undefined;
  #screenshots = 0;

  constructor(manifest: EngineManifest, options: ConnectEngineOptions) {
    this.#manifest = manifest;
    this.#options = options;
    this.#secrets = new Map((options.secrets ?? []).map((secret) => [secret.name, secret]));
  }

  /** The engine the manifest describes, each declared method one member; `defineEngine` checks it. */
  engine(): Engine {
    const manifest = this.#manifest;
    const has = (method: EngineMethod): boolean => manifest.methods.includes(method);
    const members: Record<string, unknown> = {};
    for (const method of manifest.methods) {
      const spec = METHODS[method];
      if (spec.kind === 'operation') setMember(members, spec.member, (...args: unknown[]) => this.#operate(method, spec, args));
    }
    if (members['locate'] === undefined && this.#options.resolveLocators === true && members['observe'] !== undefined) {
      const observe = members['observe'] as NonNullable<Engine['observe']>;
      members['locate'] = async (expression: LocatorExpression, operation: OperationContext) =>
        resolveExpression(expression, (await observe(operation)).root.children ?? []);
    }
    if (this.#options.session !== undefined) {
      members['session'] = { ...(members['session'] as EngineSession | undefined), ...this.#options.session };
    }
    const runs = has('lifecycle/prepare') || has('lifecycle/finish');
    const engine: Engine = {
      ...obj({
        name: manifest.name,
        version: manifest.version,
        spiVersion: manifest.spiVersion,
        platform: manifest.platform,
        workers: manifest.workers,
        actions: manifest.actions,
        pointerActions: manifest.pointerActions,
        tapModifiers: manifest.tapModifiers,
        secrets: this.#options.secrets,
        fixtures: this.#options.fixtures,
        validateApp: this.#options.validateApp,
        prepare: runs ? (info: EnginePrepareInfo) => this.#prepare(info) : undefined,
        finish: runs ? (info: EngineFinishInfo) => this.#finish(info) : undefined,
        settleAttempt: has('lifecycle/settleAttempt')
          ? (context: EngineCleanupContext) => this.#forward('lifecycle/settleAttempt', context)
          : undefined,
      }),
      ...members,
      init: (info) => this.#init(info),
      startAttempt: (context) => this.#startAttempt(context),
      endAttempt: (context) => this.#endAttempt(context),
      dispose: (context) => this.#dispose(context),
    };
    return engine;
  }

  /** Sends one operation method over the worker connection: its arguments by name, its result decoded. */
  async #operate(method: EngineMethod, spec: OperationMethod, args: readonly unknown[]): Promise<unknown> {
    const link = await this.#workerLink();
    const params: Record<string, unknown> = {};
    spec.args.forEach((name, index) => {
      params[name] = name === 'operation' ? encodeOperation(link, args[index] as OperationContext) : args[index];
    });
    const result = await this.#call(link, method, params);
    if (spec.result === 'snapshot') return decodeSnapshot(result as WireSnapshot);
    if (spec.result === 'screenshot') return this.#screenshot(result as ScreenshotResult, params['label'] as string | undefined);
    return result ?? undefined;
  }

  async #prepare(info: EnginePrepareInfo): Promise<void | EnginePrepareResult> {
    const { signal, log, ...rest } = info;
    const pending = this.#open('run', { env: info.env, cwd: info.projectRoot, signal, app: info.app, log });
    this.#runs.set(info.targetName, pending);
    const link = await pending;
    if (!this.#manifest.methods.includes('lifecycle/prepare')) return;
    const result = await this.#call(link, 'lifecycle/prepare', { ...rest, signal: link.signals.encode(signal) });
    return (result ?? undefined) as EnginePrepareResult | undefined;
  }

  async #finish(info: EngineFinishInfo): Promise<void> {
    const pending = this.#runs.get(info.targetName);
    this.#runs.delete(info.targetName);
    const link = await pending?.catch(() => undefined);
    if (link === undefined) return;
    const deadline = Date.now() + info.timeoutMs;
    try {
      if (this.#manifest.methods.includes('lifecycle/finish')) {
        const { signal, log: _log, ...rest } = info;
        await this.#cleanupCall(link, 'lifecycle/finish', { ...rest, signal: link.signals.encode(signal) }, info);
      }
    } finally {
      await this.#close(link, deadline - Date.now());
    }
  }

  async #init(info: EngineInitInfo): Promise<void> {
    const { signal, log, ...rest } = info;
    const pending = this.#open('worker', { env: info.env, cwd: info.projectRoot, signal, app: info.app, log });
    this.#workers.push(pending);
    const link = await pending;
    if (this.#manifest.methods.includes('lifecycle/init')) {
      await this.#call(link, 'lifecycle/init', { ...rest, signal: link.signals.encode(signal) });
    }
  }

  /** Tracks the attempt, which the server's callbacks and a screenshot's bytes land in, and forwards it when the server answers. */
  async #startAttempt(context: EngineAttemptContext): Promise<void> {
    this.#attempt = context;
    this.#screenshots = 0;
    if (!this.#manifest.methods.includes('lifecycle/startAttempt')) return;
    const link = await this.#workerLink();
    await this.#call(link, 'lifecycle/startAttempt', {
      attemptId: context.attemptId,
      artifactsDir: context.artifactsDir,
      signal: link.signals.encode(context.signal),
      screens: context.screen !== undefined,
    });
  }

  async #endAttempt(context: EngineCleanupContext): Promise<void> {
    // A hook that outlived its budget settles after the next attempt
    // started: it retires only the attempt it ended.
    const ending = this.#attempt;
    try {
      if (this.#manifest.methods.includes('lifecycle/endAttempt')) await this.#forward('lifecycle/endAttempt', context);
    } finally {
      if (this.#attempt === ending) this.#attempt = undefined;
    }
  }

  /**
   * Ends the oldest worker connection. A worker that never called `init`
   * has no connection, and a fresh connection's engine has nothing to
   * release, so the server gets no `lifecycle/dispose` for it.
   */
  async #dispose(context: EngineDisposeContext): Promise<void> {
    const pending = this.#workers.shift();
    if (this.#workers.length === 0) this.#attempt = undefined;
    const link = await pending?.catch(() => undefined);
    if (link === undefined) return;
    const deadline = Date.now() + context.timeoutMs;
    try {
      if (this.#manifest.methods.includes('lifecycle/dispose')) {
        const params = {
          signal: link.signals.encode(context.signal),
          timeoutMs: context.timeoutMs,
          ...(context.reuseSignal === undefined ? {} : { reuseSignal: link.signals.encode(context.reuseSignal) }),
        };
        await this.#cleanupCall(link, 'lifecycle/dispose', params, context);
      }
    } finally {
      await this.#close(link, Math.min(DEFAULT_CLOSE_MS, deadline - Date.now()));
    }
  }

  /** Sends a cleanup hook over the worker connection. */
  async #forward(method: 'lifecycle/settleAttempt' | 'lifecycle/endAttempt', context: EngineCleanupContext): Promise<void> {
    const link = await this.#workerLink();
    await this.#call(link, method, { signal: link.signals.encode(context.signal), timeoutMs: context.timeoutMs });
  }

  /**
   * Sends a hook that ends a connection, bounded by its own signal and
   * budget: a server that ignores both must not keep the connection, or its
   * process, open past them.
   */
  async #cleanupCall(link: Link, method: 'lifecycle/finish' | 'lifecycle/dispose', params: object, context: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<void> {
    const bound = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(0, context.timeoutMs))]);
    const timedOut = (): Error =>
      new EngineError('OPERATION_TIMEOUT', `engine server ${this.#options.transport.label} did not answer ${method} within ${String(context.timeoutMs)}ms`, {
        retryable: false,
      });
    await withAbort(this.#call(link, method, params), bound, timedOut);
  }

  /**
   * Where a screenshot landed: a path the server wrote, which must stay under
   * the attempt's artifact directory, or the bytes it returned, written there
   * by the client.
   */
  async #screenshot(result: ScreenshotResult, label: string | undefined): Promise<string> {
    const attempt = this.#attempt;
    if ('path' in result) {
      if (attempt !== undefined && (path.isAbsolute(result.path) || relativeToProjectRoot(attempt.artifactsDir, path.resolve(attempt.artifactsDir, result.path)) === undefined)) {
        throw new EngineError('ENGINE_FAILURE', `engine server wrote a screenshot outside the attempt's artifact directory: ${result.path}`, { retryable: false });
      }
      return result.path;
    }
    if (attempt === undefined) throw new EngineError('INVALID_STATE', 'screenshot outside an attempt', { retryable: false });
    this.#screenshots += 1;
    const name = (label ?? 'screenshot').replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'screenshot';
    const relative = path.join('screenshots', `${String(this.#screenshots).padStart(3, '0')}-${name}.png`);
    await mkdir(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    await writeFile(path.join(attempt.artifactsDir, relative), Buffer.from(result.data, 'base64'));
    return relative;
  }

  #workerLink(): Promise<Link> {
    const newest = this.#workers.at(-1);
    if (newest === undefined) {
      throw new EngineError('INVALID_STATE', `engine "${this.#manifest.name}" is not initialized: init opens its connection`, { retryable: false });
    }
    return newest;
  }

  /** Opens a connection: the transport, then `initialize`, whose manifest must match the declared one. */
  async #open(role: ConnectionRole, context: OpenContext): Promise<Link> {
    const { transport } = this.#options;
    // The transport's signal covers opening only: the hook's own signal can
    // abort long after (a worker's init signal aborts with the worker).
    const opening = new AbortController();
    const forward = (): void => opening.abort(context.signal.reason);
    if (context.signal.aborted) forward();
    else context.signal.addEventListener('abort', forward, { once: true });
    let streams: TransportConnection;
    try {
      streams = await transport.open({ role, env: context.env, cwd: context.cwd, signal: opening.signal, app: context.app });
    } finally {
      context.signal.removeEventListener('abort', forward);
    }
    const signals = new SignalEncoder();
    const connection = this.#connection(streams, context.log, () => signals.dispose());
    signals.attach(connection);
    const link: Link = { connection, transport: streams, signals };
    try {
      const params: InitializeParams = obj({
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        clientInfo: { name: 'e2e', version: CLIENT_VERSION },
        role,
        initializationOptions: this.#options.initializationOptions,
      });
      const result = (await withAbort(this.#call(link, 'initialize', params), context.signal, cancelledError)) as InitializeResult;
      if (result?.protocolVersion !== ENGINE_PROTOCOL_VERSION) {
        throw new InfrastructureError(
          'ENGINE_FAILURE',
          `engine server ${transport.label} speaks protocol ${String(result?.protocolVersion)}; this runner speaks ${String(ENGINE_PROTOCOL_VERSION)}`,
        );
      }
      const mismatch = manifestMismatch(this.#manifest, result.manifest);
      if (mismatch !== undefined) {
        throw new InfrastructureError(
          'ENGINE_FAILURE',
          `engine server ${transport.label} announced a manifest that differs from the one declared for "${this.#manifest.name}": ${mismatch}`,
        );
      }
      connection.notify('initialized', {});
      return link;
    } catch (cause) {
      connection.close('initialize failed');
      await streams.close(0);
      throw cause;
    }
  }

  /** A connection over `streams` that routes the server's callbacks to the live attempt and its log lines to `log`. */
  #connection(streams: TransportConnection, log: (line: string) => void, onClose: () => void): Connection {
    const attempt = (attemptId: string): EngineAttemptContext | undefined =>
      this.#attempt?.attemptId === attemptId ? this.#attempt : undefined;
    const requireAttempt = (attemptId: string): EngineAttemptContext => {
      const live = attempt(attemptId);
      if (live === undefined) throw new Error(`attempt ${attemptId} is not running`);
      return live;
    };
    // An undeclared name still reaches the harness, which refuses it with
    // the message it gives an engine in its own process.
    const secretNamed = (name: string): Secret => this.#secrets.get(name) ?? secretHandle({ name, purpose: 'generic-secret' });
    // The server derives a secret's redacted forms itself, asked back while
    // the value resolves, so the provider runs once.
    const derive = async (derivation: number, plaintext: string): Promise<readonly string[]> => {
      try {
        const { values } = (await connection.request('attempt/deriveSecret', { derivation, plaintext })) as { values: string[] };
        return values;
      } catch (cause) {
        throw cause instanceof RpcError ? decodeError(cause) : cause;
      }
    };
    const connection: Connection = new Connection(streams, {
      encodeError,
      onClose,
      onNotificationError: (method, cause) =>
        log(`engine server ${this.#options.transport.label} sent a malformed "${method}" notification: ${cause instanceof Error ? cause.message : String(cause)}`),
      notifications: {
        'engine/log': (params) => log((params as { line: string }).line),
        'attempt/appLog': (params) => {
          const { attemptId, entry } = params as { attemptId: string; entry: Parameters<EngineAttemptContext['appLog']>[0] };
          attempt(attemptId)?.appLog(entry);
        },
        'attempt/navigation': (params) => {
          const { attemptId, line } = params as { attemptId: string; line: string };
          attempt(attemptId)?.navigation(line);
        },
        'attempt/environment': (params) => {
          const { attemptId, facts } = params as { attemptId: string; facts: Record<string, string> };
          attempt(attemptId)?.environment(facts);
        },
        'attempt/screen': (params) => {
          const { attemptId, snapshot } = params as { attemptId: string; snapshot: WireSnapshot };
          attempt(attemptId)?.screen?.(decodeSnapshot(snapshot));
        },
      },
      requests: {
        'attempt/resolveSecret': async (params) => {
          const { attemptId, name, derivation } = params as { attemptId: string; name: string; derivation?: number };
          const options = derivation === undefined ? undefined : { derived: (plaintext: string) => derive(derivation, plaintext) };
          return { value: await requireAttempt(attemptId).resolveSecret(secretNamed(name), options) };
        },
      },
    });
    return connection;
  }

  /** Ends a connection: `shutdown`, `exit`, then the transport, all within `timeoutMs`. */
  async #close(link: Link, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    try {
      if (link.connection.closed === undefined) {
        await withAbort(link.connection.request('shutdown'), AbortSignal.timeout(Math.max(0, timeoutMs)), cancelledError);
        link.connection.notify('exit');
      }
    } catch {
      // A server that cannot shut down cleanly is stopped by its transport.
    } finally {
      link.connection.close('the client closed the connection');
      await link.transport.close(Math.max(0, deadline - Date.now()));
    }
  }

  /** Sends one request and rethrows its failure as the error the engine member threw. */
  async #call(link: Link, method: string, params: object): Promise<unknown> {
    try {
      return await link.connection.request(method, params);
    } catch (cause) {
      if (!(cause instanceof RpcError)) throw cause;
      if (cause.code === RPC_ERRORS.connectionClosed) {
        const diagnostics = link.transport.diagnostics?.() ?? '';
        throw new InfrastructureError(
          'ENGINE_FAILURE',
          `engine server ${this.#options.transport.label} closed the connection: ${cause.message}${diagnostics === '' ? '' : `; ${diagnostics}`}`,
        );
      }
      throw decodeError(cause);
    }
  }
}

/** Sets a `member` path of `METHODS` on an engine being built: a top-level member, or a hook of a nested one. */
function setMember(engine: Record<string, unknown>, member: string, value: unknown): void {
  const [group, hook] = member.split('.') as [string, string | undefined];
  if (hook === undefined) {
    engine[group] = value;
    return;
  }
  const nested = (engine[group] ??= {}) as Record<string, unknown>;
  nested[hook] = value;
}

function encodeOperation(link: Link, operation: OperationContext): WireOperation {
  return {
    signal: link.signals.encode(operation.signal),
    timeoutMs: operation.timeoutMs,
    runId: operation.runId,
    attemptId: operation.attemptId,
    origin: operation.origin,
  };
}

/**
 * Mints one id per `AbortSignal` a connection carries and sends `$/abort`
 * when it aborts. The server forgets an id when its signal aborts or when
 * the attempt it was first seen in ends. Disposed when the connection
 * closes, which detaches it from every signal it listened to.
 */
class SignalEncoder {
  readonly #ids = new WeakMap<AbortSignal, number>();
  readonly #disposed = new AbortController();
  #connection: Connection | undefined;
  #next = 1;

  /** Sends this encoder's `$/abort` notifications over `connection`. */
  attach(connection: Connection): void {
    this.#connection = connection;
  }

  /** Removes every abort listener this encoder added. */
  dispose(): void {
    this.#disposed.abort();
  }

  encode(signal: AbortSignal): WireSignal {
    let id = this.#ids.get(signal);
    if (id === undefined) {
      id = this.#next;
      this.#next += 1;
      this.#ids.set(signal, id);
      if (!signal.aborted) {
        const abortedId = id;
        signal.addEventListener(
          'abort',
          () => this.#connection?.notify('$/abort', obj({ id: abortedId, reason: encodeAbortReason(signal.reason) })),
          { once: true, signal: this.#disposed.signal },
        );
      }
    }
    if (!signal.aborted) return { id };
    return obj({ id, aborted: true as const, reason: encodeAbortReason(signal.reason) });
  }
}
