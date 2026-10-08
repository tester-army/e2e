/**
 * One `lightpanda serve` process: started on a free port, awaited until its
 * CDP server answers, stopped on release. The runner's managed-process
 * module does the same for app commands but is not part of `e2e/engine`,
 * so the process-group handling is mirrored here.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** A sub-resource `lightpanda serve --load-resources` fetches; none are fetched by default. */
export type LightpandaResource = 'iframe' | 'image' | 'stylesheet';

export interface ServeOptions {
  /** The binary to run, as `spawn` resolves it: a path, or a name on `PATH`. */
  readonly binary: string;
  readonly loadResources: readonly LightpandaResource[];
  /** Further `serve` flags, after the ones the provider sets. */
  readonly args: readonly string[];
  /** How long the server gets to answer before the start fails. */
  readonly startupTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface LightpandaServer {
  readonly cdpEndpoint: string;
  /** `Lightpanda-Version` from `/json/version`, or `unknown` for a build that reports none. */
  readonly version: string;
  /** Ends the process: SIGTERM, then SIGKILL after `graceMs` if it is still running. Resolves once it exited. */
  stop(graceMs: number): Promise<void>;
}

const HOST = '127.0.0.1';
const POLL_MS = 50;
const PROBE_TIMEOUT_MS = 500;
/** Stderr kept for the error of a start that fails. */
const STDERR_CAP = 64 * 1024;

/**
 * Starts `lightpanda serve` on a free loopback port and resolves once
 * `/json/version` answers. The process runs in its own process group so a
 * terminal Ctrl-C reaches the runner, which owns the interrupt, and not the
 * browser; `stop` signals the group. Rejects, with the process ended, when
 * it exits first (its stderr in the message), when `startupTimeoutMs`
 * passes, or when `signal` aborts.
 */
export async function serve(options: ServeOptions): Promise<LightpandaServer> {
  const port = await freePort();
  const args = [
    'serve',
    '--host',
    HOST,
    '--port',
    String(port),
    ...options.loadResources.flatMap((resource) => ['--load-resources', resource]),
    ...options.args,
  ];
  const child = spawn(options.binary, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = captureStderr(child);
  const exitReason = new Promise<string>((resolve) => {
    child.once('error', (cause) => resolve(`could not start ${options.binary}: ${cause.message}`));
    child.once('exit', (code, signal) => {
      const tail = stderr().trim();
      resolve(`${options.binary} exited with ${signal ?? `code ${code}`} before its CDP server answered${tail === '' ? '' : `:\n${tail}`}`);
    });
  });
  const cdpEndpoint = `ws://${HOST}:${port}/`;
  try {
    const version = await Promise.race([
      waitForVersion(`http://${HOST}:${port}/json/version`, options.startupTimeoutMs, options.signal),
      exitReason.then((reason) => {
        throw new Error(reason);
      }),
    ]);
    return { cdpEndpoint, version, stop: (graceMs) => stop(child, graceMs) };
  } catch (cause) {
    await stop(child, 1_000);
    throw cause;
  }
}

/** Collects the child's stderr up to the cap; the returned function reads what was kept. */
function captureStderr(child: ChildProcess): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (size >= STDERR_CAP) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

/** Polls `url` until it answers with JSON, resolving to its `Lightpanda-Version`; the caller races it against the process exiting. */
async function waitForVersion(url: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error('cancelled before the CDP server answered');
    if (Date.now() > deadline) throw new Error(`the CDP server did not answer on ${url} within ${timeoutMs}ms`);
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const version = body['Lightpanda-Version'];
        return typeof version === 'string' ? version : 'unknown';
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Signals the process group, then kills it after the grace period; resolves once the process exited. */
function stop(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signalProcessGroup(child, 'SIGTERM');
  });
}

/**
 * Sends `signal` to the whole process group behind `child` (the child alone
 * on Windows, which has no process groups); a group already gone is fine.
 */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    // process already gone
  }
}

/** A loopback port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error('no free port')) : resolve(port)));
    });
  });
}
