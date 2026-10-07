/** One `lightpanda serve` process: started on a free port, awaited until its CDP server answers, stopped on release. */

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
  readonly signal: AbortSignal;
}

export interface LightpandaServer {
  readonly pid: number;
  readonly cdpEndpoint: string;
  /** `Lightpanda-Version` from `/json/version`, when the server reports one. */
  readonly version: string | undefined;
  /** Ends the process: SIGTERM, then SIGKILL after `graceMs` if it is still running. Resolves once it exited. */
  stop(graceMs: number): Promise<void>;
}

const HOST = '127.0.0.1';
const POLL_MS = 50;

/**
 * Starts `lightpanda serve` on a free loopback port and resolves once
 * `/json/version` answers. The process runs in its own process group so a
 * terminal Ctrl-C reaches the runner, which owns the interrupt, and not the
 * browser; `stop` signals the group. Rejects, with the process ended, when
 * it exits first (its stderr in the message), or when `signal` aborts.
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
  const child = spawn(options.binary, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.reduce((total, part) => total + part.length, 0) < 64 * 1024) stderr.push(chunk);
  });
  const exited = new Promise<string>((resolve) => {
    child.once('error', (cause) => resolve(`could not start ${options.binary}: ${cause.message}`));
    child.once('exit', (code, signal) => {
      const tail = Buffer.concat(stderr).toString('utf8').trim();
      resolve(`${options.binary} exited with ${signal ?? `code ${code}`} before its CDP server answered${tail === '' ? '' : `:\n${tail}`}`);
    });
  });
  const cdpEndpoint = `ws://${HOST}:${port}/`;
  const server: LightpandaServer = {
    pid: child.pid ?? -1,
    cdpEndpoint,
    version: undefined,
    stop: (graceMs) => stop(child, graceMs),
  };
  try {
    const version = await Promise.race([
      waitForVersion(`http://${HOST}:${port}/json/version`, options.signal),
      exited.then((reason) => {
        throw new Error(reason);
      }),
    ]);
    return { ...server, version };
  } catch (cause) {
    await stop(child, 1_000);
    throw cause;
  }
}

/** Polls `url` until it answers with JSON, resolving to its `Lightpanda-Version`; the caller races it against the process exiting. */
async function waitForVersion(url: string, signal: AbortSignal): Promise<string | undefined> {
  for (;;) {
    if (signal.aborted) throw new Error('cancelled before the CDP server answered');
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_MS * 10)]) });
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const version = body['Lightpanda-Version'];
        return typeof version === 'string' ? version : undefined;
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
    const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signalGroup(child, 'SIGTERM');
  });
}

/** Signals the process group `detached` put the child in; the child alone if the group is gone already. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
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
