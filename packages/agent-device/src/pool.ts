/**
 * The devices one target drives: one simulator or emulator per worker slot,
 * each under its own agent-device session. A single or unnamed `device` is a
 * pool of one, so nothing downstream tells the cases apart. The pool boots
 * once per run in `prepare`, before any worker exists; the worker that owns a
 * slot then resumes its session in `init`.
 */

import { ConfigurationError, EngineError, obj, type EnginePrepareInfo } from '@e2edev/e2e/engine';
import { message, runCommand } from './errors.ts';
import type { AgentDeviceOptions, AgentDevicePlatform, ClientFactory } from './options.ts';

/** The device selection agent-device commands take: the platform, and the device when one is named. */
export function deviceSelection(
  platform: AgentDevicePlatform,
  device: string | undefined,
): { platform: AgentDevicePlatform; device?: string } {
  return obj({ platform, device });
}

/** One entry per worker slot; `undefined` leaves the choice to agent-device, which picks a booted device. */
function normalize(device: AgentDeviceOptions['device']): readonly (string | undefined)[] {
  if (device === undefined || typeof device === 'string') return [device];
  if (device.length === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agentDevice: `device` is an empty pool; name at least one simulator or emulator, or omit it to use a booted one',
    );
  }
  return device;
}

export class DevicePool {
  private readonly devices: readonly (string | undefined)[];

  constructor(
    private readonly options: AgentDeviceOptions,
    private readonly createClient: ClientFactory,
  ) {
    this.devices = normalize(options.device);
  }

  /** Workers the engine serves per target: one per device, since two workers on one simulator interleave taps. */
  get size(): number {
    return this.devices.length;
  }

  /**
   * The device of a worker slot. The scheduler caps the target at `size`, so
   * a slot beyond the pool is a broken invariant, not a configuration mistake.
   */
  device(slot: number): string | undefined {
    if (slot >= this.devices.length) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `worker slot ${slot} is outside a device pool of ${this.devices.length}; the runner must cap the target at the engine's declared workers`,
        { retryable: false },
      );
    }
    return this.devices[slot];
  }

  /** The agent-device session a worker slot drives its device under: the `session` option or `e2e-<target>`, then `-<slot>`. */
  session(targetName: string, slot: number): string {
    return `${this.options.session ?? `e2e-${targetName}`}-${slot}`;
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
   * case boots only.
   */
  async prepare(info: EnginePrepareInfo): Promise<void> {
    const app = this.options.appPath === undefined ? this.options.app : undefined;
    for (let slot = 0; slot < info.slots; slot += 1) {
      const device = this.device(slot);
      const label = device ?? `a booted ${this.options.platform} device`;
      const where = deviceSelection(this.options.platform, device);
      const client = this.createClient(this.session(info.targetName, slot));
      info.log(`booting ${label} (${slot + 1} of ${info.slots})`);
      await runCommand('boot', () => client.devices.boot(where), info.signal);
      if (app === undefined) continue;
      try {
        await runCommand(`open ${app}`, () => client.apps.open({ app, ...where }), info.signal);
      } catch (cause) {
        if (info.signal.aborted) throw cause;
        info.log(`${label}: automation runner not warmed up (${message(cause)}); the first attempt starts it`);
      }
    }
  }
}
