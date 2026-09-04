/**
 * The `terminal` fixture: deterministic control of the pane this backend
 * contributes. Not an agent tool; a test calls these directly to arrange or
 * assert terminal state, and the harness records each call as a
 * `terminal.<method>` step bounded by the action timeout.
 */

import type { BackendFixtureContext } from '@e2edev/e2e/backend';
import type { TmuxSurface } from './surface.ts';

/** Deterministic terminal control exposed to tests as `terminal`. */
export interface Terminal {
  /** Absolute working directory the program runs in, for checks on the files it writes. */
  readonly cwd: string;
  /** The visible screen: rows joined by newlines, trailing blank rows dropped. */
  text(): Promise<string>;
  /** History plus the visible screen, the newest `lines` rows (default 200). */
  scrollback(lines?: number): Promise<string>;
  /** Types text literally, character by character, without pressing Enter. */
  type(text: string): Promise<void>;
  /** Presses one key: a browser name (`Enter`, `Escape`, `ArrowDown`, `Control+C`) or a tmux chord (`C-c`). */
  press(key: string): Promise<void>;
  /** Sends tmux key names as is, in order: `send('C-x', 'C-c')`, `send('/', 'Enter')`. */
  send(...keys: string[]): Promise<void>;
  /** Waits until a row matches and resolves with it, trimmed. Default timeout: the action timeout. */
  waitForText(pattern: string | RegExp, options?: { timeout?: number }): Promise<string>;
  /** Waits until the program exits and resolves with its exit status when tmux reports one. */
  waitForExit(options?: { timeout?: number }): Promise<number | undefined>;
  /** Whether the program has exited. */
  exited(): Promise<boolean>;
  /** Resizes the pane in cells. */
  resize(columns: number, rows: number): Promise<void>;
  /** Cursor cell, zero-based from the top-left. */
  cursor(): Promise<{ x: number; y: number }>;
  /** The program's own title for the pane. */
  title(): Promise<string>;
}

/** Builds the terminal fixture for one attempt. */
export function createTerminalFixture(surface: TmuxSurface, context: BackendFixtureContext): Terminal {
  const signal = context.signal;
  return {
    cwd: surface.cwd,
    text: () => surface.text(signal),
    scrollback: (lines = 200) => surface.scrollback(lines, signal),
    type: (text) => surface.typeText(text, signal),
    press: (key) => surface.pressKey(key, signal),
    send: (...keys) => surface.sendKeys(keys, signal),
    waitForText: (pattern, options) => surface.waitForText(pattern, options?.timeout ?? context.timeouts.action, signal),
    waitForExit: (options) => surface.waitForExit(options?.timeout ?? context.timeouts.action, signal),
    exited: async () => (await surface.capture(signal)).dead,
    resize: (columns, rows) => surface.resize(columns, rows, signal),
    cursor: async () => {
      const { cursor } = await surface.capture(signal);
      return { x: cursor.x, y: cursor.y };
    },
    title: async () => (await surface.capture(signal)).title,
  };
}
