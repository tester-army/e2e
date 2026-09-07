/**
 * What Ctrl-C means to the CLI, press by press. The runner installs no
 * process handlers and never exits the process — a host embedding it passes
 * its own signals — so process termination is owned here, by the one caller
 * that is the process.
 */

/**
 * The escalation ladder behind SIGINT and SIGTERM. The next rung is the first
 * one not yet reached, so the state is the signals themselves: the first
 * signal interrupts, the second forces, the third exits on the spot — the
 * last resort for a teardown that is itself stuck.
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

  /** Installs the process handlers; returns their removal. */
  arm(exit: (code: number) => void = (code) => process.exit(code)): () => void {
    const escalate = (): void => {
      if (!this.graceful.signal.aborted) this.graceful.abort();
      else if (!this.forced.signal.aborted) this.forced.abort();
      else exit(130);
    };
    process.on('SIGINT', escalate);
    process.on('SIGTERM', escalate);
    return () => {
      process.removeListener('SIGINT', escalate);
      process.removeListener('SIGTERM', escalate);
    };
  }
}
