/**
 * The `conversation` fixture: deterministic control of and structured access
 * to the transcript this backend contributes. Not an agent tool; a test
 * calls these directly to send messages, answer approvals, and assert on
 * tool calls, recorded as `conversation.<method>` steps.
 */

import type { BackendFixtureContext } from '@e2edev/e2e/backend';
import type { ToolCall, UIMessageLike } from './messages.ts';
import type { ConversationSurface } from './surface.ts';

/** Deterministic conversation control exposed to tests as `conversation`. */
export interface Conversation {
  /** Sends a user message and waits for the assistant's turn to finish (or pause on an approval). */
  send(text: string): Promise<void>;
  /** Approves the single pending tool approval, or the one for `tool` when given, and resumes the turn. */
  approve(tool?: string, options?: { reason?: string }): Promise<void>;
  /** Denies the single pending tool approval, or the one for `tool` when given, and resumes the turn. */
  deny(tool?: string, options?: { reason?: string }): Promise<void>;
  /** Every tool call in the transcript, in order. */
  toolCalls(name?: string): ToolCall[];
  /** The whole transcript, newest message last. */
  messages(): readonly UIMessageLike[];
  /** The newest assistant message's text. */
  lastText(): string;
  /** `ready`, `awaiting-approval`, or `error`. */
  status(): string;
  /** Whether a tool approval is currently pending. */
  awaitingApproval(): boolean;
}

/** Builds the conversation fixture for one attempt. */
export function createConversationFixture(surface: ConversationSurface, context: BackendFixtureContext): Conversation {
  return {
    send: (text) => surface.send(text, context.operation()),
    approve: (tool, options) => {
      const target = tool === undefined ? surface.soleApproval() : surface.approvalFor(tool);
      return surface.respond(target.approvalId, true, context.operation(), options?.reason);
    },
    deny: (tool, options) => {
      const target = tool === undefined ? surface.soleApproval() : surface.approvalFor(tool);
      return surface.respond(target.approvalId, false, context.operation(), options?.reason);
    },
    toolCalls: (name) => surface.toolCalls(name),
    messages: () => surface.transcript(),
    lastText: () => surface.lastText(),
    status: () => surface.status(),
    awaitingApproval: () => surface.status() === 'awaiting-approval',
  };
}
