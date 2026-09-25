/**
 * The seam a hosted device service plugs into: a `DeviceProvider` leases one
 * device per worker slot for the run and hands back the agent-device daemon
 * that drives it. The engine acquires in `prepare`, drives each lease from
 * its worker, and releases in `finish`, on every exit path. Nothing here
 * knows any vendor: a hosted simulator service, a device farm, or a daemon on
 * a machine down the hall are each one small provider in user code.
 */

import path from 'node:path';
import { ConfigurationError, EngineError, obj, type EngineFinishInfo, type EnginePrepareInfo } from 'e2e/engine';
import { isSlotBinding, type DeviceClientConfig, type DeviceDaemon, type DeviceSource, type SlotBinding } from './bindings.ts';
import { message } from './errors.ts';
import { isLink } from './links.ts';
import type { MobileOptions, MobilePlatform } from './options.ts';

/** What the engine asks a provider for: one device for one worker slot of a run. */
export interface DeviceRequest {
  /** Platform the target's device must run. */
  readonly platform: MobilePlatform;
  /** The run id, for naming the session at the provider. */
  readonly runId: string;
  /** The target the device serves. */
  readonly targetName: string;
  /** Worker slot the device serves, `0` to `slots - 1`; `slots` leases are acquired at once. */
  readonly slot: number;
  /** Devices the run acquires for this target, in all. */
  readonly slots: number;
  /** The `app` option: the bundle id or package `app.open()` launches, when the config names one. */
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
export interface DeviceLease extends SlotBinding {
  /**
   * The provider's handle on the lease (a session id); named in progress
   * lines and handed back to `release`. A provider may keep further fields on
   * the object it returns: `release` gets that same object, while only the
   * fields declared here travel to the worker.
   */
  readonly id: string;
  /**
   * The agent-device daemon the worker connects to instead of its local one.
   * A lease names a daemon, `client` configuration, or both.
   */
  readonly daemon?: DeviceDaemon | undefined;
  /**
   * agent-device client configuration the worker's client is created with:
   * how a daemon that runs agent-device's own device-cloud runtimes tells the
   * leased device apart, as its `leases.allocate` returned it (`tenant`,
   * `runId`, `leaseId`, `leaseBackend`, `leaseProvider`), or the `stateDir` of
   * a daemon the provider started. JSON data only; `session`, `daemonBaseUrl`,
   * and `daemonAuthToken` are refused, the engine and `daemon` own those.
   */
  readonly client?: DeviceClientConfig | undefined;
  /** Device to select inside that daemon by name, when it hosts more than one. */
  readonly device?: string | undefined;
  /** Device to select inside that daemon by the id agent-device lists it under: a simulator UDID or an Android serial. */
  readonly deviceId?: string | undefined;
  /**
   * Bundle id or package of the app the provider installed from the
   * request's `appPath`, and only then: with it the engine installs nothing
   * and, without an `app` option, `app.open()` launches this app. A lease
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

/** Narrows an intended provider, or names what it is missing. */
export function asDeviceProvider(device: object): DeviceProvider {
  const candidate = device as Partial<Record<keyof DeviceProvider, unknown>>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'mobile: a `device` provider needs a non-empty `name`');
  }
  for (const member of ['acquire', 'release'] as const) {
    if (typeof candidate[member] !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `mobile: device provider "${candidate.name}" must implement ${member}()`);
    }
  }
  return device as DeviceProvider;
}

/** An object with a lease id: something the provider granted and `release` is owed, whatever the field check makes of it. */
function isGrantedLease(value: unknown): value is Pick<DeviceLease, 'id'> {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

/** A granted lease checked field by field: the engine trusts nothing it did not write. */
function isDeviceLease(lease: Pick<DeviceLease, 'id'>): lease is DeviceLease {
  return isSlotBinding(lease) && (lease.daemon !== undefined || lease.client !== undefined);
}

const REJECTED_LEASE = 'returned a lease without an id and a daemon baseUrl or JSON client configuration (no `session` or daemon keys)';

/** Runs every task, then reports the first failure: nothing is skipped because a sibling failed. */
async function allOrFirstFailure<T>(tasks: readonly (() => Promise<T>)[], describe: string): Promise<T[]> {
  // `async` so a task that throws before its first await is a rejection like any other, not an escape.
  const settled = await Promise.allSettled(tasks.map(async (task) => task()));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    throw new EngineError('ENGINE_FAILURE', `${describe}: ${message(failed.reason)}`, { retryable: false, cause: failed.reason });
  }
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/**
 * Devices a provider leases, one per slot, all at once: hosted sessions start
 * in parallel and are billed from the moment they do, so nothing waits on a
 * sibling. Every lease granted is held for `finish` before the outcome is
 * known, so a slot that fails to lease fails the run and the others are
 * still released, each one whatever happened to the rest.
 */
export class LeasedDevices implements DeviceSource {
  /** Leases granted so far, per target, filled as each `acquire` settles; a lease the engine then rejects is among them. */
  private readonly held = new Map<string, DeviceLease[]>();

  constructor(
    private readonly provider: DeviceProvider,
    private readonly options: Pick<MobileOptions, 'platform' | 'app' | 'appPath'>,
  ) {}

  async bind(info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const { provider } = this;
    const { platform, app } = this.options;
    const appPath = this.options.appPath === undefined ? undefined : path.resolve(info.projectRoot, this.options.appPath);
    const held: DeviceLease[] = [];
    this.held.set(info.targetName, held);
    info.log(`leasing ${info.slots} ${platform} device(s) from ${provider.name}`);
    const leases = await allOrFirstFailure(
      Array.from({ length: info.slots }, (_, slot) => async () => {
        const lease: unknown = await provider.acquire({
          platform,
          runId: info.runId,
          targetName: info.targetName,
          slot,
          slots: info.slots,
          app,
          appPath,
          env: info.env,
          signal: info.signal,
          log: (line) => info.log(`${provider.name} (${slot + 1} of ${info.slots}): ${line}`),
        });
        if (!isGrantedLease(lease)) throw new Error(REJECTED_LEASE);
        // Held before it is checked: the provider bills for what it granted,
        // and `release` is owed this same object however the check goes.
        held.push(lease);
        if (!isDeviceLease(lease)) throw new Error(REJECTED_LEASE);
        if (lease.installedApp !== undefined && appPath === undefined) {
          throw new Error('reported an installed app for a request without `appPath`');
        }
        // The pool opens this on the device in `prepare`; agent-device would open a link as a URL.
        if (lease.installedApp !== undefined && isLink(lease.installedApp)) {
          throw new Error('reported an installed app that is a link, not a bundle id or package');
        }
        info.log(`${provider.name}: leased ${lease.id}${lease.device === undefined ? '' : ` (${lease.device})`}`);
        return lease;
      }),
      `device provider "${provider.name}" could not lease a device`,
    );
    return leases.map((lease) => obj({ device: lease.device, deviceId: lease.deviceId, daemon: lease.daemon, client: lease.client, installedApp: lease.installedApp }));
  }

  async finish(info: EngineFinishInfo): Promise<void> {
    const { provider } = this;
    const leases = this.held.get(info.targetName);
    this.held.delete(info.targetName);
    if (leases === undefined || leases.length === 0) return;
    const context = { runId: info.runId, targetName: info.targetName, env: info.env, signal: info.signal, log: (line: string) => info.log(`${provider.name}: ${line}`) };
    await allOrFirstFailure(
      leases.map((lease) => () => provider.release(lease, context)),
      `device provider "${provider.name}" could not release a device`,
    );
    info.log(`${provider.name}: released ${leases.length} device(s)`);
  }
}
