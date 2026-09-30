/**
 * The seam a hosted device service plugs into: a `DeviceProvider` leases one
 * device per worker slot for the run and hands back the agent-device daemon
 * that drives it. The engine acquires in `prepare`, drives each lease from
 * its worker, and releases in `finish`, on every exit path. A provider whose
 * service records its devices records an attempt's video in place of
 * agent-device, from the worker that drives the lease. Nothing here
 * knows any vendor: a hosted simulator service, a device farm, or a daemon on
 * a machine down the hall are each one small provider in user code.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ConfigurationError,
  EngineError,
  isProviderRecording,
  obj,
  type EngineFinishInfo,
  type EnginePrepareInfo,
  type ProviderRecordContext,
  type ProviderRecording,
} from 'e2e/engine';
import { isSlotBinding, type DeviceClientConfig, type DeviceDaemon, type DeviceSource, type SlotBinding } from './bindings.ts';
import { message } from './errors.ts';
import { isLink } from './links.ts';
import { cancelled } from './support.ts';
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
  /**
   * The agent-device version this engine's client speaks, for a provider
   * that picks the daemon version it starts: a daemon of another version may
   * answer the same commands differently.
   */
  readonly agentDeviceVersion: string;
  /** The target's `app.bundleId`: the bundle id or package `app.open()` launches, when the config names one. */
  readonly app?: string | undefined;
  /**
   * The build the engine would install (the target's `app.appPath`),
   * resolved to an absolute path, when the config names one. A provider that installs it itself (uploading it,
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
export interface DeviceLease extends Omit<SlotBinding, 'leaseId'> {
  /**
   * The provider's handle on the lease (a session id); named in progress
   * lines and handed back to `release`. A provider may keep further fields on
   * the object it returns: `release` gets that same object, while only the
   * fields declared here travel to the worker, and `record` gets those.
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
   * and, without an `app.bundleId`, `app.open()` launches this app. A lease
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
 * runner process, so a provider may keep state between them. `record` runs
 * in the worker that drives the lease, which may be another process, so it
 * must not rely on state `acquire` kept.
 */
export interface DeviceProvider {
  /** Label in progress lines and error messages. */
  readonly name: string;
  acquire(request: DeviceRequest): Promise<DeviceLease>;
  release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void>;
  /**
   * Records the leased device for an attempt that records video, in place of
   * the engine's agent-device screen recording: the service's own recording
   * of the device, called from the worker when the attempt starts its video.
   * A provider that cannot record its devices leaves it out, and the engine
   * records with agent-device. `lease` is the lease as it traveled to the
   * worker: its `id` and the other fields declared on `DeviceLease`, never
   * what else the provider kept on the object `acquire` returned.
   * `ProviderRecording` comes from `e2e/engine`: its `stop` writes a file
   * into the directory it is given, or names a recording the service keeps
   * by URL.
   */
  record?(lease: DeviceLease, context: ProviderRecordContext): Promise<ProviderRecording>;
}

/** A provider whose service records the devices it leases. */
export type RecordingDeviceProvider = DeviceProvider & Required<Pick<DeviceProvider, 'record'>>;

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
  if (candidate.record !== undefined && typeof candidate.record !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `mobile: device provider "${candidate.name}" has a record that is not a function`);
  }
  return device as DeviceProvider;
}

/**
 * The lease a worker's binding stands for, as it traveled from the runner:
 * its id and the fields `DeviceLease` declares, never anything else the
 * provider kept on the object `acquire` returned. `undefined` for a binding
 * no provider leased.
 */
export function travelledLease(binding: SlotBinding | undefined): DeviceLease | undefined {
  if (binding?.leaseId === undefined) return undefined;
  const { leaseId, device, deviceId, daemon, client, installedApp } = binding;
  return obj({ id: leaseId, device, deviceId, daemon, client, installedApp });
}

/**
 * Starts the provider's recording of a leased device for one attempt. A
 * failure is named after the provider and the lease, and one met once the
 * signal aborted is a cancellation. A recording without a `startedAt` and a
 * `stop()` is refused: the engine trusts nothing it did not write.
 */
export async function recordLease(provider: RecordingDeviceProvider, lease: DeviceLease, context: ProviderRecordContext): Promise<ProviderRecording> {
  const failure = (detail: string, cause?: unknown) =>
    new EngineError('ENGINE_FAILURE', `device provider "${provider.name}" ${detail} for lease ${lease.id}`, { retryable: false, ...(cause === undefined ? {} : { cause }) });
  if (context.signal.aborted) throw cancelled(`recording from device provider "${provider.name}" cancelled`);
  let recording: unknown;
  try {
    recording = await provider.record(lease, context);
  } catch (cause) {
    if (context.signal.aborted) throw cancelled(`recording from device provider "${provider.name}" cancelled`);
    throw failure(`could not start recording: ${message(cause)}`, cause);
  }
  if (!isProviderRecording(recording)) throw failure('returned a recording without a start time and a stop()');
  return recording;
}

/** The agent-device this package pins exactly, read from its manifest: the version every worker's client is. */
const AGENT_DEVICE_VERSION = (createRequire(import.meta.url)('../package.json') as { dependencies: Record<string, string> }).dependencies['agent-device']!;

/** An object with a lease id: something the provider granted and `release` is owed, whatever the field check makes of it. */
function isGrantedLease(value: unknown): value is Pick<DeviceLease, 'id'> {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

/** A granted lease checked field by field: the engine trusts nothing it did not write. */
function isDeviceLease(lease: Pick<DeviceLease, 'id'>): lease is DeviceLease {
  // `leaseId` is the engine's own field on a binding; a provider may keep a field of that name on its lease.
  const declared: unknown = { ...lease, leaseId: undefined };
  return isSlotBinding(declared) && (declared.daemon !== undefined || declared.client !== undefined);
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
  /** The provider when its service records the devices it leases; `undefined` leaves video to agent-device. */
  readonly recorder: RecordingDeviceProvider | undefined;

  constructor(
    private readonly provider: DeviceProvider,
    private readonly options: Pick<MobileOptions, 'platform'>,
  ) {
    this.recorder = provider.record === undefined ? undefined : (provider as RecordingDeviceProvider);
  }

  async bind(info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const { provider } = this;
    const { platform } = this.options;
    const app = info.app.bundleId;
    const appPath = info.app.appPath === undefined ? undefined : path.resolve(info.projectRoot, info.app.appPath);
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
          agentDeviceVersion: AGENT_DEVICE_VERSION,
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
    return leases.map((lease) =>
      obj({ leaseId: lease.id, device: lease.device, deviceId: lease.deviceId, daemon: lease.daemon, client: lease.client, installedApp: lease.installedApp }),
    );
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
