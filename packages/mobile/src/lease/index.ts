/**
 * `@e2e-dev/mobile/lease`: what a device-cloud provider package builds on
 * when agent-device runs the cloud's sessions itself (`leaseProvider`). Each
 * lease comes from its own agent-device daemon, in a private state directory
 * and home with the service's credentials, which this package's agent-device
 * starts, renews, and stops.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceClientConfig } from '../bindings.ts';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '../provider.ts';
import { startDriver, stopDriver } from './daemon.ts';
import { LEASE_TTL_MS, startHeartbeat } from './heartbeat.ts';

type ProviderSelector = Extract<keyof DeviceClientConfig, `provider${string}`>;

/** The device a lease asks the service for, and the `provider*` capabilities its session starts with. */
export type LeaseSelectors = { readonly device: string } & Readonly<Partial<Pick<DeviceClientConfig, ProviderSelector>>>;

/** One service agent-device leases devices from. */
export interface AgentDeviceLeaseOptions {
  /** agent-device's name for the service, as the lease provider and tenant: `'browserstack'`. */
  readonly provider: string;
  /** The service's name in errors: `'BrowserStack'`. */
  readonly label: string;
}

/** What one `acquire` allocates. */
export interface AgentDeviceLeaseRequest {
  /** Set on the daemon's environment over the run's: the service's credentials. */
  readonly env: Readonly<Record<string, string>>;
  /** Allocated with the lease and put on its `client`, so the worker's session matches it. */
  readonly selectors: LeaseSelectors;
  /** What the progress line names once the lease is granted, after `lease <id>: `. */
  readonly summary: string;
  /** Runs on the daemon's empty agent-device home before it starts, to install a plugin there. */
  readonly prepareHome?: ((home: string) => Promise<void>) | undefined;
}

/** `acquire` and `release` of a `DeviceProvider` backed by agent-device leases. */
export interface AgentDeviceLeases {
  acquire(request: DeviceRequest, lease: AgentDeviceLeaseRequest): Promise<DeviceLease>;
  /** Stops the lease's daemon, and throws unless agent-device confirms it ended the lease's session. */
  release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void>;
}

/** One lease's daemon; `ended` once its stop confirmed the session ended, so a retried release only cleans up. */
interface Held {
  dir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  stopHeartbeat?: () => Promise<void>;
  releasing?: Promise<void> | undefined;
  ended?: boolean;
}

/**
 * Leases from `options.provider` for a `DeviceProvider`: one isolated
 * agent-device daemon per lease, allocated with `retainOnClose` so closing
 * the engine session keeps it, renewed while held, and stopped on release,
 * which ends the session at the service.
 */
export function agentDeviceLeases({ provider, label }: AgentDeviceLeaseOptions): AgentDeviceLeases {
  const held = new Map<string, Held>();

  /** One release per lease, shared by every caller; a failed one may be tried again. */
  function release(id: string | undefined, resource: Held, signal: AbortSignal): Promise<void> {
    resource.releasing ??= (async () => {
      await resource.stopHeartbeat?.();
      if (resource.ended !== true) {
        await stopDriver(resource.stateDir, resource.env, id, label, signal);
        resource.ended = true;
      }
      await rm(resource.dir, { recursive: true, force: true });
      if (id !== undefined) held.delete(id);
    })();
    resource.releasing.catch(() => { resource.releasing = undefined; });
    return resource.releasing;
  }

  return {
    async acquire(request, { env, selectors, summary, prepareHome }) {
      request.signal.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), `e2e-${provider}-`));
      const home = join(dir, 'home');
      const resource: Held = { dir, stateDir: join(dir, 'state'), env: daemonEnv({ ...request.env, ...env }, home) };
      const leaseBackend: 'ios-instance' | 'android-instance' = request.platform === 'ios' ? 'ios-instance' : 'android-instance';
      const allocated = { platform: request.platform, target: 'mobile' as const, ...selectors };
      let id: string | undefined;
      try {
        await prepareHome?.(home);
        const grant = await startDriver({
          stateDir: resource.stateDir,
          allocate: {
            tenant: provider,
            runId: request.runId,
            leaseBackend,
            leaseProvider: provider,
            ttlMs: LEASE_TTL_MS,
            // Retain the provider lease when closeApp or cleanup closes the engine session.
            // The provider releases the lease at run end.
            retainOnClose: true,
            ...allocated,
          },
        }, resource.env, label);
        id = grant.leaseId;
        held.set(id, resource);
        if (request.signal.aborted) throw new Error('cancelled');
        if (!grant.retainOnClose) throw new Error(`agent-device did not acknowledge retainOnClose. Closing the engine session could end the ${label} lease before run-end release`);
        const scope = { tenant: grant.tenantId, runId: grant.runId, leaseId: grant.leaseId, leaseBackend, leaseProvider: provider };
        resource.stopHeartbeat = await startHeartbeat(resource.stateDir, scope, request.log);
        request.log(`lease ${id}: ${summary}`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors match the session it holds.
        return { id, client: { stateDir: resource.stateDir, ...scope, ...allocated } };
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        try {
          await release(id, resource, AbortSignal.timeout(30_000));
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `${label} lease failed: ${messageOf(cause)}; cleanup also failed: ${messageOf(cleanup)}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease, context) {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal);
    },
  };
}

/** `env` for a daemon in `home`: no daemon setting in it may select a different daemon, home, or connection profile. */
function daemonEnv(env: DeviceRequest['env'], home: string): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    // Keep the user's security policy on both the daemon and its clients.
    if (key === 'AGENT_DEVICE_DAEMON_POLICY') continue;
    if (key.startsWith('AGENT_DEVICE_')) delete result[key];
  }
  result.AGENT_DEVICE_HOME = home;
  return result;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
