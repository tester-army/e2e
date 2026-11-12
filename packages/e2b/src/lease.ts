/**
 * The lease lifecycle both providers share: create a sandbox, open the tunnel
 * to its port, wait until the provider's service is ready, and on any failure
 * close the tunnel and kill the sandbox; plus the option checks and the
 * polling and log reading the ready steps use.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError } from 'e2e/engine';
import { tail, type ClientFor, type E2BCreateParams, type E2BSandbox } from './client.ts';
import { openTunnel, type Tunnel } from './tunnel.ts';

/** Bounds the kill of a sandbox whose lease failed. */
const KILL_TIMEOUT_MS = 30_000;

/** How often `poll` asks, and how long one answer may take. */
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;

/** Bounds the read of a log for an error message. */
const LOG_TIMEOUT_MS = 10_000;

/** What a lease needs from the engine's request: the run's environment and its interrupt. */
interface LeaseRequest {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

/** A sandbox to create, and the port inside it the lease's tunnel reaches. */
export interface LeaseParams extends E2BCreateParams {
  readonly port: number;
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
 * `cause` with the last lines of `log` in the sandbox, for a service that never answered: the log says
 * why. `secret` is cut from them. Reading the log is best-effort and bounded on its own clock.
 */
export async function withLog(sandbox: E2BSandbox, log: string, cause: unknown, secret?: string): Promise<Error> {
  const read = await sandbox.run(`tail -n 20 ${log} 2>/dev/null || true`, { timeoutMs: LOG_TIMEOUT_MS, signal: AbortSignal.timeout(LOG_TIMEOUT_MS) }).catch(() => '');
  const lines = tail(secret === undefined ? read : read.replaceAll(secret, '<redacted>'));
  if (lines === '') return cause instanceof Error ? cause : new Error(messageOf(cause));
  return new Error(`${messageOf(cause)}; ${log}: ${lines}`, { cause });
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

/** The tags every sandbox carries, so a sweep or a person can find a run's sandboxes. */
export function leaseMetadata(request: { readonly runId: string; readonly targetName: string; readonly slot: number }): Record<string, string> {
  return { e2e_run: request.runId, e2e_target: request.targetName, e2e_slot: String(request.slot) };
}

/**
 * The leases one provider holds. `acquire` creates a sandbox, opens the tunnel
 * to `params.port`, and hands both to `ready`, which resolves to the lease. Any
 * failure after the id is known closes the tunnel and kills the sandbox,
 * including a run interrupted while the creation request was in flight.
 * `release` kills the lease's sandbox and closes its tunnel.
 */
export function sandboxLeases(clientFor: ClientFor) {
  const tunnels = new Map<string, Tunnel>();
  return {
    async acquire<T>(request: LeaseRequest, params: LeaseParams, ready: (sandbox: E2BSandbox, tunnel: Tunnel) => Promise<T>): Promise<T> {
      const client = clientFor(request.env);
      const { port, ...create } = params;
      request.signal.throwIfAborted();
      const sandbox = await client.create(create);
      let tunnel: Tunnel | undefined;
      try {
        request.signal.throwIfAborted();
        tunnel = await openTunnel({ host: sandbox.host(port), trafficToken: sandbox.trafficToken });
        const lease = await ready(sandbox, tunnel);
        tunnels.set(sandbox.sandboxId, tunnel);
        return lease;
      } catch (cause) {
        await tunnel?.close();
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
    },
    async release(id: string, context: LeaseRequest): Promise<void> {
      try {
        await clientFor(context.env).kill(id, context.signal);
      } finally {
        await tunnels.get(id)?.close();
        tunnels.delete(id);
      }
    },
  };
}
