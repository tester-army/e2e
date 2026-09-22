/**
 * The devices one target drives: one simulator or emulator per worker slot,
 * each under its own agent-device session. A named `device` is a pool of one
 * and a list a pool of many; with no `device` the pool is every booted device
 * of the platform, discovered in `prepare`; a `DeviceProvider` leases one
 * hosted device per slot instead. Each is a `DeviceSource`; `prepare` binds
 * one `SlotBinding` per slot from it, warms each once per run before any
 * worker exists, and hands the bindings to the workers through the run's
 * environment. The worker that owns a slot then resumes its session in
 * `init`, and `finish` releases what the source acquired.
 */

import { ConfigurationError, EngineError, obj, type EngineFinishInfo, type EnginePrepareInfo, type EnginePrepareResult } from 'e2e/engine';
import { bindingsVariable, decodeBindings, encodeBindings, pinnedApp, type DeviceSource, type SlotBinding } from './bindings.ts';
import { isRunnerFailure, message, runCommand } from './errors.ts';
import type { MobileOptions, MobilePlatform, ClientFactory } from './options.ts';
import { asDeviceProvider, LeasedDevices } from './provider.ts';

/** An Apple simulator UDID; anything else names a device. */
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * The device selection agent-device commands take: the platform, and the
 * device when one is named, as `udid` for a simulator UDID and `device` for a
 * name, the two fields agent-device resolves them by.
 */
export function deviceSelection(
  platform: MobilePlatform,
  device: string | undefined,
): { platform: MobilePlatform; device?: string; udid?: string } {
  if (device !== undefined && UDID.test(device)) return { platform, udid: device };
  return obj({ platform, device });
}

/** The agent-device session slot `slot` of a target drives: the `session` option or `e2e-<target>`, then `-<slot>`. */
type SessionNamer = (targetName: string, slot: number) => string;

function isDeviceList(device: unknown): device is readonly string[] {
  return Array.isArray(device);
}

/** The source the `device` option names: a configured pool, the booted devices, or a provider's leases. */
function sourceFor(options: MobileOptions, createClient: ClientFactory, session: SessionNamer): DeviceSource {
  const { device } = options;
  if (device === undefined) return new BootedDevices(options.platform, createClient, session);
  if (typeof device === 'string') return new ConfiguredDevices([device]);
  if (isDeviceList(device)) {
    if (device.length === 0) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'mobile: `device` is an empty pool; name at least one simulator or emulator, or omit it to use every booted one',
      );
    }
    return new ConfiguredDevices(device);
  }
  return new LeasedDevices(asDeviceProvider(device), options);
}

/** The devices named in the config, bound in order, as many as the run has slots. */
class ConfiguredDevices implements DeviceSource {
  readonly size: number;
  readonly fallback: readonly SlotBinding[];

  constructor(devices: readonly string[]) {
    this.size = devices.length;
    this.fallback = devices.map((device) => ({ device }));
  }

  async bind(info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    return this.fallback.slice(0, Math.min(info.slots, this.size));
  }
}

/** Every booted device of the platform, as many as the run has slots; with none booted, one slot the daemon fills. */
class BootedDevices implements DeviceSource {
  constructor(
    private readonly platform: MobilePlatform,
    private readonly createClient: ClientFactory,
    private readonly session: SessionNamer,
  ) {}

  async bind(info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const booted = await this.inventory(info.targetName, info.signal);
    const chosen = booted.slice(0, info.slots);
    if (chosen.length === 0) {
      info.log(`no booted ${this.platform} device; agent-device boots one`);
      return [{}];
    }
    info.log(`${booted.length} booted ${this.platform} device(s); driving ${chosen.length}: ${chosen.map((device) => device.name).join(', ')}`);
    return chosen.map((device) => ({ device: device.id }));
  }

  /** Every booted device of the platform, by stable id and name, in agent-device's inventory order. */
  private async inventory(targetName: string, signal: AbortSignal): Promise<{ id: string; name: string }[]> {
    const client = this.createClient(this.session(targetName, 0));
    const inventory: unknown = await runCommand('devices', () => client.devices.list({ platform: this.platform }), signal);
    if (!Array.isArray(inventory)) return [];
    return inventory
      .filter(
        (device): device is { id: string; name?: string } =>
          typeof device === 'object' &&
          device !== null &&
          (device as { booted?: unknown }).booted === true &&
          (device as { platform?: unknown }).platform === this.platform &&
          typeof (device as { id?: unknown }).id === 'string',
      )
      .map((device) => ({ id: device.id, name: typeof device.name === 'string' ? device.name : device.id }));
  }
}

export class DevicePool {
  private readonly source: DeviceSource;
  /** What this process's `prepare` bound, per target: a handle may serve several targets and runs. */
  private readonly bound = new Map<string, readonly SlotBinding[]>();

  constructor(
    private readonly options: MobileOptions,
    private readonly createClient: ClientFactory,
  ) {
    this.source = sourceFor(options, createClient, (targetName, slot) => this.session(targetName, slot));
  }

  /**
   * Workers the engine serves per target, one per device: known up front for
   * a configured pool, and `undefined` for a discovered or leased one until
   * `prepare` reports it, which lets the run plan with its own cap meanwhile.
   */
  get size(): number | undefined {
    return this.source.size;
  }

  /** The agent-device session a worker slot drives its device under: the `session` option or `e2e-<target>`, then `-<slot>`. */
  session(targetName: string, slot: number): string {
    return `${this.options.session ?? `e2e-${targetName}`}-${slot}`;
  }

  /**
   * What a worker slot drives, for a worker's `init`: what this process's
   * `prepare` bound for the target (an in-process run), else what `prepare`
   * left in the environment (a child worker), else the source's fallback
   * for a run without `prepare`. With none, the choice stays with the local
   * daemon, which picks a booted device. A slot beyond the pool is a broken
   * invariant: the runner caps the target at the workers this engine
   * declared or reported.
   */
  binding(targetName: string, slot: number, env: Readonly<Record<string, string | undefined>>): SlotBinding | undefined {
    const bindings = this.bound.get(targetName) ?? decodeBindings(env[bindingsVariable(targetName)]) ?? this.source.fallback;
    if (bindings === undefined) return undefined;
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
   * once per run and outside every launch budget, so `init` finds a booted
   * device. The bindings are reported back as the target's worker cap and
   * left in the environment for the workers. A target nothing runs on binds
   * nothing: a hosted session is billed from the moment it starts.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (info.slots === 0) return {};
    const bindings = await this.source.bind(info);
    this.bound.set(info.targetName, bindings);
    await this.warm(bindings, info);
    return { workers: bindings.length, env: { [bindingsVariable(info.targetName)]: encodeBindings(bindings) } };
  }

  /** Releases what the source acquired for the target; a local pool has nothing to release. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.source.finish?.(info);
  }

  /**
   * Boots every bound device and opens the pinned app on it once, so its
   * automation runner is up. One slot after another, on purpose: workers
   * booting at once in `init` contend for the host and the daemon, and one
   * cold boot pushes the others past `launchTimeout`. Each slot warms under
   * the session its worker resumes. A device that cannot boot ends the run
   * here; an app that does not open is logged and left to the first attempt.
   * An automation runner that is busy or wedged from an earlier run ends it
   * here too: the first attempt could only meet the same runner and fail
   * its first observation with the app blamed, and the message names the
   * recovery, which a wait of up to the runner's recycle window would only
   * hide. A build `appPath` installs in `init` is not on the device yet, so
   * that slot boots only, unless a lease says the build is already there.
   */
  private async warm(bindings: readonly SlotBinding[], info: EnginePrepareInfo): Promise<void> {
    for (const [slot, binding] of bindings.entries()) {
      const label = binding.device ?? `a booted ${this.options.platform} device`;
      const where = deviceSelection(this.options.platform, binding.device);
      const session = this.session(info.targetName, slot);
      const at = `session ${session} on ${label}`;
      const client = this.createClient(session, binding);
      info.log(`booting ${label} (${slot + 1} of ${bindings.length})`);
      await runCommand('boot', () => client.devices.boot(where), info.signal, at);
      const app = pinnedApp(this.options, binding.installedApp);
      if (app === undefined) continue;
      try {
        await runCommand(`open ${app}`, () => client.apps.open({ app, ...where }), info.signal, at);
      } catch (cause) {
        if (info.signal.aborted || isRunnerFailure(cause)) throw cause;
        info.log(`${label}: automation runner not warmed up (${message(cause)}); the first attempt starts it`);
      }
    }
  }
}
