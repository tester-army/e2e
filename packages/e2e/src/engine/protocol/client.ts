/**
 * The client half of the engine protocol: `connectEngine` turns an engine
 * server into an ordinary engine handle, so the harness drives a server in
 * another process, on another machine, or in another language exactly as it
 * drives an engine in its own process. Nothing past this file knows the
 * difference.
 *
 * A handle opens at most two connections in one process, mirroring where
 * the harness calls an engine: a `run` connection from `prepare` to
 * `finish`, in the runner, and a `worker` connection from `init` to
 * `dispose`, in each worker. Neither shares state with the other, exactly as
 * a runner and its child-process workers share none.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, InfrastructureError } from '../../internal/errors.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { secretHandle } from '../../secrets.ts';
import { ENGINE_SPI_VERSION, EngineError, LOCATOR_ACTION_KINDS, POINTER_ACTION_KINDS } from '../contract.ts';
import { defineEngine } from '../manifest.ts';
import { resolveExpression } from '../resolve.ts';
import type {
  Engine,
  EngineAppInfo,
  EngineAttemptContext,
  EngineHandle,
  OperationContext,
} from '../index.ts';
import type { JsonValue, Secret } from '../../types.ts';
import { Connection, RpcError, RPC_ERRORS } from './connection.ts';
import {
  ENGINE_METHODS,
  ENGINE_PROTOCOL_VERSION,
  decodeError,
  decodeSnapshot,
  encodeAbortReason,
  encodeError,
  type ConnectionRole,
  type EngineManifest,
  type EngineMethod,
  type InitializeParams,
  type InitializeResult,
  type WireOperation,
  type WireSignal,
  type WireSnapshot,
} from './protocol.ts';
import { loopbackTransport, type EngineTransport, type TransportConnection } from './transport.ts';
import { describeEngine } from './server.ts';

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
}

/**
 * The result of `artifacts/screenshot`: the path a server wrote under the
 * attempt's artifact directory, or, for a server that cannot reach it (on a
 * device, on another machine), the image itself for the client to write.
 */
type ScreenshotResult = { readonly path: string } | { readonly data: string; readonly mediaType: 'image/png' };

/** Budget of the `shutdown` handshake when a connection closes outside a cleanup hook. */
const DEFAULT_CLOSE_MS = 5000;

/** One open connection and the state that lives exactly as long as it. */
interface Link {
  readonly connection: Connection;
  readonly transport: TransportConnection;
  readonly signals: SignalEncoder;
  readonly log: ((line: string) => void) | undefined;
}

/**
 * Connects to an engine server and returns it as an engine handle, the
 * value a target's `engine` takes.
 */
export function connectEngine(options: ConnectEngineOptions): EngineHandle {
  const manifest = checkManifest(options.manifest);
  const declared = new Set<EngineMethod>(manifest.methods);
  const has = (method: EngineMethod): boolean => declared.has(method);
  const { transport } = options;
  const secrets = new Map((options.secrets ?? []).map((secret) => [secret.name, secret]));
  // One run connection per target: a handle two targets share is prepared
  // and finished once for each.
  const runs = new Map<string, Promise<Link>>();
  let worker: Promise<Link> | undefined;
  let attempt: EngineAttemptContext | undefined;
  let screenshots = 0;

  const currentAttempt = (attemptId: string): EngineAttemptContext | undefined =>
    attempt?.attemptId === attemptId ? attempt : undefined;

  // An undeclared name still reaches the harness, which refuses it with
  // the message it gives an engine in its own process.
  const secretNamed = (name: string): Secret => secrets.get(name) ?? secretHandle({ name, purpose: 'generic-secret' });

  const open = async (
    role: ConnectionRole,
    context: {
      env: Readonly<Record<string, string | undefined>>;
      cwd: string;
      signal: AbortSignal;
      app?: EngineAppInfo;
      log?: (line: string) => void;
    },
  ): Promise<Link> => {
    // The transport's signal covers opening only: the hook's own signal can
    // abort long after (a worker's init signal aborts with the worker).
    const opening = new AbortController();
    const forward = (): void => opening.abort(context.signal.reason);
    if (context.signal.aborted) forward();
    else context.signal.addEventListener('abort', forward, { once: true });
    let streams: TransportConnection;
    try {
      streams = await transport.open({
        role,
        env: context.env,
        cwd: context.cwd,
        signal: opening.signal,
        ...(context.app === undefined ? {} : { app: context.app }),
      });
    } finally {
      context.signal.removeEventListener('abort', forward);
    }
    const requireAttempt = (attemptId: string): EngineAttemptContext => {
      const live = currentAttempt(attemptId);
      if (live === undefined) throw new Error(`attempt ${attemptId} is not running`);
      return live;
    };
    const connection = new Connection(streams, {
      encodeError,
      notifications: {
        'engine/log': (params) => link.log?.((params as { line: string }).line),
        'attempt/appLog': (params) => {
          const { attemptId, entry } = params as { attemptId: string; entry: Parameters<EngineAttemptContext['appLog']>[0] };
          currentAttempt(attemptId)?.appLog(entry);
        },
        'attempt/navigation': (params) => {
          const { attemptId, line } = params as { attemptId: string; line: string };
          currentAttempt(attemptId)?.navigation(line);
        },
        'attempt/environment': (params) => {
          const { attemptId, facts } = params as { attemptId: string; facts: Record<string, string> };
          currentAttempt(attemptId)?.environment(facts);
        },
        'attempt/screen': (params) => {
          const { attemptId, snapshot } = params as { attemptId: string; snapshot: WireSnapshot };
          currentAttempt(attemptId)?.screen?.(decodeSnapshot(snapshot));
        },
      },
      requests: {
        'attempt/resolveSecret': async (params) => {
          const { attemptId, name } = params as { attemptId: string; name: string };
          return { value: await requireAttempt(attemptId).resolveSecret(secretNamed(name)) };
        },
        'attempt/redact': async (params) => {
          const { attemptId, name, values } = params as { attemptId: string; name: string; values: string[] };
          await requireAttempt(attemptId).resolveSecret(secretNamed(name), { derived: () => values });
          return null;
        },
      },
    });
    const link: Link = { connection, transport: streams, signals: new SignalEncoder(connection), log: context.log };
    try {
      const params: InitializeParams = {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        clientInfo: { name: 'e2e', version: CLIENT_VERSION },
        role,
        ...(options.initializationOptions === undefined ? {} : { initializationOptions: options.initializationOptions }),
      };
      const result = (await abortable(call(link, 'initialize', params), context.signal)) as InitializeResult;
      const mismatch = manifestMismatch(manifest, result.manifest);
      if (mismatch !== undefined) {
        throw new InfrastructureError(
          'ENGINE_FAILURE',
          `engine server ${transport.label} announced a manifest that differs from the one declared for "${manifest.name}": ${mismatch}`,
        );
      }
      connection.notify('initialized', {});
      return link;
    } catch (cause) {
      connection.close('initialize failed');
      await streams.close(0);
      throw cause;
    }
  };

  /** Ends a connection: `shutdown`, `exit`, then the transport, all within `timeoutMs`. */
  const close = async (link: Link, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    try {
      if (link.connection.closed === undefined) {
        await abortable(link.connection.request('shutdown'), AbortSignal.timeout(Math.max(0, timeoutMs)));
        link.connection.notify('exit');
      }
    } catch {
      // A server that cannot shut down cleanly is stopped by its transport.
    } finally {
      link.connection.close('the client closed the connection');
      await link.transport.close(Math.max(0, deadline - Date.now()));
    }
  };

  /** Sends one request and rethrows its failure as the error the engine member threw. */
  const call = async (link: Link, method: string, params: object): Promise<unknown> => {
    try {
      return await link.connection.request(method, params);
    } catch (cause) {
      if (!(cause instanceof RpcError)) throw cause;
      if (cause.code === RPC_ERRORS.connectionClosed) {
        const diagnostics = link.transport.diagnostics?.() ?? '';
        throw new InfrastructureError(
          'ENGINE_FAILURE',
          `engine server ${transport.label} closed the connection: ${cause.message}${diagnostics === '' ? '' : `; ${diagnostics}`}`,
        );
      }
      throw decodeError(cause);
    }
  };

  const workerLink = (): Promise<Link> => {
    if (worker === undefined) {
      throw new EngineError('INVALID_STATE', `engine "${manifest.name}" is not initialized: init opens its connection`, { retryable: false });
    }
    return worker;
  };

  /** Sends one engine method over the worker connection, with its operation context encoded. */
  const send = async (method: EngineMethod, operation: OperationContext, params: object = {}): Promise<unknown> => {
    const link = await workerLink();
    return call(link, method, { ...params, operation: encodeOperation(link, operation) });
  };

  const observe: Engine['observe'] = has('engine/observe')
    ? async (operation, observeOptions) =>
        decodeSnapshot((await send('engine/observe', operation, observeOptions === undefined ? {} : { options: observeOptions })) as WireSnapshot)
    : undefined;

  let locate: Engine['locate'];
  if (has('engine/locate')) {
    locate = async (expression, operation) => ((await send('engine/locate', operation, { expression })) as { nodes: [] }).nodes;
  } else if (options.resolveLocators === true && observe !== undefined) {
    locate = async (expression, operation) => resolveExpression(expression, (await observe(operation)).root.children ?? []);
  }

  const runLifecycle = has('lifecycle/prepare') || has('lifecycle/finish');
  const sessionHook = (method: EngineMethod) => async (operation: OperationContext): Promise<void> => {
    await send(method, operation);
  };

  const engine: Engine = {
    name: manifest.name,
    version: manifest.version,
    spiVersion: manifest.spiVersion,
    ...(manifest.platform === undefined ? {} : { platform: manifest.platform }),
    ...(manifest.workers === undefined ? {} : { workers: manifest.workers }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.fixtures === undefined ? {} : { fixtures: options.fixtures }),
    ...(options.validateApp === undefined ? {} : { validateApp: options.validateApp }),
    ...(observe === undefined ? {} : { observe }),
    ...(locate === undefined ? {} : { locate }),
    ...(has('engine/perform')
      ? {
          actions: manifest.actions ?? [],
          ...(manifest.tapModifiers === true ? { tapModifiers: true } : {}),
          perform: async (ref, action, operation) => {
            await send('engine/perform', operation, { ref, action });
          },
        }
      : {}),
    ...(has('engine/performAt')
      ? {
          pointerActions: manifest.pointerActions ?? [],
          performAt: async (point, action, operation) => {
            await send('engine/performAt', operation, { point, action });
          },
        }
      : {}),
    ...(has('keyboard/type') && has('keyboard/press')
      ? {
          keyboard: {
            type: async (text, { replace }, operation) => {
              await send('keyboard/type', operation, { text, replace });
            },
            press: async (key, operation) => {
              await send('keyboard/press', operation, { key });
            },
            ...(has('keyboard/dismiss')
              ? {
                  dismiss: async (operation: OperationContext) => {
                    await send('keyboard/dismiss', operation);
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(has('state/capture') && has('state/restore')
      ? {
          state: {
            capture: async (operation) => (await send('state/capture', operation)) as Awaited<ReturnType<NonNullable<Engine['state']>['capture']>>,
            restore: async (state, operation) => {
              await send('state/restore', operation, { state });
            },
          },
        }
      : {}),
    ...(has('artifacts/screenshot')
      ? {
          artifacts: {
            screenshot: async (label, operation) => {
              const result = (await send('artifacts/screenshot', operation, label === undefined ? {} : { label })) as ScreenshotResult;
              if ('path' in result) {
                if (attempt === undefined) return result.path;
                const relative = path.relative(attempt.artifactsDir, path.resolve(attempt.artifactsDir, result.path));
                if (path.isAbsolute(result.path) || relative.startsWith('..') || path.isAbsolute(relative)) {
                  throw new EngineError('ENGINE_FAILURE', `engine server wrote a screenshot outside the attempt's artifact directory: ${result.path}`, { retryable: false });
                }
                return result.path;
              }
              if (attempt === undefined) throw new EngineError('INVALID_STATE', 'screenshot outside an attempt', { retryable: false });
              screenshots += 1;
              const relative = path.join('screenshots', `${String(screenshots).padStart(3, '0')}-${(label ?? 'screenshot').replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'screenshot'}.png`);
              await mkdir(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
              await writeFile(path.join(attempt.artifactsDir, relative), Buffer.from(result.data, 'base64'));
              return relative;
            },
            ...(has('artifacts/startVideo') && has('artifacts/stopVideo')
              ? {
                  startVideo: async (operation: OperationContext) => {
                    await send('artifacts/startVideo', operation);
                  },
                  stopVideo: async (operation: OperationContext) =>
                    ((await send('artifacts/stopVideo', operation)) as { segments: [] }).segments,
                }
              : {}),
          },
        }
      : {}),
    ...(has('session/open') || has('session/back') || has('session/restart') || has('session/reset')
      ? {
          session: {
            ...(has('session/open')
              ? {
                  open: async (url: string, operation: OperationContext) => {
                    await send('session/open', operation, { url });
                  },
                }
              : {}),
            ...(has('session/back') ? { back: sessionHook('session/back') } : {}),
            ...(has('session/restart') ? { restart: sessionHook('session/restart') } : {}),
            ...(has('session/reset') ? { reset: sessionHook('session/reset') } : {}),
          },
        }
      : {}),
    ...(runLifecycle
      ? {
          prepare: async (info) => {
            const { signal, log, ...rest } = info;
            const pending = open('run', { env: info.env, cwd: info.projectRoot, signal, app: info.app, log });
            runs.set(info.targetName, pending);
            const link = await pending;
            if (!has('lifecycle/prepare')) return;
            const result = await call(link, 'lifecycle/prepare', { ...rest, signal: link.signals.encode(signal) });
            return result === null ? undefined : (result as Awaited<ReturnType<NonNullable<Engine['prepare']>>>);
          },
          finish: async (info) => {
            const pending = runs.get(info.targetName);
            runs.delete(info.targetName);
            if (pending === undefined) return;
            const link = await pending.catch(() => undefined);
            if (link === undefined) return;
            const deadline = Date.now() + info.timeoutMs;
            try {
              if (has('lifecycle/finish')) {
                const { signal, log: _log, ...rest } = info;
                await call(link, 'lifecycle/finish', { ...rest, signal: link.signals.encode(signal) });
              }
            } finally {
              await close(link, Math.max(0, deadline - Date.now()));
            }
          },
        }
      : {}),
    init: async (info) => {
      const { signal, log, ...rest } = info;
      worker = open('worker', { env: info.env, cwd: info.projectRoot, signal, app: info.app, log });
      const link = await worker;
      if (has('lifecycle/init')) await call(link, 'lifecycle/init', { ...rest, signal: link.signals.encode(signal) });
    },
    ...(has('lifecycle/startAttempt')
      ? {
          startAttempt: async (context) => {
            attempt = context;
            screenshots = 0;
            const link = await workerLink();
            await call(link, 'lifecycle/startAttempt', {
              attemptId: context.attemptId,
              artifactsDir: context.artifactsDir,
              signal: link.signals.encode(context.signal),
              screens: context.screen !== undefined,
            });
          },
        }
      : {}),
    ...(has('lifecycle/settleAttempt')
      ? {
          settleAttempt: async (context) => {
            const link = await workerLink();
            await call(link, 'lifecycle/settleAttempt', { signal: link.signals.encode(context.signal), timeoutMs: context.timeoutMs });
          },
        }
      : {}),
    ...(has('lifecycle/endAttempt')
      ? {
          endAttempt: async (context) => {
            try {
              const link = await workerLink();
              await call(link, 'lifecycle/endAttempt', { signal: link.signals.encode(context.signal), timeoutMs: context.timeoutMs });
            } finally {
              attempt = undefined;
            }
          },
        }
      : {}),
    dispose: async (context) => {
      const pending = worker;
      worker = undefined;
      attempt = undefined;
      if (pending === undefined) return;
      const link = await pending.catch(() => undefined);
      if (link === undefined) return;
      const deadline = Date.now() + context.timeoutMs;
      try {
        if (has('lifecycle/dispose')) {
          await call(link, 'lifecycle/dispose', {
            signal: link.signals.encode(context.signal),
            timeoutMs: context.timeoutMs,
            ...(context.reuseSignal === undefined ? {} : { reuseSignal: link.signals.encode(context.reuseSignal) }),
          });
        }
      } finally {
        await close(link, Math.max(0, Math.min(DEFAULT_CLOSE_MS, deadline - Date.now())));
      }
    },
  };
  const handle = defineEngine(engine);
  clients.add(handle);
  return handle;
}

/** Handles `connectEngine` made, which already speak the protocol. */
const clients = new WeakSet<EngineHandle>();

/** Whether `engine` is a protocol client from `connectEngine`, rather than an engine in this process. */
export function isEngineClient(engine: EngineHandle): boolean {
  return clients.has(engine);
}

/** The runner version `initialize` reports; servers check the protocol version, never this. */
const CLIENT_VERSION = packageVersion(import.meta.url, '../../../package.json', '0.0.0');

function encodeOperation(link: Link, operation: OperationContext): WireOperation {
  return {
    signal: link.signals.encode(operation.signal),
    timeoutMs: operation.timeoutMs,
    runId: operation.runId,
    attemptId: operation.attemptId,
    origin: operation.origin,
  };
}

/** Rejects with the signal's reason once it aborts, leaving `promise` to settle on its own. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Its settling is nobody's business any more, a rejection included.
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

/**
 * Mints one id per `AbortSignal` a connection carries, sends `$/abort` when
 * it aborts, and `$/release` once the signal is garbage, so the server keeps
 * no state for a signal the client can no longer send.
 */
class SignalEncoder {
  readonly #connection: Connection;
  readonly #ids = new WeakMap<AbortSignal, number>();
  readonly #released: number[] = [];
  readonly #registry = new FinalizationRegistry<number>((id) => this.#release(id));
  #next = 1;

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  encode(signal: AbortSignal): WireSignal {
    let id = this.#ids.get(signal);
    if (id === undefined) {
      id = this.#next;
      this.#next += 1;
      this.#ids.set(signal, id);
      if (!signal.aborted) {
        const abortedId = id;
        const connection = this.#connection;
        signal.addEventListener(
          'abort',
          () => {
            const reason = encodeAbortReason(signal.reason);
            connection.notify('$/abort', { id: abortedId, ...(reason === undefined ? {} : { reason }) });
          },
          { once: true },
        );
        this.#registry.register(signal, id);
      }
    }
    if (!signal.aborted) return { id };
    const reason = encodeAbortReason(signal.reason);
    return { id, aborted: true, ...(reason === undefined ? {} : { reason }) };
  }

  #release(id: number): void {
    this.#released.push(id);
    if (this.#released.length > 1) return;
    queueMicrotask(() => {
      this.#connection.notify('$/release', { ids: this.#released.splice(0) });
    });
  }
}

/** Methods that make one engine member only together: each needs the one beside it. */
const METHOD_DEPENDENCIES: readonly (readonly [EngineMethod, EngineMethod])[] = [
  ['keyboard/type', 'keyboard/press'],
  ['keyboard/press', 'keyboard/type'],
  ['keyboard/dismiss', 'keyboard/type'],
  ['state/capture', 'state/restore'],
  ['state/restore', 'state/capture'],
  ['artifacts/startVideo', 'artifacts/stopVideo'],
  ['artifacts/stopVideo', 'artifacts/startVideo'],
  ['artifacts/startVideo', 'artifacts/screenshot'],
];

/** Validates a declared manifest at config load, the way `defineEngine` validates an engine. */
function checkManifest(manifest: EngineManifest): EngineManifest {
  const invalid = (detail: string): ConfigurationError =>
    new ConfigurationError('INVALID_CONFIG', `connectEngine: ${detail}`);
  if (typeof manifest !== 'object' || manifest === null) throw invalid('manifest must be an object');
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') throw invalid('manifest.name must be a non-empty string');
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') throw invalid('manifest.version must be a non-empty string');
  if (manifest.spiVersion !== ENGINE_SPI_VERSION) {
    throw invalid(`manifest.spiVersion ${String(manifest.spiVersion)} is not ${ENGINE_SPI_VERSION}`);
  }
  if (!Array.isArray(manifest.methods)) throw invalid('manifest.methods must be an array of engine methods');
  const known: readonly string[] = ENGINE_METHODS;
  const seen = new Set<string>();
  for (const method of manifest.methods) {
    if (!known.includes(method)) throw invalid(`manifest.methods names unknown method ${JSON.stringify(method)}`);
    if (seen.has(method)) throw invalid(`manifest.methods lists "${method}" twice`);
    seen.add(method);
  }
  const kinds = (member: 'actions' | 'pointerActions', allowed: readonly string[]): void => {
    const value = manifest[member];
    if (value === undefined) return;
    if (!Array.isArray(value)) throw invalid(`manifest.${member} must be an array`);
    for (const kind of value) if (!allowed.includes(kind)) throw invalid(`manifest.${member} names unknown kind ${JSON.stringify(kind)}`);
  };
  kinds('actions', LOCATOR_ACTION_KINDS);
  kinds('pointerActions', POINTER_ACTION_KINDS);
  if (manifest.actions !== undefined && !seen.has('engine/perform')) throw invalid('manifest.actions needs "engine/perform"');
  if (manifest.tapModifiers === true && !seen.has('engine/perform')) throw invalid('manifest.tapModifiers needs "engine/perform"');
  if (manifest.pointerActions !== undefined && !seen.has('engine/performAt')) throw invalid('manifest.pointerActions needs "engine/performAt"');
  // A member made of several methods needs all of them; half of one would
  // otherwise vanish from the handle instead of failing here.
  for (const [method, required] of METHOD_DEPENDENCIES) {
    if (seen.has(method) && !seen.has(required)) throw invalid(`manifest.methods lists "${method}" without "${required}"`);
  }
  return manifest;
}

/** Names the fields where the server's manifest differs from the declared one, or undefined when they agree. */
function manifestMismatch(declared: EngineManifest, announced: EngineManifest | undefined): string | undefined {
  if (announced === undefined) return 'the server sent none';
  const canonical = (manifest: EngineManifest): Record<string, string> => ({
    name: manifest.name,
    version: manifest.version,
    spiVersion: String(manifest.spiVersion),
    platform: manifest.platform ?? '(none)',
    workers: manifest.workers === undefined ? '(none)' : String(manifest.workers),
    methods: [...manifest.methods].toSorted().join(', '),
    actions: [...(manifest.actions ?? [])].toSorted().join(', '),
    pointerActions: [...(manifest.pointerActions ?? [])].toSorted().join(', '),
    tapModifiers: String(manifest.tapModifiers === true),
  });
  const expected = canonical(declared);
  const actual = canonical(announced);
  const fields = Object.keys(expected).filter((field) => expected[field] !== actual[field]);
  if (fields.length === 0) return undefined;
  return fields.map((field) => `${field} is "${actual[field]}", declared "${expected[field]}"`).join('; ');
}

/** The client each in-process engine is served through, so every config load gets the same one. */
const loopbacks = new WeakMap<EngineHandle, EngineHandle>();

/**
 * `engine` served in this process over the protocol: the client handle every
 * target runs on. Every engine member crosses the wire; fixtures, the app
 * check, and the declared secrets stay the engine's own, since they belong
 * to the client half of any engine. One engine always gets the same client,
 * so a handle two targets or two config loads share stays one instance.
 */
export function loopbackEngine(engine: EngineHandle): EngineHandle {
  const known = loopbacks.get(engine);
  if (known !== undefined) return known;
  const client = connectEngine({
    manifest: describeEngine(engine),
    transport: loopbackTransport(engine),
    ...(engine.secrets === undefined ? {} : { secrets: engine.secrets }),
    ...(engine.fixtures === undefined ? {} : { fixtures: engine.fixtures }),
    ...(engine.validateApp === undefined ? {} : { validateApp: engine.validateApp }),
  });
  loopbacks.set(engine, client);
  return client;
}
