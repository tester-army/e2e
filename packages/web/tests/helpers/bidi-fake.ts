/**
 * A scripted WebDriver BiDi peer for unit tests: answers each command with
 * the handler registered for its method, records every command sent, and
 * emits events on demand.
 */

import { BidiConnection, type BidiTransport } from '../../src/bidi/connection.ts';

/** One command the driver sent. */
export interface SentCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** What a handler returns: a result, or an error response. */
export type Reply = { readonly result: unknown } | { readonly error: string; readonly message?: string };

export class FakeBidi {
  readonly sent: SentCommand[] = [];
  readonly connection: BidiConnection;
  private deliver: (message: string) => void = () => undefined;
  private closed: () => void = () => undefined;
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => Reply | Promise<Reply>>();

  constructor() {
    const transport: BidiTransport = {
      send: (raw) => {
        const command = JSON.parse(raw) as SentCommand;
        this.sent.push(command);
        void this.answer(command);
      },
      onMessage: (handler) => {
        this.deliver = handler;
      },
      onClose: (handler) => {
        this.closed = handler;
      },
      close: () => this.closed(),
    };
    this.connection = new BidiConnection(transport);
  }

  /** Answers every later `method` command with `reply`; a method with no handler answers an empty result. */
  on(method: string, reply: Reply | ((params: Record<string, unknown>) => Reply | Promise<Reply>)): this {
    this.handlers.set(method, typeof reply === 'function' ? reply : () => reply);
    return this;
  }

  /** Emits one event to the driver. */
  emit(method: string, params: Record<string, unknown>): void {
    this.deliver(JSON.stringify({ type: 'event', method, params }));
  }

  /** Drops the transport, as a browser that went away. */
  drop(): void {
    this.closed();
  }

  /** The commands of `method` sent so far, in order. */
  commands(method: string): SentCommand[] {
    return this.sent.filter((command) => command.method === method);
  }

  /** Replies to one command with its method's handler, or an empty result. */
  private async answer(command: SentCommand): Promise<void> {
    const handler = this.handlers.get(command.method);
    const reply = handler === undefined ? { result: {} } : await handler(command.params);
    const message = 'result' in reply
      ? { type: 'success', id: command.id, result: reply.result }
      : { type: 'error', id: command.id, error: reply.error, message: reply.message ?? '' };
    this.deliver(JSON.stringify(message));
  }
}

/** Resolves after pending microtasks and one macrotask, so queued sends and replies settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
