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
import type { EngineSnapshot } from '../index.ts';
import { RPC_ERRORS, type RpcErrorObject } from './connection.ts';

/** The protocol version this runner speaks; `initialize` refuses any other. */
export const ENGINE_PROTOCOL_VERSION = 1;

/** Every engine method a server may answer, one per engine member. */
export const ENGINE_METHODS = [
  'engine/observe',
  'engine/locate',
  'engine/perform',
  'engine/performAt',
  'keyboard/type',
  'keyboard/press',
  'keyboard/dismiss',
  'state/capture',
  'state/restore',
  'artifacts/screenshot',
  'artifacts/startVideo',
  'artifacts/stopVideo',
  'session/open',
  'session/back',
  'session/restart',
  'session/reset',
  'lifecycle/prepare',
  'lifecycle/finish',
  'lifecycle/init',
  'lifecycle/startAttempt',
  'lifecycle/settleAttempt',
  'lifecycle/endAttempt',
  'lifecycle/dispose',
] as const;

/** One engine method. */
export type EngineMethod = (typeof ENGINE_METHODS)[number];

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

/** Params of `$/release`: signal ids the client will never send again. */
export interface ReleaseParams {
  readonly ids: readonly number[];
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

/**
 * Encodes what an engine member threw. An `EngineError` and a harness error
 * keep their code and category, so the harness classifies a remote failure
 * exactly as a local one; anything else crosses as its message alone, which
 * the harness treats as an infrastructure failure, as it does locally.
 */
export function encodeError(cause: unknown): RpcErrorObject {
  const message = cause instanceof Error ? cause.message : String(cause);
  const engine = asEngineError(cause);
  if (engine !== undefined) {
    return { code: RPC_ERRORS.engineError, message, data: { type: 'engine', code: engine.code, retryable: engine.retryable } };
  }
  if (isE2EError(cause)) {
    const details = (cause as { details?: E2EError['details'] }).details;
    return {
      code: RPC_ERRORS.engineError,
      message,
      data: {
        type: 'e2e',
        category: cause.category,
        code: cause.code,
        retryable: cause.retryable,
        ...(details === undefined ? {} : { details }),
      },
    };
  }
  return { code: RPC_ERRORS.internalError, message };
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

/** Decodes an error response into the error the engine member threw. */
export function decodeError(error: { readonly code: number; readonly message: string; readonly data?: unknown }): Error {
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
