/**
 * The devices one target drives: one simulator or emulator per worker slot,
 * each under its own agent-device session. A named `device` is a pool of one
 * and a list a pool of many; with no `device` the pool is every booted device
 * of the platform, discovered in `prepare`; a `DeviceProvider` leases one
 * hosted device per slot instead. Whatever the source, `prepare` ends with
 * one `SlotBinding` per slot, warmed once per run before any worker exists
 * and handed to the workers through the run's environment; the worker that
 * owns a slot then resumes its session in `init`, and `finish` releases what
 * a provider leased.
 */

import { ConfigurationError, EngineError, obj, type EngineFinishInfo, type EnginePrepareInfo, type EnginePrepareResult } from 'e2e/engine';
import { bindingsVariable, decodeBindings, encodeBindings, type SlotBinding } from './bindings.ts';
import { message, runCommand } from './errors.ts';
import type { AgentDeviceOptions, AgentDevicePlatform, ClientFactory } from './options.ts';
import { asDeviceProvider, isDeviceLease, isProviderShaped, type DeviceLease, type DeviceProvider } from './provider.ts';
import { resolveBuild } from './support.ts';

/** An Apple simulator UDID; anything else names a device. */
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * The device selection agent-device commands take: the platform, and the
 * device when one is named, as `udid` for a simulator UDID and `device` for a
 * name, the two fields agent-device resolves them by.
 */
export function deviceSelection(
  platform: AgentDevicePlatform,
  device: string | undefined,
): { platform: AgentDevicePlatform; device?: string; udid?: string } {
  if (device !== undefined && UDID.test(device)) return { platform, udid: device };
  return obj({ platform, device });
}

/** The configured pool, or `undefined` when the devices are discovered at run time. */
function configured(device: string | readonly string[] | undefined): readonly string[] | undefined {
  if (device === undefined) return undefined;
  if (typeof device === 'string') return [device];
  if (device.length === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agentDevice: `device` is an empty pool; name at least one simulator or emulator, or omit it to use every booted one',
    );
  }
  return device;
}

/** Runs every task, then reports the first failure: nothing is skipped because a sibling failed. */
async function allOrFirstFailure<T>(tasks: readonly (() => Promise<T>)[], describe: (cause: unknown) => string): Promise<T[]> {
  // `async` so a task that throws before its first await is a rejection like any other, not an escape.
  const settled = await Promise.allSettled(tasks.map(async (task) => task()));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    throw new EngineError('ENGINE_FAILURE', `${describe(failed.reason)}: ${message(failed.reason)}`, { retryable: false, cause: failed.reason });
  }
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

export class DevicePool {
  /** The devices named in the config, or `undefined` when they are discovered per run or leased. */
  private readonly configured: readonly string[] | undefined;
  /** The hosted-device provider, when `device` is one. */
  private readonly provider: DeviceProvider | undefined;
  /** What this process's `prepare` bound, per target: a handle may serve several targets and runs. */
  private readonly bound = new Map<string, readonly SlotBinding[]>();
  /** Leases granted so far, per target, held until `finish` releases them; filled as each `acquire` settles, so a slot that failed to lease never strands a sibling. */
  private readonly held = new Map<string, DeviceLease[]>();

  constructor(
    private readonly options: AgentDeviceOptions,
    private readonly createClient: ClientFactory,
  ) {
    const { device } = options;
    this.provider = isProviderShaped(device) ? asDeviceProvider(device) : undefined;
    this.configured = this.provider === undefined ? configured(device as string | readonly string[] | undefined) : undefined;
  }

  /**
   * Workers the engine serves per target, one per device: known up front for
   * a configured pool, and `undefined` for a discovered or leased one until
   * `prepare` reports it, which lets the run plan with its own cap meanwhile.
   */
  get size(): number | undefined {
    return this.configured?.length;
  }

  /** The agent-device session a worker slot drives its device under: the `session` option or `e2e-<target>`, then `-<slot>`. */
  session(targetName: string, slot: number): string {
    return `${this.options.session ?? `e2e-${targetName}`}-${slot}`;
  }

  /**
   * What a worker slot drives, for a worker's `init`: what this process's
   * `prepare` bound for the target (an in-process run), else what `prepare`
   * left in the environment (a child worker), else the configured pool. With
   * none (a run without `prepare`), the choice stays with the local daemon,
   * which picks a booted device. A slot beyond the pool is a broken
   * invariant: the runner caps the target at the workers this engine
   * declared or reported.
   */
  binding(targetName: string, slot: number, env: Readonly<Record<string, string | undefined>>): SlotBinding | undefined {
    const bindings =
      this.bound.get(targetName) ?? decodeBindings(env[bindingsVariable(targetName)]) ?? this.configured?.map((device) => ({ device }));
    if (bindings === undefined || bindings.length === 0) return undefined;
    const binding = bindings[slot];
    if (binding === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `worker slot ${slot} is outside a device pool of ${bindings.length}; the runner must cap the target at the engine's declared workers`,
        { retryable: false },
      );
    }
    return binding;
  }

  /**
   * Binds a device to every worker slot the run will use and warms each,
   * once per run and outside every launch budget: boots it and opens the
   * pinned app on it, so its automation runner is up and `init` finds a
   * booted device. A configured pool binds its entries in order; a
   * discovered one the booted devices of the platform, as many as the run
   * has slots, with none booted one slot that lets agent-device pick; a
   * provider leases one device per slot. The bindings are reported back as
   * the target's worker cap and left in the environment for the workers. A
   * target nothing runs on binds nothing: a hosted session is billed from
   * the moment it starts.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (info.slots === 0) return {};
    const bindings = this.provider === undefined ? await this.bindLocal(info) : await this.lease(this.provider, info);
    this.bound.set(info.targetName, bindings);
    await this.warm(bindings, info);
    return { workers: bindings.length, env: { [bindingsVariable(info.targetName)]: encodeBindings(bindings) } };
  }

  /**
   * Releases every lease acquired for the target, each one whatever happened
   * to the others; the first failure is reported once all were tried. A pool
   * without a provider has nothing to release.
   */
  async finish(info: EngineFinishInfo): Promise<void> {
    const provider = this.provider;
    const leases = this.held.get(info.targetName);
    this.held.delete(info.targetName);
    if (provider === undefined || leases === undefined || leases.length === 0) return;
    const context = { runId: info.runId, targetName: info.targetName, env: info.env, signal: info.signal, log: (line: string) => info.log(`${provider.name}: ${line}`) };
    await allOrFirstFailure(
      leases.map((lease) => () => provider.release(lease, context)),
      () => `device provider "${provider.name}" could not release a device`,
    );
    info.log(`${provider.name}: released ${leases.length} device(s)`);
  }

  /** The configured devices, else the booted ones, as many as the run has slots; none booted binds one slot the daemon fills. */
  private async bindLocal(info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const devices = this.configured ?? (await this.discover(info));
    if (devices.length === 0) return [{}];
    return devices.slice(0, Math.min(info.slots, devices.length)).map((device) => ({ device }));
  }

  /** Every booted device of the platform, by stable id, as many as the run has slots. */
  private async discover(info: EnginePrepareInfo): Promise<readonly string[]> {
    const booted = await this.bootedDevices(info.targetName, info.signal);
    const chosen = booted.slice(0, info.slots);
    if (chosen.length === 0) {
      info.log(`no booted ${this.options.platform} device; agent-device boots one`);
    } else {
      info.log(`${booted.length} booted ${this.options.platform} device(s); driving ${chosen.length}: ${chosen.map((device) => device.name).join(', ')}`);
    }
    return chosen.map((device) => device.id);
  }

  /**
   * Leases one device per slot from the provider, all at once: hosted
   * sessions start in parallel and are billed from the moment they do, so
   * nothing waits on a sibling. Every lease granted is held for `finish`
   * before the outcome is known, so a slot that fails to lease fails the run
   * here and the others are still released.
   */
  private async lease(provider: DeviceProvider, info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const { platform, app } = this.options;
    const appPath = this.options.appPath === undefined ? undefined : resolveBuild(info.projectRoot, this.options.appPath);
    const held: DeviceLease[] = [];
    this.held.set(info.targetName, held);
    info.log(`leasing ${info.slots} ${platform} device(s) from ${provider.name}`);
    const leases = await allOrFirstFailure(
      Array.from({ length: info.slots }, (_, slot) => async () => {
        const lease = await provider.acquire({
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
        if (isDeviceLease(lease)) held.push(lease);
        return lease;
      }),
      () => `device provider "${provider.name}" could not lease a device`,
    );
    return leases.map((lease) => {
      if (!isDeviceLease(lease)) {
        throw new EngineError('ENGINE_FAILURE', `device provider "${provider.name}" returned a lease without an id and a daemon baseUrl`, { retryable: false });
      }
      if (lease.installedApp !== undefined && appPath === undefined) {
        throw new EngineError(
          'ENGINE_FAILURE',
          `device provider "${provider.name}" reported an installed app for a request without \`appPath\``,
          { retryable: false },
        );
      }
      info.log(`${provider.name}: leased ${lease.id}${lease.device === undefined ? '' : ` (${lease.device})`}`);
      return obj({ device: lease.device, daemon: lease.daemon, installedApp: lease.installedApp });
    });
  }

  /**
   * Boots every bound device and opens the pinned app on it once, so its
   * automation runner is up. One slot after another, on purpose: workers
   * booting at once in `init` contend for the host and the daemon, and one
   * cold boot pushes the others past `launchTimeout`. Each slot warms under
   * the session its worker resumes. A device that cannot boot ends the run
   * here; an app that does not open is logged and left to the first attempt.
   * A build `appPath` installs in `init` is not on the device yet, so that
   * slot boots only, unless a lease says the build is already there.
   */
  private async warm(bindings: readonly SlotBinding[], info: EnginePrepareInfo): Promise<void> {
    for (const [slot, binding] of bindings.entries()) {
      const label = binding.device ?? `a booted ${this.options.platform} device`;
      const where = deviceSelection(this.options.platform, binding.device);
      const client = this.createClient(this.session(info.targetName, slot), binding.daemon);
      info.log(`booting ${label} (${slot + 1} of ${bindings.length})`);
      await runCommand('boot', () => client.devices.boot(where), info.signal);
      const app = this.warmApp(binding);
      if (app === undefined) continue;
      try {
        await runCommand(`open ${app}`, () => client.apps.open({ app, ...where }), info.signal);
      } catch (cause) {
        if (info.signal.aborted) throw cause;
        info.log(`${label}: automation runner not warmed up (${message(cause)}); the first attempt starts it`);
      }
    }
  }

  /** The app to open on a bound device at warm-up: the pinned one, unless `init` still has to install it. */
  private warmApp(binding: SlotBinding): string | undefined {
    const installed = this.options.appPath === undefined || binding.installedApp !== undefined;
    return installed ? (this.options.app ?? binding.installedApp) : undefined;
  }

  /** Every booted device of the platform, by stable id and name, in agent-device's inventory order. */
  private async bootedDevices(targetName: string, signal: AbortSignal): Promise<{ id: string; name: string }[]> {
    const client = this.createClient(this.session(targetName, 0));
    const inventory: unknown = await runCommand('devices', () => client.devices.list({ platform: this.options.platform }), signal);
    if (!Array.isArray(inventory)) return [];
    return inventory
      .filter(
        (device): device is { id: string; name?: string } =>
          typeof device === 'object' &&
          device !== null &&
          (device as { booted?: unknown }).booted === true &&
          (device as { platform?: unknown }).platform === this.options.platform &&
          typeof (device as { id?: unknown }).id === 'string',
      )
      .map((device) => ({ id: device.id, name: typeof device.name === 'string' ? device.name : device.id }));
  }
}
