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

export interface AgentDeviceOptions {
  /**
   * Session name prefix. Sessions are named per driver instance so parallel
   * workers never share one device; override only to join a session you own.
   */
  readonly sessionPrefix?: string;
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
      client.devices.boot({ platform: target.platform, udid: device.id }),
      context.operation,
      'devices.boot',
    );
    const app = isBuildArtifact(target.app)
      ? await this.install(client, target, context)
      : target.app;
    this.resolved = { device, app };
    return { client, device, app };
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

/** Picks the device matching the target's selectors, preferring a booted one. */
function selectDevice(devices: readonly DeviceInfo[], target: MobileWireTarget): DeviceInfo {
  const candidates = devices.filter((device) => {
    if (target.device !== undefined && device.name !== target.device) return false;
    return true;
  });
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
  const sessionName = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const lease = new DeviceLease(sessionName, options);

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
        // device itself to be retained between sessions.
        await session.app.clearState(context.operation);
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
