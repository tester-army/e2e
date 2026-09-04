/**
 * A scripted `ChatTransport` and a matching stand-in for the AI SDK's
 * `readUIMessageStream`, so every observe/perform/approval path is exercised
 * without a model, a network, or the real SDK.
 *
 * The backend consumes the SDK only through `import('ai')`. The unit files
 * mock that module with `sdkMock()` below, and pass `transport: fake` so the
 * surface never constructs a real transport. What is asserted is how the
 * backend drives the transport and folds replies into the transcript.
 */

import type { UIMessageLike, UIPart } from '../../src/messages.ts';
import type { ChatTransportLike } from '../../src/session.ts';

/** One scripted assistant reply, computed from the history the transport was sent. */
export type Reply = (sent: readonly UIMessageLike[]) => UIPart[];

/** The single chunk the fake transport streams; the fake reader decodes it. */
interface Chunk {
  readonly parts: UIPart[];
}

export interface FakeTransport extends ChatTransportLike {
  /** Every sendMessages call's message history, in order. */
  readonly sends: UIMessageLike[][];
  /** Queues the next assistant reply (its parts, or a function of the history). */
  reply(parts: UIPart[] | Reply): void;
}

export function createFakeTransport(): FakeTransport {
  const sends: UIMessageLike[][] = [];
  const queue: Reply[] = [];
  return {
    sends,
    reply(parts) {
      queue.push(typeof parts === 'function' ? parts : () => parts.map((part) => ({ ...part })));
    },
    async sendMessages(options) {
      sends.push(options.messages.map((message) => message));
      const next = queue.shift() ?? (() => []);
      const chunk: Chunk = { parts: next(options.messages) };
      return new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };
}

/**
 * The AI SDK module mock: the backend calls `readUIMessageStream` to turn a
 * transport stream into the finished assistant message. This reader takes the
 * one chunk the fake transport enqueued and either starts a new assistant
 * message or, on resume, folds the parts onto the message being continued
 * (dropping the approval-requested part it answers), mirroring the SDK.
 */
export function sdkMock(): Record<string, unknown> {
  let counter = 0;
  return {
    async *readUIMessageStream(options: { message?: UIMessageLike; stream: ReadableStream<unknown> }) {
      const reader = options.stream.getReader();
      let parts: UIPart[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts = (value as Chunk).parts;
      }
      if (options.message !== undefined) {
        const kept = options.message.parts.filter((part) => part.state !== 'approval-requested');
        yield { id: options.message.id, role: 'assistant', parts: [...kept, ...parts] } satisfies UIMessageLike;
        return;
      }
      counter += 1;
      yield { id: `assistant-${counter}`, role: 'assistant', parts } satisfies UIMessageLike;
    },
  };
}

/** A text part. */
export function text(value: string): UIPart {
  return { type: 'text', text: value };
}

/** A completed tool call part. */
export function toolOutput(name: string, input: unknown, output: unknown, id = `call-${name}`): UIPart {
  return { type: `tool-${name}`, toolCallId: id, state: 'output-available', input, output };
}

/** A tool call paused for approval. */
export function toolApproval(name: string, input: unknown, approvalId = `ap-${name}`, id = `call-${name}`): UIPart {
  return { type: `tool-${name}`, toolCallId: id, state: 'approval-requested', input, approval: { id: approvalId } };
}
