/**
 * Ctrl-C for `e2e-core` hosts: on SIGINT, SIGTERM, or SIGHUP every host that
 * asked for it (`handleSignals`, on by default) closes, so the browsers and
 * device sessions it launched do not outlive the program. The signal is then
 * raised again for the process's own disposition, unless the program listens
 * for it itself, in which case its listener decides.
 */

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type Closer = () => Promise<unknown>;

const closers = new Set<Closer>();
let installed = false;

/** Closes every registered host once, then hands the signal back to the process. */
function onSignal(signal: NodeJS.Signals): void {
  uninstall();
  // The process ends right after, so a close that failed is said on stderr or nowhere; its message is already redacted.
  const pending = [...closers].map((close) => close().catch((cause: unknown) => {
    process.stderr.write(`e2e-core: closing a host on ${signal} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }));
  closers.clear();
  void Promise.allSettled(pending).then(() => {
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  for (const signal of SIGNALS) process.off(signal, onSignal);
}

/** Registers a host's close for the process signals; the returned function unregisters it. */
export function closeOnSignals(close: Closer): () => void {
  closers.add(close);
  install();
  return () => {
    closers.delete(close);
    if (closers.size === 0) uninstall();
  };
}
