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

import {
  ConfigurationError,
  EngineError,
  obj,
  withinCleanupBudget,
  type EngineFinishInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
} from 'e2e/engine';
import { bindingsVariable, decodeBindings, deviceLabel, encodeBindings, pinnedApp, type DeviceSource, type SlotBinding } from './bindings.ts';
import { isRunnerFailure, message, runCommand } from './errors.ts';
import type { AgentDeviceClient, MobileOptions, MobilePlatform, ClientFactory } from './options.ts';
import { asDeviceProvider, LeasedDevices, type RecordingDeviceProvider } from './provider.ts';

/** An Apple simulator UDID. */
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
/** An Android emulator's adb serial. */
const EMULATOR_SERIAL = /^emulator-\d+$/;

/** The fields agent-device commands select a device by: the platform, then one of a name, a simulator UDID, or an Android serial. */
export interface DeviceSelection {
  readonly platform: MobilePlatform;
  readonly device?: string;
  readonly udid?: string;
  readonly serial?: string;
}

/**
 * The selection agent-device commands take for a binding: an id the pool
 * discovered goes under the platform's id field (`udid` for a simulator,
 * `serial` for an Android device), a configured string too when it reads as
 * a UDID or an emulator serial, and any other string is a device name.
 */
export function deviceSelection(
  platform: MobilePlatform,
  binding: Pick<SlotBinding, 'device' | 'deviceId'> | undefined,
): DeviceSelection {
  const { device, deviceId } = binding ?? {};
  const id = deviceId ?? (device !== undefined && (UDID.test(device) || EMULATOR_SERIAL.test(device)) ? device : undefined);
  if (id === undefined) return obj({ platform, device });
  return platform === 'android' ? { platform, serial: id } : { platform, udid: id };
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
    return chosen.map((device) => ({ deviceId: device.id }));
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
  /** The clients `warm` opened sessions with, per target, held for `finish` to close whatever `warm` got to. */
  private readonly warmed = new Map<string, AgentDeviceClient[]>();

  constructor(
    private readonly options: MobileOptions,
    private readonly createClient: ClientFactory,
  ) {
    this.source = sourceFor(options, createClient, (targetName, slot) => this.session(targetName, slot));
  }

  /**
   * The device provider when its service records the devices it leases,
   * in every process: the pool is built from the options in the runner and
   * in each worker alike. `undefined` for a local pool, or a provider
   * without `record`.
   */
  get recorder(): RecordingDeviceProvider | undefined {
    return this.source instanceof LeasedDevices ? this.source.recorder : undefined;
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
   * device. The bindings, each naming the app its session is on, are
   * reported back as the target's worker cap and left in the environment
   * for the workers. A target nothing runs on binds
   * nothing: a hosted session is billed from the moment it starts.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (info.slots === 0) return {};
    const bindings = await this.warm(await this.source.bind(info), info);
    this.bound.set(info.targetName, bindings);
    return { workers: bindings.length, env: { [bindingsVariable(info.targetName)]: encodeBindings(bindings) } };
  }

  /**
   * Closes every session `warm` opened for the target and releases what the
   * source acquired. A worker closes its own session in `dispose`, but a run
   * that failed in `prepare` never had one, and an agent-device session
   * outlives the process: left open, the next run resumes it by name with
   * the runner state that failed this one. The closes are best-effort under
   * the hook's budget and run beside the release, so a close that hangs or
   * fails never keeps a leased device billed; a local pool has nothing to
   * release.
   */
  async finish(info: EngineFinishInfo): Promise<void> {
    const clients = this.warmed.get(info.targetName) ?? [];
    this.warmed.delete(info.targetName);
    const closing = withinCleanupBudget(
      Promise.allSettled(clients.map((client) => client.sessions.close())),
      info,
    );
    await Promise.all([closing, this.source.finish?.(info)]);
  }

  /**
   * Boots every bound device, starts the iOS automation runner on it, and
   * opens the pinned app on it once, so the slot's session is on the app,
   * which the returned binding records for the worker: a permission it
   * presets there needs no open first. A plain foreground open, with none of the engine's
   * launch options: an app still running from an earlier run keeps its
   * process either way, and a test's `app.open()` relaunches it with them.
   * One slot after another, on purpose: workers
   * booting at once in `init` contend for the host and the daemon, and one
   * cold boot pushes the others past `launchTimeout`. Each slot warms under
   * the session its worker resumes. A device that cannot boot ends the run
   * here; an app that does not open is logged and left to the first attempt.
   * An automation runner that is busy or wedged from an earlier run ends it
   * here too: the first attempt could only meet the same runner and fail
   * its first observation with the app blamed, and the message names the
   * recovery, which a wait of up to the runner's recycle window would only
   * hide. A runner that did not start leaves the slot unopened: the open
   * would start it again under a shorter budget, and its timeout resets the
   * daemon every earlier slot is on. A build `appPath` installs in `init` is
   * not on the device yet, so that slot boots and starts the runner only,
   * unless a lease says the build is already there.
   */
  private async warm(bindings: readonly SlotBinding[], info: EnginePrepareInfo): Promise<readonly SlotBinding[]> {
    const warmed: SlotBinding[] = [];
    for (const [slot, binding] of bindings.entries()) {
      const label = deviceLabel(binding) ?? `a booted ${this.options.platform} device`;
      const where = deviceSelection(this.options.platform, binding);
      const session = this.session(info.targetName, slot);
      const at = `session ${session} on ${label}`;
      const client = this.createClient(session, binding);
      this.retain(info.targetName, client);
      info.log(`booting ${label} (${slot + 1} of ${bindings.length})`);
      await runCommand('boot', () => client.devices.boot(where), info.signal, at);
      const runnerUp = this.options.platform !== 'ios' || (await prepareRunner(client, where, info, at));
      const app = pinnedApp(info.app, binding.installedApp);
      if (app === undefined || !runnerUp) {
        warmed.push(binding);
        continue;
      }
      // A build the suite installs itself is not on the device yet, so there
      // is nothing to open: the first attempt installs it.
      if (info.app.appPath !== undefined && binding.installedApp === undefined) {
        info.log(`${label}: ${app} awaits the suite's device.installApp()`);
        warmed.push(binding);
        continue;
      }
      try {
        await runCommand(`open ${app}`, () => client.apps.open({ app, ...where }), info.signal, at);
        warmed.push({ ...binding, sessionApp: app });
      } catch (cause) {
        if (info.signal.aborted || isRunnerFailure(cause)) throw cause;
        info.log(`${label}: ${app} did not open (${message(cause)}); the first attempt opens it`);
        warmed.push(binding);
      }
    }
    return warmed;
  }

  /** Holds a warm-up client for `finish`, before its first command: a boot that fails still opened the session. */
  private retain(targetName: string, client: AgentDeviceClient): void {
    const clients = this.warmed.get(targetName) ?? [];
    clients.push(client);
    this.warmed.set(targetName, clients);
  }
}

/**
 * Starts the slot's iOS automation runner under `prepare ios-runner`, whose
 * startup budget covers a cold simulator. Left to the first `open`, the
 * start runs inside that request's 90 s envelope, which a cold runner on a
 * loaded CI Mac outlasts; a timed-out `open` resets the daemon, ending every
 * other slot's session with it. A runner that is busy or wedged ends the run
 * here, like a warm-up open that meets one; any other failure is logged and
 * left to the first attempt. True when the runner is up.
 */
async function prepareRunner(client: AgentDeviceClient, where: DeviceSelection, info: EnginePrepareInfo, at: string): Promise<boolean> {
  try {
    await runCommand('prepare ios-runner', () => client.command.prepare({ action: 'ios-runner', ...where }), info.signal, at);
    return true;
  } catch (cause) {
    if (info.signal.aborted || isRunnerFailure(cause)) throw cause;
    info.log(`${at}: automation runner not prepared (${message(cause)}); the first attempt starts it`);
    return false;
  }
}
