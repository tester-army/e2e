/**
 * The engine protocol's base layer, the Language Server Protocol's base
 * protocol unchanged: JSON-RPC 2.0 messages, each framed by a
 * `Content-Length` header, over any byte stream. Either side may send
 * requests and notifications; the harness is the client, the engine the
 * server. Nothing here knows an engine method: `client.ts` and `server.ts`
 * give the messages their meaning.
 */

import type { Readable, Writable } from 'node:stream';

/** A JSON-RPC request id. */
type RequestId = number | string;

/** The JSON-RPC error codes the protocol uses, LSP's numbering. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** A server error carrying an e2e error in `data`. */
  engineError: -32000,
  /** The connection closed before the request was answered. */
  connectionClosed: -32099,
} as const;

/** The error object of a failed JSON-RPC response. */
export interface RpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Whether `value` has the shape of a JSON-RPC error object. */
export function isRpcErrorObject(value: unknown): value is RpcErrorObject {
  if (typeof value !== 'object' || value === null) return false;
  const { code, message } = value as Record<string, unknown>;
  return typeof code === 'number' && typeof message === 'string';
}

/** A failed response, thrown from `Connection.request`. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorObject) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** Answers one incoming request; what it throws becomes the error response. */
type RequestHandler = (params: unknown) => Promise<unknown>;
/** Handles one incoming notification. */
type NotificationHandler = (params: unknown) => void;

/** Turns what a request handler threw into a JSON-RPC error object. */
export type ErrorEncoder = (cause: unknown) => RpcErrorObject;

/** A byte stream pair one connection speaks over. */
export interface MessageStreams {
  readonly input: Readable;
  readonly output: Writable;
}

/** How a connection handles what arrives on it. */
export interface ConnectionOptions {
  readonly requests?: Readonly<Record<string, RequestHandler>>;
  readonly notifications?: Readonly<Record<string, NotificationHandler>>;
  /** Encodes a handler failure; defaults to an internal error carrying the message. */
  readonly encodeError?: ErrorEncoder;
  /** Called with what a notification handler threw: a notification has no reply to carry it. */
  readonly onNotificationError?: (method: string, cause: unknown) => void;
  /** Called once when the input ends or fails, after every pending request was rejected. */
  readonly onClose?: (reason: string) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

const HEADER_DELIMITER = Buffer.from('\r\n\r\n');

/** Largest message a peer may send: a tree with pixels fits many times over. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/**
 * One JSON-RPC connection over a framed byte stream. Requests are answered
 * concurrently; messages are written in the order they are sent, so a
 * notification sent before a response is handled before it.
 */
export class Connection {
  readonly #output: Writable;
  readonly #requests: Map<string, RequestHandler>;
  readonly #notifications: Map<string, NotificationHandler>;
  readonly #encodeError: ErrorEncoder;
  readonly #onNotificationError: ((method: string, cause: unknown) => void) | undefined;
  readonly #onClose: ((reason: string) => void) | undefined;
  readonly #pending = new Map<RequestId, Pending>();
  #nextId = 1;
  #chunks: Buffer[] = [];
  #size = 0;
  #bodyLength: number | undefined;
  #closed: string | undefined;

  constructor(streams: MessageStreams, options: ConnectionOptions = {}) {
    this.#output = streams.output;
    this.#requests = new Map(Object.entries(options.requests ?? {}));
    this.#notifications = new Map(Object.entries(options.notifications ?? {}));
    this.#encodeError = options.encodeError ?? defaultEncodeError;
    this.#onNotificationError = options.onNotificationError;
    this.#onClose = options.onClose;
    streams.input.on('data', (chunk: Buffer | string) => this.#receive(chunk));
    streams.input.once('end', () => this.close('the peer closed the connection'));
    streams.input.once('error', (cause: Error) => this.close(`the connection failed: ${cause.message}`));
    streams.output.on('error', (cause: Error) => this.close(`the connection failed: ${cause.message}`));
  }

  /** Why the connection closed, or undefined while it is open. */
  get closed(): string | undefined {
    return this.#closed;
  }

  /** Registers a request handler after construction, for a method only known later. */
  onRequest(method: string, handler: RequestHandler): void {
    this.#requests.set(method, handler);
  }

  /** Sends a request and resolves with its result; rejects with `RpcError`. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed !== undefined) {
      return Promise.reject(new RpcError({ code: RPC_ERRORS.connectionClosed, message: this.#closed }));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** Sends a notification; dropped once the connection is closed. */
  notify(method: string, params?: unknown): void {
    if (this.#closed !== undefined) return;
    this.#send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Closes the connection: every pending request rejects with `reason`. */
  close(reason: string): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    const failure = new RpcError({ code: RPC_ERRORS.connectionClosed, message: reason });
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
    this.#onClose?.(reason);
  }

  #send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.#output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  #receive(chunk: Buffer | string): void {
    if (this.#closed !== undefined) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#chunks.push(bytes);
    this.#size += bytes.length;
    // Chunks are joined only to read a header or once a whole body is in,
    // so a large message is copied once, not once per chunk.
    while (this.#closed === undefined) {
      if (this.#bodyLength === undefined) {
        const buffer = this.#join();
        const headerEnd = buffer.indexOf(HEADER_DELIMITER);
        if (headerEnd === -1) return;
        const length = contentLength(buffer.subarray(0, headerEnd).toString('ascii'));
        if (length === undefined) {
          this.close('the peer sent a message without a valid Content-Length header');
          return;
        }
        if (length > MAX_MESSAGE_BYTES) {
          this.close(`the peer sent a ${String(length)}-byte message, over the ${String(MAX_MESSAGE_BYTES)}-byte limit`);
          return;
        }
        this.#bodyLength = length;
        this.#chunks = [buffer.subarray(headerEnd + HEADER_DELIMITER.length)];
        this.#size = this.#chunks[0]!.length;
      }
      if (this.#size < this.#bodyLength) return;
      const buffer = this.#join();
      const body = buffer.subarray(0, this.#bodyLength).toString('utf8');
      this.#chunks = [buffer.subarray(this.#bodyLength)];
      this.#size = this.#chunks[0]!.length;
      this.#bodyLength = undefined;
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        this.#send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parseError, message: 'message is not JSON' } });
        continue;
      }
      this.#dispatch(message);
    }
  }

  /** The buffered bytes as one buffer, kept as the only chunk. */
  #join(): Buffer {
    const buffer = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#size);
    this.#chunks = [buffer];
    return buffer;
  }

  #dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { id, method, params, result, error } = message as {
      id?: RequestId | null;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    const hasId = id !== undefined && id !== null;
    if (method !== undefined && typeof method !== 'string') {
      if (hasId) this.#respond(id, { error: { code: RPC_ERRORS.invalidRequest, message: 'method must be a string' } });
      return;
    }
    if (typeof method === 'string') {
      if (!hasId) {
        // A malformed notification must not take the process down with it.
        try {
          this.#notifications.get(method)?.(params);
        } catch (cause) {
          this.#onNotificationError?.(method, cause);
        }
        return;
      }
      void this.#answer(id, method, params);
      return;
    }
    // A response carries exactly one of `result` and `error`; anything else
    // answers nothing and must not settle a request.
    if (!hasId || ('result' in (message as object)) === (error !== undefined)) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (error === undefined) pending.resolve(result);
    else if (isRpcErrorObject(error)) pending.reject(new RpcError(error));
    else pending.reject(new RpcError({ code: RPC_ERRORS.internalError, message: `the peer answered with a malformed error (${error === null ? 'null' : typeof error}), not { code, message }` }));
  }

  async #answer(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.#requests.get(method);
    if (handler === undefined) {
      this.#respond(id, { error: { code: RPC_ERRORS.methodNotFound, message: `unknown method "${method}"` } });
      return;
    }
    try {
      const result = await handler(params);
      this.#respond(id, { result: result ?? null });
    } catch (cause) {
      this.#respond(id, { error: this.#encodeError(cause) });
    }
  }

  #respond(id: RequestId, outcome: { result: unknown } | { error: RpcErrorObject }): void {
    if (this.#closed !== undefined) return;
    this.#send({ jsonrpc: '2.0', id, ...outcome });
  }
}

/** Reads `Content-Length` off a header block; other headers are ignored, as LSP allows. */
function contentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') continue;
    const value = Number(line.slice(separator + 1).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}

function defaultEncodeError(cause: unknown): RpcErrorObject {
  return { code: RPC_ERRORS.internalError, message: cause instanceof Error ? cause.message : String(cause) };
}
