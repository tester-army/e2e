/**
 * `e2e/agent-device` - the reference `mobile-0.1` driver.
 *
 * It maps e2e-owned mobile semantics onto the agent-device daemon, which owns
 * simulator and emulator mechanics. The driver keeps semantics: it resolves
 * locators itself against a snapshot rather than delegating to agent-device's
 * selector language, so cardinality, text matching, and polling stay exactly
 * as the specification defines them.
 *
 * `agent-device` is a peer dependency, so importing this module requires it to
 * be installed alongside `e2e`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createAgentDeviceClient } from 'agent-device';
import { defineDriver, type Driver, type DriverContext, type DriverSession } from '../driver/index.ts';
import { packageVersion } from '../internal/package-version.ts';
import type { MobilePlatform } from './roles.ts';
import type {
  AgentDeviceClient,
  AgentDeviceClientConfig,
  AgentDeviceTransport,
  DeviceInfo,
} from './client.ts';
import { MobileSession } from './session.ts';
import { invalidState, translateAgentDeviceError, withDeadline } from './support.ts';

/** Build-artifact extensions `MobileTarget.app` may point at. */
const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set(['.app', '.ipa', '.apk', '.aab']);

/**
 * How each session isolates app state.
 *
 * `clear-state` wipes the app data container before relaunching, which is what
 * `mobile-0.1` expects of an attempt. `relaunch` only restarts the app, and is
 * required for an app that has no data container to clear, such as a built-in
 * system app: it does NOT isolate state between attempts.
 */
export type AgentDeviceReset = 'clear-state' | 'relaunch';

export interface AgentDeviceOptions {
  /** Per-attempt state reset. Defaults to `clear-state`. */
  readonly reset?: AgentDeviceReset;
  /**
   * Session name prefix. Sessions are named per driver instance so parallel
   * workers never share one device; override only to join a session you own.
   */
  readonly sessionPrefix?: string;
  /**
   * Reclaims a device held by an abandoned session of this same prefix.
   *
   * The daemon outlives the runner, so a cancelled or killed run leaves its
   * session open and its device claimed, and every later run then fails with
   * `DEVICE_IN_USE`. Defaults to true: reclaiming our own abandoned sessions is
   * what makes a local or CI rerun work without manual cleanup. A session
   * belonging to another prefix is never touched.
   */
  readonly reclaimAbandonedSessions?: boolean;
  /** Shuts the simulator or emulator down on dispose, for CI cleanliness. */
  readonly shutdownOnDispose?: boolean;
  /** Extra agent-device client configuration, such as a remote daemon URL. */
  readonly client?: AgentDeviceClientConfig;
  /**
   * Replaces the daemon transport. A bridge that already owns device access
   * supplies one; the driver otherwise talks to the local daemon.
   */
  readonly transport?: AgentDeviceTransport;
}

/** The mobile fields the driver reads off the wire target. */
interface MobileWireTarget {
  readonly platform: 'ios' | 'android';
  readonly app: string;
  readonly device?: string;
  readonly os?: string;
}

/** Reads the pid a session name encodes, or undefined when it is not ours. */
function ownerPidOf(sessionName: string, prefix: string): number | undefined {
  const match = new RegExp(`^${prefix}-(\\d+)-[a-z0-9]+$`).exec(sessionName);
  if (match?.[1] === undefined) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Reports whether a pid still exists, without signalling it. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user.
    return (cause as { code?: string }).code === 'EPERM';
  }
}

/** Narrows the open `Platform` union to the two platforms this driver drives. */
function isMobilePlatform(value: string): value is 'ios' | 'android' {
  return value === 'ios' || value === 'android';
}

/**
 * Narrows the wire target to the mobile fields this driver understands, and
 * rejects anything else before touching a device.
 */
function parseMobileTarget(target: DriverContext['target']): MobileWireTarget {
  const platform = target.platform;
  // `Platform` is an open string union, so this needs a predicate rather than
  // inequality checks, which cannot narrow it.
  if (!isMobilePlatform(platform)) {
    throw invalidState(`agent-device drives ios and android targets, not "${String(platform)}"`);
  }
  const app = 'app' in target ? target.app : undefined;
  if (typeof app !== 'string' || app.length === 0) {
    throw invalidState('a mobile target requires app');
  }
  const device = 'device' in target ? target.device : undefined;
  const os = 'os' in target ? target.os : undefined;
  return {
    platform,
    app,
    ...(typeof device === 'string' ? { device } : {}),
    ...(typeof os === 'string' ? { os } : {}),
  };
}

/**
 * Reports whether `app` names a build artifact rather than an installed app.
 *
 * The extension alone is not enough: an iOS bundle identifier such as
 * `com.example.app` ends in `.app`. A path is required as well, either an
 * explicit separator or a file that exists on disk.
 */
function isBuildArtifact(app: string): boolean {
  if (!ARTIFACT_EXTENSIONS.has(path.extname(app).toLowerCase())) return false;
  if (app.includes('/') || app.includes('\\')) return true;
  return existsSync(path.resolve(app));
}

/**
 * A booted device retained across the sessions of one driver instance.
 *
 * `spec/09-drivers.md` allows keeping expensive backend resources alive between
 * strictly serialized sessions provided each new session observes isolated app
 * state, which `launch` guarantees by clearing the data container.
 */
class DeviceLease {
  private client: AgentDeviceClient | null = null;
  private resolved: { device: DeviceInfo; app: string } | null = null;

  constructor(
    private readonly sessionName: string,
    private readonly prefix: string,
    private readonly options: AgentDeviceOptions,
  ) {}

  /** Creates the client once; the daemon owns process lifetime beyond it. */
  private ensureClient(platform: 'ios' | 'android'): AgentDeviceClient {
    if (this.client === null) {
      this.client = createAgentDeviceClient(
        {
          ...this.options.client,
          session: this.sessionName,
          // Reject rather than silently retarget when another caller holds this
          // session: a shared device would break session isolation.
          lockPolicy: 'reject',
          lockPlatform: platform,
        },
        this.options.transport === undefined ? undefined : { transport: this.options.transport },
      );
    }
    return this.client;
  }

  /**
   * Resolves the device and application identity, installing a build artifact
   * on first use. Physical devices are rejected: `mobile-0.1` covers simulators
   * and emulators only, because the reset, permission, and push primitives it
   * requires are simulator-only.
   */
  async acquire(
    target: MobileWireTarget,
    context: DriverContext,
  ): Promise<{ client: AgentDeviceClient; device: DeviceInfo; app: string }> {
    const client = this.ensureClient(target.platform);
    if (this.resolved !== null) {
      return { client, device: this.resolved.device, app: this.resolved.app };
    }
    if (this.options.reclaimAbandonedSessions !== false) {
      await this.reclaimAbandoned(client, context);
    }
    const selection = {
      platform: target.platform,
      ...(target.device !== undefined ? { device: target.device } : {}),
    };
    const devices = await withDeadline(
      client.devices.list(selection),
      context.operation,
      'devices.list',
    );
    const device = selectDevice(devices, target);
    // mobile-0.1 covers simulators and emulators only: the reset, permission,
    // and push primitives it requires do not exist on a physical device.
    if (device.kind === 'device') {
      throw invalidState(
        `"${device.name}" is a physical device; mobile-0.1 covers simulators and emulators only`,
      );
    }
    await withDeadline(
      client.devices.boot({ platform: target.platform, ...deviceSelector(device, target.platform) }),
      context.operation,
      'devices.boot',
    );
    const app = isBuildArtifact(target.app)
      ? await this.install(client, target, context)
      : target.app;
    this.resolved = { device, app };
    return { client, device, app };
  }

  /**
   * Closes sessions left behind by an earlier run of this prefix.
   *
   * Only sessions whose owning process is gone are closed. The prefix carries
   * the pid that created it, so a live parallel worker's session is left alone
   * and only genuinely abandoned claims are released.
   */
  private async reclaimAbandoned(
    client: AgentDeviceClient,
    context: DriverContext,
  ): Promise<void> {
    let sessions;
    try {
      sessions = await withDeadline(client.sessions.list(), context.operation, 'sessions.list');
    } catch {
      // Reclamation is a convenience; launch reports the real failure.
      return;
    }
    for (const session of sessions) {
      if (session.name === this.sessionName) continue;
      const owner = ownerPidOf(session.name, this.prefix);
      if (owner === undefined || owner === process.pid || isProcessAlive(owner)) continue;
      await client.sessions
        .close({ session: session.name })
        .catch(() => undefined);
    }
  }

  /** Installs a build artifact and returns the identity it resolved to. */
  private async install(
    client: AgentDeviceClient,
    target: MobileWireTarget,
    context: DriverContext,
  ): Promise<string> {
    const appPath = path.resolve(target.app);
    const installed = await withDeadline(
      client.apps.install({ platform: target.platform, appPath }),
      context.operation,
      'apps.install',
    );
    // Identity comes from the artifact, never from its filename.
    const identity = installed.bundleId ?? installed.package ?? installed.appId;
    if (identity === undefined || identity === '') {
      throw invalidState(`could not resolve app identity from ${appPath}`);
    }
    return identity;
  }

  /** Releases the retained device. It is idempotent. */
  async dispose(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    this.client = null;
    this.resolved = null;
    await client.sessions
      .close(this.options.shutdownOnDispose === true ? { shutdown: true } : {})
      .catch(() => undefined);
  }
}

/**
 * Folds a device name to a comparable form.
 *
 * An Android AVD is configured as `Medium_Phone_API_36.1` but reports itself as
 * `Medium Phone API 36.1` once booted, so a configured name must survive the
 * separator and case change rather than stopping working the moment the
 * emulator starts.
 */
function foldDeviceName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Names one resolved device the way its platform expects.
 *
 * The two platforms use different selector fields, and the daemon rejects the
 * wrong one outright rather than ignoring it: Apple targets are addressed by
 * UDID, Android by serial.
 */
function deviceSelector(
  device: DeviceInfo,
  platform: MobilePlatform,
): { readonly udid: string } | { readonly serial: string } {
  if (platform === 'android') return { serial: device.android?.serial ?? device.id };
  return { udid: device.ios?.udid ?? device.id };
}

/** Reports whether one device answers to a configured selector. */
function matchesSelector(device: DeviceInfo, selector: string): boolean {
  // An id match lets a selector be a UDID or an emulator serial.
  return (
    device.name === selector ||
    device.id === selector ||
    foldDeviceName(device.name) === foldDeviceName(selector)
  );
}

/** Picks the device matching the target's selectors, preferring a booted one. */
function selectDevice(devices: readonly DeviceInfo[], target: MobileWireTarget): DeviceInfo {
  const candidates = devices.filter(
    (device) => target.device === undefined || matchesSelector(device, target.device),
  );
  const chosen = candidates.find((device) => device.booted === true) ?? candidates[0];
  if (chosen === undefined) {
    const wanted = [target.device, target.os].filter((value) => value !== undefined).join(' ');
    throw invalidState(
      `no ${target.platform} simulator or emulator matches${wanted === '' ? '' : ` ${wanted}`}`,
    );
  }
  return chosen;
}

/**
 * Creates the reference `mobile-0.1` driver. Each call creates one instance
 * with its own retained device, so a parallel run gives every worker its own
 * simulator or emulator.
 */
export function agentDevice(options: AgentDeviceOptions = {}): Driver {
  const prefix = options.sessionPrefix ?? 'e2e';
  // The pid is part of the name so a later run can tell an abandoned session
  // from a live parallel worker's.
  const sessionName = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = new DeviceLease(sessionName, prefix, options);

  return defineDriver({
    id: 'agent-device',
    // The driver artifact is this package, and `id` already identifies the
    // backend. agent-device does not export its own package.json, so reading a
    // backend version here would silently and permanently report "unknown".
    version: packageVersion(import.meta.url, '../../package.json', 'unknown'),
    platforms: ['ios', 'android'],
    spiVersion: 1,
    capabilities: {
      fixtures: ['device'],
      // No trace: there is no portable iOS and Android equivalent.
      artifacts: ['screenshot', 'video'],
      // mobile-0.1 defines no application state capture, and a partial
      // container copy must not be presented as one.
      state: false,
    },
    async launch(context: DriverContext): Promise<DriverSession> {
      const target = parseMobileTarget(context.target);
      try {
        const { client, device, app } = await lease.acquire(target, context);
        const session = new MobileSession({
          client,
          platform: target.platform,
          app,
          context,
          device: { name: device.name, os: target.os ?? 'unknown' },
        });
        // Each session observes isolated app state, which is what allows the
        // device itself to be retained between sessions. This does not launch
        // the app: launch leaves it not yet foreground, and the attempt's own
        // `app.open` is the single launch.
        await session.resetState(options.reset ?? 'clear-state', context.operation);
        return session;
      } catch (cause) {
        // Launch must roll back every partial acquisition, because no session
        // exists for the runner to close.
        await lease.dispose();
        throw translateAgentDeviceError(cause, 'launch');
      }
    },
    dispose: () => lease.dispose(),
  });
}

export default agentDevice;
