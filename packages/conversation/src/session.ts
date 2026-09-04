/**
 * The one seam to the AI SDK: a conversation held as a `UIMessage[]` and
 * advanced through a `ChatTransport`. `send` appends a user message and
 * drives the transport's stream to completion; `respond` answers a pending
 * tool approval and resumes the same assistant turn. Everything above this
 * (observation, actions, the fixture) reads the transcript this owns.
 *
 * The AI SDK is an optional peer, loaded lazily so importing the backend
 * never forces the SDK on a project that only names it in config.
 */

import { failure, invalidState } from './support.ts';
import { pendingApprovals, type UIMessageLike, type UIPart } from './messages.ts';

/** A minimal view of the AI SDK's `ChatTransport`, structurally matched. */
export interface ChatTransportLike {
  sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;
    messages: readonly UIMessageLike[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<unknown>>;
}

/** The AI SDK helpers this module needs, resolved once from the peer dependency. */
interface SdkModule {
  readUIMessageStream(options: {
    message?: UIMessageLike;
    stream: ReadableStream<unknown>;
    onError?: (error: unknown) => void;
  }): AsyncIterable<UIMessageLike>;
}

let sdk: SdkModule | undefined;

/** Loads the AI SDK once; a clear error when a conversation target ran without it installed. */
async function loadSdk(): Promise<SdkModule> {
  if (sdk !== undefined) return sdk;
  try {
    const mod = (await import('ai')) as unknown as SdkModule;
    sdk = mod;
    return mod;
  } catch (cause) {
    throw failure('the conversation backend needs the "ai" package (^7); install it as a dependency', cause);
  }
}

let idCounter = 0;
function messageId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export interface SessionOptions {
  readonly transport: ChatTransportLike;
  readonly chatId: string;
  /** Messages the conversation starts with (a system prime, a seeded history). */
  readonly initialMessages: readonly UIMessageLike[];
}

/** The state a caller can observe between turns. */
export type SessionStatus = 'ready' | 'awaiting-approval' | 'error';

export class ConversationSession {
  private messages: UIMessageLike[];
  private lastError: Error | undefined;

  constructor(private readonly options: SessionOptions) {
    this.messages = options.initialMessages.map(clone);
  }

  /** The transcript as it stands, newest message last. */
  get transcript(): readonly UIMessageLike[] {
    return this.messages;
  }

  get status(): SessionStatus {
    if (this.lastError !== undefined) return 'error';
    return pendingApprovals(this.messages).length > 0 ? 'awaiting-approval' : 'ready';
  }

  get error(): Error | undefined {
    return this.lastError;
  }

  /** Resets to the seeded history, for a fresh attempt on the same session. */
  reset(): void {
    this.messages = this.options.initialMessages.map(clone);
    this.lastError = undefined;
  }

  /** Appends a user message and drives the assistant's turn to completion. */
  async send(text: string, signal: AbortSignal): Promise<void> {
    if (this.status === 'awaiting-approval') {
      throw invalidState('the assistant is waiting on a tool approval; approve or deny it before sending');
    }
    this.messages.push({ id: messageId('user'), role: 'user', parts: [{ type: 'text', text }] });
    await this.drive('submit-message', undefined, signal);
  }

  /**
   * Answers one pending tool approval and resumes the same assistant turn.
   * The approval response is written onto the paused tool part, then the
   * transcript is re-submitted so the agent continues from where it stopped.
   */
  async respond(approvalId: string, approved: boolean, reason: string | undefined, signal: AbortSignal): Promise<void> {
    const last = this.messages.at(-1);
    if (last === undefined || last.role !== 'assistant') throw invalidState('no assistant turn is awaiting approval');
    const part = last.parts.find(
      (candidate): candidate is UIPart => candidate.state === 'approval-requested' && candidate.approval?.id === approvalId,
    );
    if (part === undefined) throw invalidState(`no pending approval with id ${approvalId}`);
    const mutable = part as { state: string; approval: { id: string; approved?: boolean; reason?: string } };
    mutable.state = 'approval-responded';
    mutable.approval = { id: approvalId, approved, ...(reason === undefined ? {} : { reason }) };
    await this.drive('submit-message', last, signal);
  }

  /** Sends the transport one request and folds its streamed assistant message into the transcript. */
  private async drive(
    trigger: 'submit-message' | 'regenerate-message',
    resume: UIMessageLike | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const { readUIMessageStream } = await loadSdk();
    this.lastError = undefined;
    let stream: ReadableStream<unknown>;
    try {
      stream = await this.options.transport.sendMessages({
        trigger,
        chatId: this.options.chatId,
        messageId: undefined,
        messages: this.messages,
        abortSignal: signal,
      });
    } catch (cause) {
      this.lastError = cause instanceof Error ? cause : new Error(String(cause));
      throw failure('the conversation transport failed to start a turn', cause);
    }
    let latest: UIMessageLike | undefined = resume;
    let streamError: unknown;
    for await (const message of readUIMessageStream({
      ...(resume === undefined ? {} : { message: resume }),
      stream,
      onError: (error) => {
        streamError = error;
      },
    })) {
      latest = message;
    }
    if (latest !== undefined) {
      if (resume !== undefined) this.messages[this.messages.length - 1] = latest;
      else this.messages.push(latest);
    }
    if (streamError !== undefined) {
      this.lastError = streamError instanceof Error ? streamError : new Error(String(streamError));
      throw failure(`the assistant turn errored: ${this.lastError.message}`, streamError);
    }
  }
}

/** A deep-enough clone so mutating one turn's approval never touches the seeded history. */
function clone(message: UIMessageLike): UIMessageLike {
  return { id: message.id, role: message.role, parts: message.parts.map((part) => ({ ...part })) };
}
