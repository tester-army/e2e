/** Raw-mode keys for the commands that read the terminal while a run reports: `run --watch` and `run --step`. */

import { emitKeypressEvents } from 'node:readline';

/** A key the terminal delivers, as `readline` names it. */
export interface Keypress {
  readonly name: string | undefined;
  readonly ctrl: boolean;
  readonly sequence?: string | undefined;
}

/** Ctrl-C and Ctrl-D: in raw mode they arrive as keypresses, never as a signal. */
function isInterruptPress(press: Keypress): boolean {
  return press.ctrl && (press.name === 'c' || press.name === 'd');
}

/**
 * Raw-mode stdin delivering the keys `keyOf` names, pausable while a prompt
 * owns the terminal. Raw mode is turned off on every way out of the process,
 * so an exit nobody saw coming (the last rung of the Ctrl-C ladder) still
 * leaves the terminal as it found it.
 */
export class Keyboard<Key> {
  private handler: ((key: Key) => void) | undefined;
  private readonly onKeypress = (_chunk: unknown, press: Keypress | undefined): void => {
    if (press === undefined || this.handler === undefined) return;
    const key = this.keyOf(press);
    if (key !== undefined) this.handler(key);
  };
  /** While a prompt has the keys, Ctrl-C still ends the session: the prompt only closes on it. */
  private readonly onInterruptOnly = (_chunk: unknown, press: Keypress | undefined): void => {
    if (press === undefined || !isInterruptPress(press)) return;
    const key = this.keyOf(press);
    if (key !== undefined) this.handler?.(key);
  };
  private readonly restore = (): void => {
    this.stdin.setRawMode?.(false);
  };

  constructor(
    private readonly stdin: NodeJS.ReadStream,
    private readonly keyOf: (press: Keypress) => Key | undefined,
  ) {
    emitKeypressEvents(stdin);
  }

  /** Starts delivering keys to `handler`, in raw mode. */
  listen(handler: (key: Key) => void): void {
    this.handler = handler;
    process.on('exit', this.restore);
    this.resume();
  }

  /** Takes the terminal back after a prompt: raw mode on, keys delivered again. */
  resume(): void {
    this.stdin.off('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(true);
    this.stdin.on('keypress', this.onKeypress);
    this.stdin.resume();
  }

  /** Hands the terminal to a prompt: raw mode off, no key but Ctrl-C delivered. */
  pause(): void {
    this.stdin.off('keypress', this.onKeypress);
    this.stdin.on('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(false);
  }

  /**
   * Ctrl-Z: stops the process as the terminal would outside raw mode, with
   * the terminal restored first. The stop goes to the whole process group,
   * the job the shell waits on: a `| tee` or a package manager's wrapper
   * stops with it, and one `fg` resumes them all. Timers do not run while
   * a process is stopped: the resume fires on the continue, or at once
   * under a shell without job control, where the stop is ignored.
   */
  suspend(): void {
    if (process.platform === 'win32') return;
    this.pause();
    setTimeout(() => this.resume(), 0);
    process.kill(0, 'SIGTSTP');
  }

  /** Stops for good: raw mode off, stdin paused so it no longer holds the process open. */
  close(): void {
    this.stdin.off('keypress', this.onKeypress);
    this.stdin.off('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
    process.off('exit', this.restore);
  }
}
