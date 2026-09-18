/**
 * The seam a hosted device service plugs into: a `DeviceProvider` leases one
 * device per worker slot for the run and hands back the agent-device daemon
 * that drives it. The engine acquires in `prepare`, drives each lease from
 * its worker, and releases in `finish`, on every exit path. Nothing here
 * knows any vendor: a hosted simulator service, a device farm, or a daemon on
 * a machine down the hall are each one small provider in user code.
 */

import { ConfigurationError } from 'e2e/engine';
import { isDaemon } from './bindings.ts';
import type { AgentDevicePlatform } from './options.ts';

/** What the engine asks a provider for: one device for one worker slot of a run. */
export interface DeviceRequest {
  /** Platform the target's device must run. */
  readonly platform: AgentDevicePlatform;
  /** The run id, for naming the session at the provider. */
  readonly runId: string;
  /** The target the device serves. */
  readonly targetName: string;
  /** Worker slot the device serves, `0` to `slots - 1`; `slots` leases are acquired at once. */
  readonly slot: number;
  /** Devices the run acquires for this target, in all. */
  readonly slots: number;
  /** The `app` option: the bundle id or package the engine opens fresh per attempt, when the config names one. */
  readonly app?: string | undefined;
  /**
   * The build the engine would install, resolved to an absolute path, when
   * the config names one. A provider that installs it itself (uploading it,
   * or naming a build it already hosts) reports `installedApp` on the lease
   * and the engine skips its own install.
   */
  readonly appPath?: string | undefined;
  /** The run's environment: where a provider reads its token from, never `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts on interrupt only; acquiring has no budget of its own. */
  readonly signal: AbortSignal;
  /** Reports one line of progress to the run's reporter (a session URL to watch). */
  readonly log: (line: string) => void;
}

/**
 * One leased device, as `acquire` returns it and `release` gets it back.
 * JSON data only: a lease travels from the runner process to the worker that
 * drives it through the environment.
 */
export interface DeviceLease {
  /**
   * The provider's handle on the lease (a session id); named in progress
   * lines and handed back to `release`. A provider may keep further fields on
   * the object it returns: `release` gets that same object, while only the
   * fields declared here travel to the worker.
   */
  readonly id: string;
  /** The agent-device daemon the worker connects to instead of its local one. */
  readonly daemon: {
    /** Base URL answering agent-device's `GET /health` and `POST /rpc`. */
    readonly baseUrl: string;
    /** Bearer token the daemon expects, when it wants one. */
    readonly authToken?: string | undefined;
  };
  /** Device to select inside that daemon, by name or UDID, when it hosts more than one. */
  readonly device?: string | undefined;
  /**
   * Bundle id or package of the app the provider installed from the
   * request's `appPath`, and only then: with it the engine installs nothing
   * and, without an `app` option, opens this app fresh per attempt. A lease
   * reporting one for a request without `appPath` fails the run.
   */
  readonly installedApp?: string | undefined;
}

/** Handed to `release`, once per lease at the end of the run. */
export interface DeviceReleaseContext {
  readonly runId: string;
  readonly targetName: string;
  /** The run's environment, the same `acquire` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/**
 * A source of hosted devices. `acquire` is called once per worker slot, for
 * every slot at once; `release` once per lease acquired, at the end of the
 * run, also after an `acquire` of another slot failed. Both run in the
 * runner process, so a provider may keep state between them.
 */
export interface DeviceProvider {
  /** Label in progress lines and error messages. */
  readonly name: string;
  acquire(request: DeviceRequest): Promise<DeviceLease>;
  release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void>;
}

/** True for an object in `device`: a string or list of strings is a local pool, anything else is meant as a provider. */
export function isProviderShaped(device: unknown): boolean {
  return typeof device === 'object' && device !== null && !Array.isArray(device);
}

/** Narrows an intended provider, or names what it is missing. */
export function asDeviceProvider(device: unknown): DeviceProvider {
  const candidate = device as Partial<Record<keyof DeviceProvider, unknown>>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'agentDevice: a `device` provider needs a non-empty `name`');
  }
  for (const member of ['acquire', 'release'] as const) {
    if (typeof candidate[member] !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `agentDevice: device provider "${candidate.name}" must implement ${member}()`);
    }
  }
  return device as DeviceProvider;
}

/** A lease as a provider returned it, checked field by field: the engine trusts nothing it did not write. */
export function isDeviceLease(value: unknown): value is DeviceLease {
  if (typeof value !== 'object' || value === null) return false;
  const { id, daemon, device, installedApp } = value as Record<keyof DeviceLease, unknown>;
  return (
    typeof id === 'string' &&
    isDaemon(daemon) &&
    (device === undefined || typeof device === 'string') &&
    (installedApp === undefined || typeof installedApp === 'string')
  );
}
