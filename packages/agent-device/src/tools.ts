/**
 * Agent-side tools for device targets. Everything a model plans through
 * beyond the grammar verbs the backend already unlocks (tap, type, scroll)
 * lives here: opening another app, a free-form swipe, typing into the focused
 * field, system alerts, and a look at the pixels when the accessibility tree
 * is not enough. Each tool is scoped to the platforms of the backends it was
 * built from, so a mixed suite never offers it on a browser.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type DefinedTool, type ToolAnnotations } from '@e2edev/e2e/agent';
import { BackendError, type BackendHandle } from '@e2edev/e2e/backend';
import { surfaceOf } from './backend.ts';
import type { AgentDeviceSurface } from './surface.ts';

interface Screenshot {
  readonly png: string;
}

function requireSurface(backend: BackendHandle): AgentDeviceSurface {
  const surface = surfaceOf(backend);
  if (surface === undefined) {
    throw new BackendError('INVALID_STATE', 'agentDeviceTools needs handles returned by agentDevice()', {
      retryable: false,
    });
  }
  return surface;
}

/**
 * Builds the tool pack for one or more agent-device backends, keyed the way
 * `createAgent({ tools })` expects. Pass every device backend a config
 * declares: tool names are fixed, so two packs cannot be merged, and each
 * tool is offered only on the platforms those backends drive. A worker runs
 * one attempt at a time, so at execution the pack dispatches to the surface
 * whose attempt is running.
 *
 * Mutating tools are recorded as replay gaps by the trace cache; a step that
 * stays within the grammar verbs replays zero-turn, so prefer the backend's
 * `app` option over `open_app` when a test always starts in the same app.
 */
export function agentDeviceTools(
  ...backends: readonly [BackendHandle, ...BackendHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const surfaces = backends.map(requireSurface);
  const platforms = [...new Set(surfaces.map((surface) => surface.options.platform))];
  const active = (): AgentDeviceSurface => {
    const running = surfaces.filter((surface) => surface.attemptRunning);
    const [surface] = running;
    if (surface === undefined || running.length > 1) {
      throw new BackendError(
        'INVALID_STATE',
        running.length === 0
          ? 'no agent-device attempt is running; device tools act inside a test attempt only'
          : 'several agent-device attempts are running in one worker; tools cannot pick a device',
        { retryable: false },
      );
    }
    return surface;
  };
  const annotate = (replay: 'deterministic' | 'none', mutates: boolean): ToolAnnotations => ({
    replay,
    mutates,
    secrets: false,
    platforms,
  });
  const abort = (options: { abortSignal?: AbortSignal }): AbortSignal | undefined => options.abortSignal;

  return {
    open_app: defineTool(
      tool({
        description:
          'Open an app by bundle id, package, or display name (e.g. "Settings"), bringing it to the foreground. Set relaunch to restart it fresh.',
        inputSchema: z.object({ app: z.string().min(1), relaunch: z.boolean().optional() }),
        execute: async ({ app, relaunch }, options) => {
          await active().openApp(app, relaunch === true, abort(options) ?? new AbortController().signal);
          return `Opened ${app}.`;
        },
      }),
      annotate('deterministic', true),
    ),
    swipe: defineTool(
      tool({
        description:
          'Swipe from one screen point to another in logical pixels, e.g. to reveal a row action (swipe the row far left) or to dismiss a sheet.',
        inputSchema: z.object({
          from: z.object({ x: z.number(), y: z.number() }),
          to: z.object({ x: z.number(), y: z.number() }),
        }),
        execute: async ({ from, to }, options) => {
          await active().command('swipe', (client) => client.interactions.swipe({ from, to }), abort(options));
          return `Swiped from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`;
        },
      }),
      annotate('none', true),
    ),
    type_text: defineTool(
      tool({
        description:
          'Type text into whatever field currently has keyboard focus, then optionally press Return. Use only when the focused field is missing from the observation (some editors hide it); otherwise use the type verb on a node.',
        inputSchema: z.object({ text: z.string().min(1), submit: z.boolean().optional() }),
        execute: async ({ text, submit }, options) => {
          const surface = active();
          await surface.command('type', (client) => client.interactions.type({ text }), abort(options));
          if (submit === true) {
            await surface.command('keyboard', (client) => client.command.keyboard({ action: 'enter' }), abort(options));
          }
          return submit === true ? `Typed ${JSON.stringify(text)} and pressed Return.` : `Typed ${JSON.stringify(text)}.`;
        },
      }),
      annotate('none', true),
    ),
    alert: defineTool(
      tool({
        description: 'Accept or dismiss a visible system alert or permission prompt.',
        inputSchema: z.object({ action: z.enum(['accept', 'dismiss']) }),
        execute: async ({ action }, options) => {
          await active().command('alert', (client) => client.command.alert({ action }), abort(options));
          return `Alert ${action}ed.`;
        },
      }),
      annotate('deterministic', true),
    ),
    screenshot: defineTool(
      tool<Record<string, never>, Screenshot, Record<string, unknown>>({
        description:
          'Look at the actual screen pixels. Use when the observation tree is sparse or contradicts what you expect.',
        inputSchema: z.object({}),
        execute: async (_input, options) => {
          const bytes = await active().screenshotBytes(abort(options));
          return { png: Buffer.from(bytes).toString('base64') };
        },
        // The model gets the image itself, not a file path it cannot open.
        toModelOutput: ({ output }) => ({
          type: 'content',
          value: [{ type: 'file', data: { type: 'data', data: output.png }, mediaType: 'image/png' }],
        }),
      }),
      annotate('none', false),
    ),
  };
}
