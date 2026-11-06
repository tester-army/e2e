/** A thin WebDriver BiDi client: typed commands and events over one message transport. */

import type { Commands, Event as BidiEvent, Message } from 'webdriver-bidi-protocol';
import { EngineError } from 'e2e/engine';

/** A text transport carrying BiDi messages: a WebSocket, or the Chromium mapper's process. */
export interface BidiTransport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  /** Runs `handler` once the transport is gone, with why when the transport knows. */
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

/** A BiDi command's method name, and its parameters and result. */
export type BidiMethod = keyof Commands;
export type BidiParams<M extends BidiMethod> = Commands[M]['params'];
export type BidiResult<M extends BidiMethod> = Commands[M]['returnType'];
/** A BiDi event's name, and its parameters. */
export type BidiEventName = BidiEvent['method'];
export type BidiEventParams<E extends BidiEventName> = Extract<BidiEvent, { method: E }>['params'];

interface Pending {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (cause: Error) => void;
}

/** A BiDi error response, with the protocol's error code kept for classification. */
export class BidiError extends Error {
  constructor(
    readonly method: string,
    readonly error: string,
    /** The browser's own words, apart from the method and code. */
    readonly detail: string,
  ) {
    super(`${method}: ${error}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'BidiError';
  }
}

/**
 * One WebDriver BiDi session over a transport: commands matched to their
 * responses by id, events fanned out to listeners, and every pending command
 * rejected once the transport closes.
 */
export class BidiConnection {
  private nextId = 0;
  private closed = false;
  private closeReason: string | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(private readonly transport: BidiTransport) {
    transport.onMessage((raw) => this.receive(raw));
    transport.onClose((reason) => this.drop(reason));
  }

  /** Whether the transport is gone; every later command rejects. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends one command and resolves with its result; rejects with `BidiError` on an error response. */
  send<M extends BidiMethod>(method: M, params: BidiParams<M>): Promise<BidiResult<M>> {
    if (this.closed) return Promise.reject(disconnected(method, this.closeReason));
    this.nextId += 1;
    const id = this.nextId;
    return new Promise<BidiResult<M>>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject });
      try {
        this.transport.send(JSON.stringify({ id, method, params }));
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  /**
   * Sends a browser-specific extension command the spec types do not name,
   * such as Chromium's `goog:cdp.sendCommand`.
   */
  sendExtension(method: `${string}:${string}`, params: object): Promise<unknown> {
    return this.send(method as BidiMethod, params as never);
  }

  /** Subscribes to browser-specific extension events in `contexts`, which the spec's event names do not list; resolves with the subscription. */
  async subscribeExtension(events: readonly `${string}:${string}`[], contexts: [string, ...string[]]): Promise<string> {
    const { subscription } = await this.send('session.subscribe', { events: events as never, contexts });
    return subscription;
  }

  /** Listens for a browser-specific extension event, such as `goog:cdp.Page.screencastFrame`; returns the unsubscribe. */
  onExtension(event: `${string}:${string}`, handler: (params: Record<string, unknown>) => void): () => void {
    return this.on(event as BidiEventName, handler as never);
  }

  /** Listens for one event; returns the unsubscribe. The session must subscribe to it too (`session.subscribe`). */
  on<E extends BidiEventName>(event: E, handler: (params: BidiEventParams<E>) => void): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const listener = handler as (params: unknown) => void;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Runs `handler` once when the transport closes. */
  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  /** Closes the transport; commands in flight fail as disconnected. */
  close(): void {
    this.transport.close();
    this.drop();
  }

  /** Settles the command a response answers, or hands an event to its listeners. */
  private receive(raw: string): void {
    // oxlint-disable-next-line e2e/no-unchecked-json -- protocol messages from the browser the engine launched
    const message = JSON.parse(raw) as Message;
    if (message.type === 'event') {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
    const id = message.id;
    if (id === null || id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (message.type === 'success') pending.resolve(message.result);
    else pending.reject(new BidiError(pending.method, message.error, message.message));
  }

  /** Marks the connection gone and fails every command in flight, once. */
  private drop(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const pending of this.pending.values()) pending.reject(disconnected(pending.method, reason));
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
  }
}

/** The error every command in flight, and every later one, fails with once the browser is gone. */
function disconnected(method: string, reason?: string): EngineError {
  return new EngineError('ENGINE_FAILURE', `${method}: the BiDi connection closed${reason === undefined ? '' : `: ${reason}`}`, { retryable: false });
}

/** A transport over a WebSocket URL, opened with Node's built-in client. */
export function webSocketTransport(url: string, timeoutMs: number): Promise<BidiTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket ${url} did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    const closeHandlers: (() => void)[] = [];
    socket.addEventListener('close', () => {
      for (const handler of closeHandlers) handler();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket ${url} failed to open`));
    });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send: (message) => socket.send(message),
        onMessage: (handler) => socket.addEventListener('message', (event) => handler(String(event.data))),
        onClose: (handler) => closeHandlers.push(handler),
        close: () => socket.close(),
      });
    });
  });
}
