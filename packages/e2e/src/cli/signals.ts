/**
 * What Ctrl-C means to the CLI, press by press. The runner installs no
 * process handlers and never exits the process; it takes its interrupt and
 * force signals as options, so process termination is owned here, by the one
 * caller that is the process.
 */

import { killManagedProcessGroups } from '../run/managed-process.ts';

/** How long a CLI whose parent died waits on each rung of the ladder before the next. */
const PARENT_GONE_ESCALATE_MS = 15_000;

/**
 * The escalation ladder behind SIGINT and SIGTERM. The next rung is the first
 * one not yet reached, so the state is the signals themselves: the first
 * signal interrupts, the second forces, the third exits on the spot — the
 * last resort for a teardown that is itself stuck. That exit skips the
 * runner's teardown, so the app process groups it spawned are killed
 * first; otherwise they outlive the run in their own groups and the
 * next run fails with `APP_ALREADY_RUNNING`.
 */
export class SignalLadder {
  private readonly graceful = new AbortController();
  private readonly forced = new AbortController();

  /** Aborts on the first signal: the run interrupts and tears down. */
  get interruptSignal(): AbortSignal {
    return this.graceful.signal;
  }

  /** Aborts on the second signal: every worker tears its engine down at once. */
  get forceSignal(): AbortSignal {
    return this.forced.signal;
  }

  /**
   * Climbs one rung, as a signal does. For a Ctrl-C the terminal delivers as
   * a keypress instead of a signal (stdin in raw mode, for watch mode).
   */
  escalate(exit: (code: number) => void = (code) => process.exit(code)): void {
    if (!this.graceful.signal.aborted) this.graceful.abort();
    else if (!this.forced.signal.aborted) this.forced.abort();
    else {
      killManagedProcessGroups();
      exit(130);
    }
  }

  /**
   * Installs the process handlers; returns their removal. A CLI spawned with
   * an IPC channel (`e2e mcp`'s `run_tests`) treats the channel closing as
   * its parent dying: nobody is left to read the run or press Ctrl-C again,
   * so it climbs the whole ladder on its own, one rung per `parentGoneMs`.
   */
  arm(exit: (code: number) => void = (code) => process.exit(code), parentGoneMs = PARENT_GONE_ESCALATE_MS): () => void {
    const escalate = (): void => this.escalate(exit);
    let climbing: NodeJS.Timeout | undefined;
    const parentGone = (): void => {
      escalate();
      climbing = setInterval(escalate, parentGoneMs);
      climbing.unref();
    };
    process.on('SIGINT', escalate);
    process.on('SIGTERM', escalate);
    process.on('disconnect', parentGone);
    if (process.connected === false) parentGone();
    return () => {
      process.removeListener('SIGINT', escalate);
      process.removeListener('SIGTERM', escalate);
      process.removeListener('disconnect', parentGone);
      clearInterval(climbing);
    };
  }
}
