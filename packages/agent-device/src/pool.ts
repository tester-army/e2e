/**
 * The devices one target drives: one simulator or emulator per worker slot,
 * each under its own agent-device session. A named `device` is a pool of one
 * and a list a pool of many; with no `device` the pool is every booted device
 * of the platform, discovered in `prepare`, so several booted simulators run
 * the target's files at once instead of leaving agent-device to guess between
 * them. The pool boots once per run in `prepare`, before any worker exists,
 * and hands the discovered devices to the workers through the run's
 * environment; the worker that owns a slot then resumes its session in `init`.
 */

import { createHash } from 'node:crypto';
import { ConfigurationError, EngineError, obj, type EnginePrepareInfo, type EnginePrepareResult } from 'e2e/engine';
import { message, runCommand } from './errors.ts';
import type { AgentDeviceOptions, AgentDevicePlatform, ClientFactory } from './options.ts';

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

/**
 * The environment variable a discovered pool travels to the workers in, one
 * per target: the name made environment-safe for reading, plus a digest of
 * the exact name so `ios-a` and `ios.a` never share a key.
 */
function poolVariable(targetName: string): string {
  const readable = targetName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const digest = createHash('sha256').update(targetName).digest('hex').slice(0, 8).toUpperCase();
  return `E2E_AGENT_DEVICE_POOL_${readable}_${digest}`;
}

/** The configured pool, or `undefined` when the devices are discovered at run time. */
function configured(device: AgentDeviceOptions['device']): readonly string[] | undefined {
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

export class DevicePool {
  /** The devices named in the config, or `undefined` when they are discovered per run and target. */
  private readonly configured: readonly string[] | undefined;
  /** What `prepare` discovered in this process, per target: a handle may serve several targets and runs. */
  private readonly discovered = new Map<string, readonly string[]>();

  constructor(
    private readonly options: AgentDeviceOptions,
    private readonly createClient: ClientFactory,
  ) {
    this.configured = configured(options.device);
  }

  /**
   * Workers the engine serves per target, one per device: known up front for
   * a configured pool, and `undefined` for a discovered one until `prepare`
   * reports it, which lets the run plan with its own cap meanwhile.
   */
  get size(): number | undefined {
    return this.configured?.length;
  }

  /** The agent-device session a worker slot drives its device under: the `session` option or `e2e-<target>`, then `-<slot>`. */
  session(targetName: string, slot: number): string {
    return `${this.options.session ?? `e2e-${targetName}`}-${slot}`;
  }

  /**
   * The device of a worker slot, for a worker's `init`. A configured pool
   * answers directly; a discovered one is what this process's `prepare`
   * found for the target (an in-process run), else what `prepare` left in
   * the environment (a child worker). With neither (a run without
   * `prepare`), the choice stays with agent-device, which picks a booted
   * device. A slot beyond the pool is a broken invariant: the runner caps the
   * target at the workers this engine declared or reported.
   */
  device(targetName: string, slot: number, env: Readonly<Record<string, string | undefined>>): string | undefined {
    const devices = this.configured ?? this.discovered.get(targetName) ?? this.fromEnvironment(env, targetName);
    if (devices === undefined || devices.length === 0) return undefined;
    if (slot >= devices.length) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `worker slot ${slot} is outside a device pool of ${devices.length}; the runner must cap the target at the engine's declared workers`,
        { retryable: false },
      );
    }
    return devices[slot];
  }

  /**
   * Boots the device of every worker slot the run will use and opens the
   * pinned app on it once, so its automation runner is up, once per run and
   * outside every launch budget. One slot after another, on purpose: workers
   * booting at once in `init` contend for the host and the daemon, and one
   * cold boot pushes the others past `launchTimeout`. Each slot warms under
   * the session its worker resumes, so `init` finds a booted device and the
   * first attempt an attached runner. A device that cannot boot ends the run
   * here; an app that does not open is logged and left to the first attempt.
   * A build `appPath` installs in `init` is not on the device yet, so that
   * case boots only. A discovered pool is the booted devices of the platform,
   * as many as the run has slots, reported back as the target's worker cap
   * and left in the environment for the workers; with none booted, one slot
   * boots whatever agent-device picks.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    const devices = this.configured ?? (await this.discoverForRun(info));
    const slots = Math.min(info.slots, Math.max(1, devices.length));
    const app = this.options.appPath === undefined ? this.options.app : undefined;
    for (let slot = 0; slot < slots; slot += 1) {
      const device = devices[slot];
      const label = device ?? `a booted ${this.options.platform} device`;
      const where = deviceSelection(this.options.platform, device);
      const client = this.createClient(this.session(info.targetName, slot));
      info.log(`booting ${label} (${slot + 1} of ${slots})`);
      await runCommand('boot', () => client.devices.boot(where), info.signal);
      if (app === undefined) continue;
      try {
        await runCommand(`open ${app}`, () => client.apps.open({ app, ...where }), info.signal);
      } catch (cause) {
        if (info.signal.aborted) throw cause;
        info.log(`${label}: automation runner not warmed up (${message(cause)}); the first attempt starts it`);
      }
    }
    return {
      workers: Math.max(1, Math.min(slots, devices.length)),
      env: { [poolVariable(info.targetName)]: JSON.stringify(devices) },
    };
  }

  /** Discovers the pool for a run: the booted devices, as many as the run has slots; `prepare` hands them to the workers through its result's `env`. */
  private async discoverForRun(info: EnginePrepareInfo): Promise<readonly string[]> {
    const booted = await this.bootedDevices(info.targetName, info.signal);
    const chosen = booted.slice(0, Math.max(1, info.slots));
    const devices = chosen.map((device) => device.id);
    if (devices.length === 0) {
      info.log(`no booted ${this.options.platform} device; agent-device boots one`);
    } else {
      const names = chosen.map((device) => device.name).join(', ');
      info.log(`${booted.length} booted ${this.options.platform} device(s); driving ${devices.length}: ${names}`);
    }
    this.discovered.set(info.targetName, devices);
    return devices;
  }

  /** The pool `prepare` left for this target in the environment, if any. */
  private fromEnvironment(env: Readonly<Record<string, string | undefined>>, targetName: string): readonly string[] | undefined {
    const raw = env[poolVariable(targetName)];
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed as string[];
    } catch {
      // Not ours to read; discover instead.
    }
    return undefined;
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
