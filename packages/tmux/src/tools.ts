/**
 * Agent-side tools for terminal targets. The grammar verbs already cover a
 * keystroke at a time (press) and text (type); what a model needs beyond
 * them is a chord or a sequence in one move (`C-c` twice, `/`, `help`,
 * `Enter`), a wait for the program to print something, and the history
 * that scrolled off the screen. Each tool is scoped to the `terminal`
 * platform so a mixed suite never offers it on a browser.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type DefinedTool, type ToolAnnotations } from '@e2edev/e2e/agent';
import { BackendError, type BackendHandle } from '@e2edev/e2e/backend';
import { surfaceOf } from './backend.ts';
import type { TmuxSurface } from './surface.ts';

/**
 * One wait is capped well under a step budget: a model waiting for text that
 * never comes should lose a minute and get its screen back, not the step.
 */
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 60_000;

function requireSurface(backend: BackendHandle): TmuxSurface {
  const surface = surfaceOf(backend);
  if (surface === undefined) {
    throw new BackendError('INVALID_STATE', 'tmuxTools needs handles returned by tmux()', { retryable: false });
  }
  return surface;
}

/**
 * Builds the tool pack for one or more tmux backends, keyed the way
 * `createAgent({ tools })` expects. Pass every terminal backend a config
 * declares: tool names are fixed, so two packs cannot be merged. A worker
 * runs one attempt at a time, so at execution the pack dispatches to the
 * surface whose attempt is running.
 */
export function tmuxTools(...backends: readonly [BackendHandle, ...BackendHandle[]]): Readonly<Record<string, DefinedTool>> {
  const surfaces = backends.map(requireSurface);
  const active = (): TmuxSurface => {
    const running = surfaces.filter((surface) => surface.attemptRunning);
    const [surface] = running;
    if (surface === undefined || running.length > 1) {
      throw new BackendError(
        'INVALID_STATE',
        running.length === 0
          ? 'no tmux attempt is running; terminal tools act inside a test attempt only'
          : 'several tmux attempts are running in one worker; tools cannot pick a terminal',
        { retryable: false },
      );
    }
    return surface;
  };
  const annotate = (replay: 'deterministic' | 'none', mutates: boolean): ToolAnnotations => ({
    replay,
    mutates,
    secrets: false,
    platforms: ['terminal'],
  });
  const abort = (options: { abortSignal?: AbortSignal }): AbortSignal => options.abortSignal ?? new AbortController().signal;

  return {
    send_keys: defineTool(
      tool({
        description:
          'Send a sequence of keys to the program in tmux key syntax, in order. Named keys: Enter, Escape, Tab, BTab, Up, Down, Left, Right, Home, End, PPage, NPage, BSpace, DC, Space, F1-F12. Chords: C-c (Control+C), M-x (Alt+X), C-M-Left. Anything else is typed literally, so ["/", "help", "Enter"] types /help and submits it. Use this for shortcuts and multi-key sequences; use the type verb for plain text.',
        inputSchema: z.object({ keys: z.array(z.string().min(1)).min(1).max(32) }),
        execute: async ({ keys }, options) => {
          await active().sendKeys(keys, abort(options));
          return `Sent ${keys.map((key) => JSON.stringify(key)).join(' ')}.`;
        },
      }),
      annotate('none', true),
    ),
    wait_for_text: defineTool(
      tool({
        description:
          'Wait until some row of the screen contains the given text (or matches the regular expression when regex is true). Use it after asking the program to do something slow, instead of observing repeatedly. Fails with the current screen when the text does not appear within timeoutMs (at most 60000).',
        inputSchema: z.object({
          text: z.string().min(1),
          regex: z.boolean().optional(),
          timeoutMs: z.number().int().positive().max(MAX_WAIT_MS).optional(),
        }),
        execute: async ({ text, regex, timeoutMs }, options) => {
          const pattern = regex === true ? new RegExp(text) : text;
          const line = await active().waitForText(pattern, timeoutMs ?? DEFAULT_WAIT_MS, abort(options));
          return `The screen shows: ${JSON.stringify(line)}`;
        },
      }),
      annotate('deterministic', false),
    ),
    scrollback: defineTool(
      tool({
        description: 'Read the newest lines of the terminal history, including what scrolled off the visible screen.',
        inputSchema: z.object({ lines: z.number().int().positive().max(2000).optional() }),
        execute: async ({ lines }, options) => active().scrollback(lines ?? 200, abort(options)),
      }),
      annotate('none', false),
    ),
  };
}
