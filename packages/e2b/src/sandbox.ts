/**
 * What both providers share: the slice of the E2B SDK they use, loaded on
 * first use so a config load never pays for it; option checks; and the lease
 * lifecycle, from creating a sandbox to killing it and closing its tunnel.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Sandbox } from 'e2b';
import { ConfigurationError } from 'e2e/engine';
import type { Tunnel } from './tunnel.ts';

/**
 * Where sandboxes are reached, every field from the run's environment. The
 * SDK falls back to `process.env` for any it is not given, so the domain and
 * API URL are always passed, and debug mode, which points the SDK at a local
 * E2B, is always off.
 */
interface E2BConnection {
  readonly apiKey: string;
  readonly domain: string;
  readonly apiUrl: string;
  readonly sandboxUrl?: string | undefined;
}

export interface E2BCreateParams {
  readonly template: string;
  readonly timeoutMs: number;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * The `Host` E2B's edge puts on every request it forwards into the sandbox,
   * with `${PORT}` standing for the port, such as `localhost:${PORT}`. Unset,
   * a request arrives with the public host it was sent to.
   */
  readonly maskRequestHost?: string | undefined;
}

interface CommandOptions {
  /** Environment variables for the command only, such as a token kept out of the command text E2B receives. */
  readonly envs?: Record<string, string> | undefined;
  readonly signal: AbortSignal;
}

/** One running sandbox, as much of it as the providers drive. */
export interface E2BSandbox {
  readonly sandboxId: string;
  /** The token E2B wants on every request to a sandbox port: sandboxes refuse public traffic. */
  readonly trafficToken: string;
  /** Runs a shell command to completion and resolves to its stdout; rejects when it exits non-zero, with its output in the message. */
  run(command: string, options: CommandOptions & { timeoutMs: number }): Promise<string>;
  /** Starts a shell command and leaves it running. */
  start(command: string, options: CommandOptions): Promise<void>;
  /** The public host a port inside the sandbox answers on, without the scheme. */
  host(port: number): string;
}

export interface E2BSandboxes {
  /**
   * Creates a sandbox under a budget of its own: a creation request cut off by
   * the run's interrupt could still start a sandbox whose id never arrives, so
   * the caller checks its own signal once the id is in hand.
   */
  create(params: E2BCreateParams): Promise<E2BSandbox>;
  /** The bytes of one file on the disk of a sandbox another process may have created. */
  readFile(sandboxId: string, file: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Kills a sandbox; one E2B no longer knows counts as killed. Resolves to whether E2B still knew it. */
  kill(sandboxId: string, signal: AbortSignal): Promise<boolean>;
  /** The ids of the running sandboxes carrying every one of `metadata`. */
  list(metadata: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string[]>;
}

/** Bounds one creation request: E2B answers in seconds, so a minute means it is not coming. */
const CREATE_TIMEOUT_MS = 60_000;

/** Bounds the kill of a sandbox whose lease failed. */
const KILL_TIMEOUT_MS = 30_000;

/**
 * Appended to the `User-Agent` of every E2B request, so E2B can tell this integration's traffic apart.
 * The version is this package's, not e2e's.
 */
const INTEGRATION = `e2e-e2b/${(createRequire(import.meta.url)('../package.json') as { version: string }).version}`;

/** How often `poll` asks, and how long one answer may take. */
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;

/** Bounds the read of a log for an error message. */
const LOG_TIMEOUT_MS = 10_000;

/** How much of a failed command's output its error keeps: enough to name what failed without flooding the run's error line. */
const OUTPUT_TAIL_CHARS = 600;

/** The last `OUTPUT_TAIL_CHARS` of a command's output. */
function tail(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `...${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

/**
 * `cause` with the last lines of `log` in the sandbox, for a service that never answered: the log says
 * why. `secret` is cut from them. Reading the log is best-effort and bounded on its own clock.
 */
export async function withLog(sandbox: E2BSandbox, log: string, cause: unknown, secret?: string): Promise<Error> {
  const read = await sandbox.run(`tail -n 20 ${log} 2>/dev/null || true`, { timeoutMs: LOG_TIMEOUT_MS, signal: AbortSignal.timeout(LOG_TIMEOUT_MS) }).catch(() => '');
  const lines = tail(secret === undefined ? read : read.replaceAll(secret, '<redacted>'));
  if (lines === '') return cause instanceof Error ? cause : new Error(messageOf(cause));
  return new Error(`${messageOf(cause)}; ${log}: ${lines}`, { cause });
}

/** The message of a thrown value, for an error line. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Calls `probe` every `POLL_INTERVAL_MS`, each call bounded to
 * `PROBE_TIMEOUT_MS`, until it resolves, and resolves to its value. When
 * `signal` ends first, fails with `what` and the last probe's error.
 */
export async function poll<T>(what: string, signal: AbortSignal, probe: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let last = 'no answer';
  while (true) {
    if (signal.aborted) throw new Error(`${what}: ${last}`, { cause: signal.reason });
    try {
      return await probe(AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]));
    } catch (cause) {
      if (!signal.aborted) last = messageOf(cause);
    }
    await sleep(POLL_INTERVAL_MS, undefined, { signal }).catch(() => {});
  }
}

/**
 * A signal that follows `signal` only until `settled` does. The SDK ties a
 * command's signal to its output stream for the command's whole life, so a
 * long-running command gets one that can cancel its start but never its stream.
 */
async function untilSettled<T>(signal: AbortSignal, settled: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const starting = new AbortController();
  const onAbort = () => starting.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await settled(starting.signal);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** E2B sandboxes for one connection, through the SDK. */
function e2bSandboxes(connection: E2BConnection): E2BSandboxes {
  const sdk = import('e2b').then((module) => {
    // Read when the SDK builds a connection config, so it runs before the first request.
    module.ConnectionConfig.setIntegration(INTEGRATION);
    return module;
  });
  const { sandboxUrl, ...rest } = connection;
  const opts = { ...rest, ...(sandboxUrl === undefined ? {} : { sandboxUrl }), debug: false };

  async function wrap(sandbox: Sandbox): Promise<E2BSandbox> {
    const { CommandExitError } = await sdk;
    const trafficToken = sandbox.trafficAccessToken;
    if (trafficToken === undefined || trafficToken === '') {
      throw new Error(`E2B created sandbox ${sandbox.sandboxId} without a traffic access token`);
    }
    return {
      sandboxId: sandbox.sandboxId,
      trafficToken,
      async run(command, { envs, timeoutMs, signal }) {
        try {
          // Aborting ends only the SDK's stream; the process dies with the sandbox `createAndServe` kills.
          const result = await sandbox.commands.run(command, { timeoutMs, signal, ...(envs === undefined ? {} : { envs }) });
          return result.stdout;
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          if (cause instanceof CommandExitError) throw new Error(`exited ${cause.exitCode}: ${tail(cause.stderr) || tail(cause.stdout)}`, { cause });
          throw cause;
        }
      },
      async start(command, { envs, signal }) {
        const handle = await untilSettled(signal, (starting) =>
          sandbox.commands.run(command, { background: true, timeoutMs: 0, signal: starting, ...(envs === undefined ? {} : { envs }) }),
        );
        // The process keeps running; only the SDK's output stream for it closes.
        await handle.disconnect();
      },
      host: (port) => sandbox.getHost(port),
    };
  }

  return {
    async create(params) {
      const { Sandbox } = await sdk;
      const sandbox = await Sandbox.create(params.template, {
        ...opts,
        timeoutMs: params.timeoutMs,
        metadata: { ...params.metadata },
        network: { allowPublicTraffic: false, ...(params.maskRequestHost === undefined ? {} : { maskRequestHost: params.maskRequestHost }) },
        // The SDK retries a failed create; the key makes E2B answer a retry with the same sandbox.
        idempotencyKey: `e2e-${randomUUID()}`,
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      });
      try {
        return await wrap(sandbox);
      } catch (cause) {
        await sandbox.kill().catch(() => {});
        throw cause;
      }
    },
    async readFile(sandboxId, file, signal) {
      const { Sandbox } = await sdk;
      const sandbox = await Sandbox.connect(sandboxId, { ...opts, signal });
      return sandbox.files.read(file, { format: 'bytes', signal });
    },
    async kill(sandboxId, signal) {
      const { Sandbox } = await sdk;
      return Sandbox.kill(sandboxId, { ...opts, signal });
    },
    async list(metadata, signal) {
      const { Sandbox } = await sdk;
      const paginator = Sandbox.list({ ...opts, query: { metadata: { ...metadata }, state: ['running'] } });
      const ids: string[] = [];
      while (paginator.hasNext) {
        signal.throwIfAborted();
        for (const info of await paginator.nextItems({ signal })) ids.push(info.sandboxId);
      }
      return ids;
    },
  };
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The connection the run's environment names, never `process.env`. */
function connectionFor(env: Readonly<Record<string, string | undefined>>): E2BConnection {
  const apiKey = envValue(env, 'E2B_API_KEY');
  if (apiKey === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', '@e2e-dev/e2b requires E2B_API_KEY in the run environment');
  }
  const sandboxUrl = envValue(env, 'E2B_SANDBOX_URL');
  // The SDK reads the runner's `E2B_SANDBOX_URL` when given none.
  const ambient = envValue(process.env, 'E2B_SANDBOX_URL');
  if (ambient !== undefined && ambient !== sandboxUrl) {
    throw new ConfigurationError('INVALID_CONFIG', "@e2e-dev/e2b: unset E2B_SANDBOX_URL in the runner's environment, or set the same value in the run environment; the E2B SDK reads it whatever the run environment says");
  }
  const domain = envValue(env, 'E2B_DOMAIN') ?? 'e2b.app';
  return { apiKey, domain, apiUrl: envValue(env, 'E2B_API_URL') ?? `https://api.${domain}`, ...(sandboxUrl === undefined ? {} : { sandboxUrl }) };
}

/** One SDK client per connection, shared by every request a provider serves. */
export function sandboxClients(): (env: Readonly<Record<string, string | undefined>>) => E2BSandboxes {
  const clients = new Map<string, E2BSandboxes>();
  return (env) => {
    const connection = connectionFor(env);
    const key = `${connection.apiUrl}\n${connection.sandboxUrl ?? ''}\n${connection.domain}\n${connection.apiKey}`;
    let client = clients.get(key);
    if (client === undefined) {
      client = e2bSandboxes(connection);
      clients.set(key, client);
    }
    return client;
  };
}

/** A template option: a non-empty name, or the provider's default when absent. */
export function templateOption(factory: string, template: unknown, fallback: string): string {
  if (template === undefined) return fallback;
  if (typeof template !== 'string' || template.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', `${factory}: template must be a non-empty template name`);
  }
  return template;
}

/** A sandbox lifetime option: a positive integer of milliseconds, or the provider's default when absent. */
export function timeoutOption(factory: string, timeoutMs: unknown, fallback: number): number {
  if (timeoutMs === undefined) return fallback;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${factory}: timeoutMs must be a positive integer of milliseconds`);
  }
  return timeoutMs;
}

/**
 * Creates a sandbox and hands it to `serve` inside one cleanup boundary:
 * every failure after the id is known kills the sandbox, including a run
 * interrupted while the creation request was in flight.
 */
export async function createAndServe<T>(
  client: E2BSandboxes,
  params: E2BCreateParams,
  signal: AbortSignal,
  serve: (sandbox: E2BSandbox) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const sandbox = await client.create(params);
  try {
    signal.throwIfAborted();
    return await serve(sandbox);
  } catch (cause) {
    try {
      await client.kill(sandbox.sandboxId, AbortSignal.timeout(KILL_TIMEOUT_MS));
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        `E2B lease failed: ${messageOf(cause)}; killing sandbox ${sandbox.sandboxId} also failed, so E2B ends it after timeoutMs: ${messageOf(cleanup)}`,
        { cause: cleanup },
      );
    }
    throw cause;
  }
}

/** The tags every sandbox carries, so a sweep or a person can find a run's sandboxes. */
export function leaseMetadata(request: { readonly runId: string; readonly targetName: string; readonly slot: number }): Record<string, string> {
  return { e2e_run: request.runId, e2e_target: request.targetName, e2e_slot: String(request.slot) };
}

/**
 * The open tunnel of each lease one provider acquired. `hold` keeps the
 * tunnel of the lease `serve` resolves to, and closes it when `serve` fails;
 * `release` kills the lease's sandbox and closes its tunnel.
 */
export function leaseTunnels(clientFor: (env: Readonly<Record<string, string | undefined>>) => E2BSandboxes) {
  const tunnels = new Map<string, Tunnel>();
  return {
    async hold<T extends { readonly id: string }>(tunnel: Tunnel, serve: () => Promise<T>): Promise<T> {
      try {
        const lease = await serve();
        tunnels.set(lease.id, tunnel);
        return lease;
      } catch (cause) {
        await tunnel.close();
        throw cause;
      }
    },
    async release(id: string, context: { readonly env: Readonly<Record<string, string | undefined>>; readonly signal: AbortSignal }): Promise<void> {
      try {
        await clientFor(context.env).kill(id, context.signal);
      } finally {
        await tunnels.get(id)?.close();
        tunnels.delete(id);
      }
    },
  };
}
