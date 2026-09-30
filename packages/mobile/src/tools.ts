/**
 * Agent-side tools for device targets. Everything a model plans through
 * beyond the grammar verbs the engine already unlocks (tap, type, scroll,
 * screenshot, tap_at) lives here: opening another app, a free-form swipe,
 * typing into the focused field, and system alerts. Each tool is scoped to
 * the platforms of the engines it was built from, so a mixed suite never
 * offers it on a browser.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { defineTool, type DefinedTool, type ToolAnnotations } from 'e2e/agent';
import { EngineError, type EngineHandle } from 'e2e/engine';
import { surfaceOf } from './engine.ts';
import type { AgentDeviceSurface } from './surface.ts';

/**
 * Types a tool the way the SDK's `tool()` does, without importing it: `ai`
 * is an optional peer dependency, and this module loads with the project's
 * config, so it must not need the package at run time.
 */
function deviceTool<INPUT>(definition: Tool<INPUT, string>): Tool<INPUT, string> {
  return definition;
}

function requireSurface(engine: EngineHandle): AgentDeviceSurface {
  const surface = surfaceOf(engine);
  if (surface === undefined) {
    throw new EngineError('INVALID_STATE', 'mobileTools needs handles returned by mobile()', {
      retryable: false,
    });
  }
  return surface;
}

/**
 * Builds the tool pack for one or more agent-device engines, keyed the way
 * an agents entry's `tools` expects. Pass every device engine a config
 * declares: tool names are fixed, so two packs cannot be merged, and each
 * tool is offered only on the platforms those engines drive. A worker runs
 * one attempt at a time, so at execution the pack dispatches to the surface
 * whose attempt is running.
 *
 * Mutating tools are recorded as replay gaps by the trace cache; a step that
 * stays within the grammar verbs replays zero-turn, so prefer the target's
 * `app.bundleId` over `open_app` when a test always starts in the same app.
 */
export function mobileTools(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const surfaces = engines.map(requireSurface);
  const platforms = [...new Set(surfaces.map((surface) => surface.options.platform))];
  const active = (): AgentDeviceSurface => {
    const running = surfaces.filter((surface) => surface.attemptRunning);
    const [surface] = running;
    if (surface === undefined || running.length > 1) {
      throw new EngineError(
        'INVALID_STATE',
        running.length === 0
          ? 'no agent-device attempt is running; device tools act inside a test attempt only'
          : 'several agent-device attempts are running in one worker; tools cannot pick a device',
        { retryable: false },
      );
    }
    return surface;
  };
  const annotate = (mutates: boolean): ToolAnnotations => ({
    mutates,
    platforms,
  });
  const abort = (options: { abortSignal?: AbortSignal }): AbortSignal | undefined => options.abortSignal;

  return {
    open_app: defineTool(
      deviceTool({
        description:
          'Open an app by bundle id, package, or display name (e.g. "Settings"), bringing it to the foreground. Set relaunch to restart it fresh. Takes an app, not a URL: a link is refused.',
        inputSchema: z.object({ app: z.string().min(1), relaunch: z.boolean().optional() }),
        execute: async ({ app, relaunch }, options) => {
          await active().openApp(app, { relaunch: relaunch === true }, abort(options) ?? new AbortController().signal);
          return `Opened ${app}.`;
        },
      }),
      annotate(true),
    ),
    swipe: defineTool(
      deviceTool({
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
      annotate(true),
    ),
    alert: defineTool(
      deviceTool({
        description:
          'Accept or dismiss a visible system alert or permission prompt. Use it when the alert\'s buttons are not listed on screen; a listed button tapped by id is the same tap and replays from the trace cache, this tool does not.',
        inputSchema: z.object({ action: z.enum(['accept', 'dismiss']) }),
        execute: async ({ action }, options) => {
          await active().command('alert', (client) => client.command.alert({ action }), abort(options));
          return `Alert ${action}ed.`;
        },
      }),
      annotate(true),
    ),
  };
}
