/**
 * Agent-side tools for conversation targets. The grammar verbs already let
 * the e2e agent send a message (fill the composer, press Enter) and answer an
 * approval (tap Approve or Deny), so a target works with no tools at all.
 * This pack is higher-level sugar: send a message in one call, and answer an
 * approval by name. Each tool is scoped to the `conversation` platform so a
 * mixed suite never offers it on a browser.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type DefinedTool, type ToolAnnotations } from '@e2edev/e2e/agent';
import { BackendError, type BackendHandle } from '@e2edev/e2e/backend';
import { surfaceOf } from './backend.ts';
import type { ConversationSurface } from './surface.ts';

function requireSurface(backend: BackendHandle): ConversationSurface {
  const surface = surfaceOf(backend);
  if (surface === undefined) {
    throw new BackendError('INVALID_STATE', 'conversationTools needs handles returned by conversation()', {
      retryable: false,
    });
  }
  return surface;
}

/**
 * Builds the tool pack for one or more conversation backends, keyed the way
 * `createAgent({ tools })` expects. Pass every conversation backend a config
 * declares: tool names are fixed, so two packs cannot be merged. A worker
 * runs one attempt at a time, so at execution the pack dispatches to the
 * surface whose attempt is running.
 */
export function conversationTools(
  ...backends: readonly [BackendHandle, ...BackendHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const surfaces = backends.map(requireSurface);
  const active = (): ConversationSurface => {
    const running = surfaces.filter((surface) => surface.attemptRunning);
    const [surface] = running;
    if (surface === undefined || running.length > 1) {
      throw new BackendError(
        'INVALID_STATE',
        running.length === 0
          ? 'no conversation attempt is running; conversation tools act inside a test attempt only'
          : 'several conversation attempts are running in one worker; tools cannot pick a conversation',
        { retryable: false },
      );
    }
    return surface;
  };
  const annotate = (mutates: boolean): ToolAnnotations => ({
    replay: 'none',
    mutates,
    secrets: false,
    platforms: ['conversation'],
  });
  const operation = (options: { abortSignal?: AbortSignal }) => ({
    signal: options.abortSignal ?? new AbortController().signal,
    timeoutMs: 300_000,
    runId: '',
    attemptId: '',
  });

  return {
    send_message: defineTool(
      tool({
        description:
          'Send a message to the assistant under test as the user, and wait for its reply to finish (or pause on a tool approval). Use this to say what a real user would say.',
        inputSchema: z.object({ text: z.string().min(1) }),
        execute: async ({ text }, options) => {
          const surface = active();
          await surface.send(text, operation(options));
          const status = surface.status();
          return status === 'awaiting-approval'
            ? `Sent. The assistant is now waiting for approval of a tool call.`
            : `Sent. The assistant replied: ${JSON.stringify(surface.lastText().slice(0, 500))}`;
        },
      }),
      annotate(true),
    ),
    respond_to_approval: defineTool(
      tool({
        description:
          'Approve or deny the tool call the assistant is waiting on, then let it resume. Only valid when a tool approval is pending.',
        inputSchema: z.object({
          approved: z.boolean(),
          tool: z.string().optional(),
          reason: z.string().optional(),
        }),
        execute: async ({ approved, tool: toolName, reason }, options) => {
          const surface = active();
          const target = toolName === undefined ? surface.soleApproval() : surface.approvalFor(toolName);
          await surface.respond(target.approvalId, approved, operation(options), reason);
          return `${approved ? 'Approved' : 'Denied'} the tool call. The assistant replied: ${JSON.stringify(surface.lastText().slice(0, 500))}`;
        },
      }),
      annotate(true),
    ),
  };
}
