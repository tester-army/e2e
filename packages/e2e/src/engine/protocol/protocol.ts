/**
 * The engine protocol: the engine contract as messages, so an engine can run
 * in another process, on another machine, or be written in another language.
 * It follows the Language Server Protocol: the base layer is LSP's
 * (`connection.ts`), a connection opens with `initialize`/`initialized` and
 * ends with `shutdown`/`exit`, and the server announces what it answers in
 * its manifest the way a language server announces its capabilities.
 *
 * Each engine member is one request whose params are the member's arguments
 * as JSON. The harness is the client; the engine is the server. What an
 * engine calls back into the harness (`appLog`, `resolveSecret`, `log`) are
 * server-to-client messages. An `AbortSignal` crosses as an id the client
 * aborts with a `$/abort` notification; pixels cross as base64.
 */

import { E2EError, ConfigurationError, ERROR_CATEGORIES, InfrastructureError, TestError, asEngineError, isE2EError } from '../../internal/errors.ts';
import { ENGINE_ERROR_CODES, EngineError, type EngineErrorCode, type EngineSpiVersion, type LocatorActionKind, type PointerActionKind } from '../contract.ts';
import type { Engine, EngineSnapshot } from '../index.ts';
import { RPC_ERRORS, isRpcErrorObject, type RpcErrorObject } from './connection.ts';

/** The protocol version this runner speaks; `initialize` refuses any other. */
export const ENGINE_PROTOCOL_VERSION = 1;

/** A method that carries one engine operation: the member it calls and that member's arguments by name, in order. */
export interface OperationMethod {
  readonly kind: 'operation';
  /** The engine member: a top-level one (`observe`) or a hook of a nested one (`keyboard.type`). */
  readonly member: string;
  /** The member's arguments, named as the params carry them; `operation` is its `OperationContext`. */
  readonly args: readonly string[];
  /** A result that is not plain JSON: a snapshot's pixels cross as base64, a screenshot may cross as its bytes. */
  readonly result?: 'snapshot' | 'screenshot';
}

/** A method that carries one lifecycle hook, whose single argument is an info or cleanup object. */
export interface LifecycleMethod {
  readonly kind: 'lifecycle';
  readonly member: 'prepare' | 'finish' | 'init' | 'startAttempt' | 'settleAttempt' | 'endAttempt' | 'dispose';
}

const operation = (member: string, args: readonly string[], result?: OperationMethod['result']): OperationMethod =>
  result === undefined ? { kind: 'operation', member, args } : { kind: 'operation', member, args, result };

const lifecycle = (member: LifecycleMethod['member']): LifecycleMethod => ({ kind: 'lifecycle', member });

/**
 * Every engine method a server may answer, one per engine member: the one
 * table the manifest, the client, and the server are all read off.
 */
export const METHODS = {
  'engine/observe': operation('observe', ['operation', 'options'], 'snapshot'),
  'engine/locate': operation('locate', ['expression', 'operation']),
  'engine/perform': operation('perform', ['ref', 'action', 'operation']),
  'engine/performAt': operation('performAt', ['point', 'action', 'operation']),
  'keyboard/type': operation('keyboard.type', ['text', 'options', 'operation']),
  'keyboard/press': operation('keyboard.press', ['key', 'operation']),
  'keyboard/dismiss': operation('keyboard.dismiss', ['operation']),
  'state/capture': operation('state.capture', ['operation']),
  'state/restore': operation('state.restore', ['state', 'operation']),
  'artifacts/screenshot': operation('artifacts.screenshot', ['label', 'operation'], 'screenshot'),
  'artifacts/startVideo': operation('artifacts.startVideo', ['operation']),
  'artifacts/stopVideo': operation('artifacts.stopVideo', ['operation']),
  'session/open': operation('session.open', ['url', 'operation']),
  'session/back': operation('session.back', ['operation']),
  'session/restart': operation('session.restart', ['operation']),
  'session/reset': operation('session.reset', ['operation']),
  'lifecycle/prepare': lifecycle('prepare'),
  'lifecycle/finish': lifecycle('finish'),
  'lifecycle/init': lifecycle('init'),
  'lifecycle/startAttempt': lifecycle('startAttempt'),
  'lifecycle/settleAttempt': lifecycle('settleAttempt'),
  'lifecycle/endAttempt': lifecycle('endAttempt'),
  'lifecycle/dispose': lifecycle('dispose'),
} as const satisfies Readonly<Record<string, OperationMethod | LifecycleMethod>>;

/** One engine method. */
export type EngineMethod = keyof typeof METHODS;

/** Every engine method a server may answer, in protocol order. */
export const ENGINE_METHODS = Object.freeze(Object.keys(METHODS)) as readonly EngineMethod[];

/** Methods `serveEngine` answers for any engine: it tracks the attempt whether or not the engine has hooks for it. */
export const SERVED_METHODS: ReadonlySet<EngineMethod> = new Set(['lifecycle/startAttempt', 'lifecycle/endAttempt']);

/** An engine member's function, read off a `member` path of `METHODS`; undefined when the engine lacks it. */
export function engineMember(engine: Engine, member: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const [group, hook] = member.split('.') as [keyof Engine, string | undefined];
  const owner: unknown = hook === undefined ? engine : engine[group];
  const fn = typeof owner === 'object' && owner !== null ? (owner as Record<string, unknown>)[hook ?? group] : undefined;
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => Promise<unknown>) : undefined;
}

/**
 * What an engine server is, as JSON: the static members of an engine and
 * the methods it answers. The client declares it at config load, where the
 * harness needs an engine's capabilities synchronously, and the server
 * returns its own from `initialize`; the two must agree.
 */
export interface EngineManifest {
  readonly name: string;
  readonly version: string;
  readonly spiVersion: EngineSpiVersion;
  readonly platform?: string;
  readonly workers?: number;
  /** The engine methods the server answers; a method left out is a capability the engine lacks. */
  readonly methods: readonly EngineMethod[];
  /** Required with `engine/perform`; see `Engine.actions`. */
  readonly actions?: readonly LocatorActionKind[];
  /** Required with `engine/performAt`; see `Engine.pointerActions`. */
  readonly pointerActions?: readonly PointerActionKind[];
  /** See `Engine.tapModifiers`. */
  readonly tapModifiers?: boolean;
}

/** Which of a worker's two lives a connection serves. */
export type ConnectionRole = 'run' | 'worker';

/** Params of `initialize`. */
export interface InitializeParams {
  readonly protocolVersion: number;
  readonly clientInfo: { readonly name: string; readonly version: string };
  /**
   * `run` for the runner's connection, which only ever carries `prepare` and
   * `finish`; `worker` for a worker's, which carries everything from `init`
   * to `dispose`.
   */
  readonly role: ConnectionRole;
  /** Engine options the config passed through, as JSON. */
  readonly initializationOptions?: unknown;
}

/** Result of `initialize`. */
export interface InitializeResult {
  readonly protocolVersion: number;
  readonly manifest: EngineManifest;
}

/**
 * An `AbortSignal` on the wire. The client mints one id per signal and sends
 * `$/abort` with it once the signal aborts; a signal already aborted when it
 * is sent says so itself. `reason` is the abort reason as an error object,
 * when the harness aborted with an error of its own (a test timeout), so an
 * engine that rethrows `signal.reason` raises what it would in process.
 */
export interface WireSignal {
  readonly id: number;
  readonly aborted?: true;
  readonly reason?: RpcErrorObject;
}

/** `OperationContext` on the wire. */
export interface WireOperation {
  readonly signal: WireSignal;
  readonly timeoutMs: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly origin: 'test' | 'agent';
}

/** `EngineCleanupContext` on the wire. */
export interface WireCleanup {
  readonly signal: WireSignal;
  readonly timeoutMs: number;
}

/** `ObservationPixels` on the wire: `data` is base64. */
export interface WirePixels {
  readonly data: string;
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** `EngineSnapshot` on the wire. */
export type WireSnapshot = Omit<EngineSnapshot, 'pixels'> & { readonly pixels?: WirePixels };

/** Params of `attempt/deriveSecret`: the value the client resolved, for the forms the engine derives from it. */
export interface DeriveSecretParams {
  readonly derivation: number;
  readonly plaintext: string;
}

/** Params of `$/abort`. */
export interface AbortParams {
  readonly id: number;
  readonly reason?: RpcErrorObject;
}

/**
 * Encodes an abort reason, or nothing for the platform's own `AbortError`,
 * which the receiving side reproduces by aborting without a reason.
 */
export function encodeAbortReason(reason: unknown): RpcErrorObject | undefined {
  if (reason instanceof DOMException && reason.name === 'AbortError') return undefined;
  return reason === undefined ? undefined : encodeError(reason);
}

/** Encodes a snapshot for the wire. */
export function encodeSnapshot(snapshot: EngineSnapshot): WireSnapshot {
  const { pixels, ...rest } = snapshot;
  if (pixels === undefined) return rest;
  return { ...rest, pixels: { ...pixels, data: Buffer.from(pixels.data).toString('base64') } };
}

/** Decodes a snapshot off the wire. */
export function decodeSnapshot(wire: WireSnapshot): EngineSnapshot {
  const { pixels, ...rest } = wire;
  if (pixels === undefined) return rest;
  return { ...rest, pixels: { ...pixels, data: new Uint8Array(Buffer.from(pixels.data, 'base64')) } };
}

/** Where an error came from, carried beside any error so a report shows the engine's own stack and causes. */
interface WireTrace {
  readonly stack?: string;
  /** A Node error's own code, such as `ECONNREFUSED`, for a plain error. */
  readonly errno?: string;
  readonly cause?: RpcErrorObject;
}

/** The e2e error a failed engine method carries in its JSON-RPC error's `data`. */
type WireErrorData =
  | { readonly type: 'engine'; readonly code: EngineErrorCode; readonly retryable: boolean }
  | {
      readonly type: 'e2e';
      readonly category: E2EError['category'];
      readonly code: string;
      readonly retryable: boolean;
      readonly details?: E2EError['details'];
    };

/** How deep a cause chain crosses, as deep as a report describes one. */
const MAX_WIRE_CAUSES = 3;

/** Bytes of a stack that cross, as many as a report keeps. */
const MAX_WIRE_STACK = 65_536;

/**
 * Encodes what an engine member threw. An `EngineError` and a harness error
 * keep their code and category, so the harness classifies a remote failure
 * exactly as a local one; anything else crosses as its message, which the
 * harness treats as an infrastructure failure, as it does locally. Every
 * error keeps its stack and its first causes.
 */
export function encodeError(cause: unknown, depth = 0): RpcErrorObject {
  const message = cause instanceof Error ? cause.message : String(cause);
  const trace = encodeTrace(cause, depth);
  const engine = asEngineError(cause);
  if (engine !== undefined) {
    return { code: RPC_ERRORS.engineError, message, data: { type: 'engine', code: engine.code, retryable: engine.retryable, ...trace } };
  }
  if (isE2EError(cause)) {
    const { details } = cause;
    return {
      code: RPC_ERRORS.engineError,
      message,
      data: {
        type: 'e2e',
        category: cause.category,
        code: cause.code,
        retryable: cause.retryable,
        ...(details === undefined ? {} : { details }),
        ...trace,
      },
    };
  }
  const errno = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  const plain = { ...trace, ...(typeof errno === 'string' ? { errno } : {}) };
  return { code: RPC_ERRORS.internalError, message, ...(Object.keys(plain).length === 0 ? {} : { data: plain }) };
}

function encodeTrace(cause: unknown, depth: number): WireTrace {
  if (!(cause instanceof Error)) return {};
  return {
    ...(cause.stack === undefined ? {} : { stack: cause.stack.slice(0, MAX_WIRE_STACK) }),
    ...(cause.cause === undefined || depth >= MAX_WIRE_CAUSES ? {} : { cause: encodeError(cause.cause, depth + 1) }),
  };
}

/** The e2e error in a response's `data`, or undefined for anything off the wire format, which then decodes as a plain error. */
function wireErrorData(data: unknown): WireErrorData | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, code, category, retryable } = data as Record<string, unknown>;
  if (typeof retryable !== 'boolean') return undefined;
  if (type === 'engine') return (ENGINE_ERROR_CODES as readonly unknown[]).includes(code) ? (data as WireErrorData) : undefined;
  if (type === 'e2e') return typeof code === 'string' && ERROR_CATEGORIES.has(category) ? (data as WireErrorData) : undefined;
  return undefined;
}

/** Decodes an error response into the error the engine member threw, with the stack and causes it crossed with. */
export function decodeError(error: RpcErrorObject, depth = 0): Error {
  const decoded = decodeClassified(error);
  if (typeof error.data !== 'object' || error.data === null) return decoded;
  const { stack, errno, cause } = error.data as Record<string, unknown>;
  if (typeof stack === 'string') decoded.stack = stack;
  if (typeof errno === 'string' && decoded.constructor === Error) Object.assign(decoded, { code: errno });
  if (isRpcErrorObject(cause) && depth < MAX_WIRE_CAUSES) {
    Object.defineProperty(decoded, 'cause', { value: decodeError(cause, depth + 1), writable: true, configurable: true, enumerable: false });
  }
  return decoded;
}

function decodeClassified(error: RpcErrorObject): Error {
  const data = wireErrorData(error.data);
  if (error.code === RPC_ERRORS.engineError && data?.type === 'engine') {
    return new EngineError(data.code, error.message, { retryable: data.retryable });
  }
  if (error.code === RPC_ERRORS.engineError && data?.type === 'e2e') {
    const options = data.details === undefined ? {} : { details: data.details };
    switch (data.category) {
      case 'test':
        return new TestError(data.code, error.message, { ...options, retryable: data.retryable });
      case 'configuration':
        return new ConfigurationError(data.code, error.message, options);
      case 'infrastructure':
        return data.retryable
          ? new E2EError('infrastructure', data.code, error.message, { ...options, retryable: true })
          : new InfrastructureError(data.code, error.message, options);
      default:
        return new E2EError(data.category, data.code, error.message, { ...options, retryable: data.retryable });
    }
  }
  return new Error(error.message);
}
