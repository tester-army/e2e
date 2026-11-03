/** E2B's `android-16` sandboxes as a `DeviceProvider` for the mobile engine. */

import { randomBytes } from 'node:crypto';
import { createAgentDeviceClient } from 'agent-device';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { createAndServe, leaseMetadata, leaseTunnels, poll, sandboxClients, templateOption, timeoutOption, withLog, type E2BSandbox } from './sandbox.ts';
import { openTunnel } from './tunnel.ts';

export interface E2BOptions {
  /** Sandbox template that boots Android, `android-16` by default. */
  readonly template?: string | undefined;
  /**
   * How long a sandbox lives before E2B kills it, in milliseconds. Defaults to
   * one hour: the backstop for a run that died before it could release.
   */
  readonly timeoutMs?: number | undefined;
}

const OPTION_KEYS: readonly string[] = Object.keys({
  template: true,
  timeoutMs: true,
} satisfies Record<keyof E2BOptions, true>);

const DEFAULT_TEMPLATE = 'android-16';
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/** The adb serial the template's Android answers on; the same device is also listed as `emulator-5554`. */
const SERIAL = '127.0.0.1:5555';

/** Port the agent-device proxy listens on inside the sandbox. */
const PROXY_PORT = 4310;

/** The proxy's errors, read into the error when it never answers. */
const PROXY_LOG = '/tmp/agent-device-proxy.log';

/** The template ships no Node; agent-device needs one. */
const NODE_VERSION = '24.11.1';

/** Bounds the in-sandbox setup, Android's boot, the proxy's first answer, and the build's install, together. */
const SETUP_TIMEOUT_MS = 300_000;

/** A plain semver version: the only shape of `agentDeviceVersion` that reaches a shell. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Installs Node and the engine's agent-device in the sandbox and waits for
 * Android to finish booting. Custom templates built on `android-16` do not
 * boot Android, so this runs on every sandbox instead of being baked in.
 */
function setupScript(agentDeviceVersion: string): string {
  return [
    'set -eu',
    `command -v node >/dev/null || curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz | sudo tar -xz -C /usr/local --strip-components=1`,
    `sudo npm install --global --no-fund --no-audit --loglevel=error agent-device@${agentDeviceVersion}`,
    `adb connect ${SERIAL} >/dev/null`,
    `until [ "$(adb -s ${SERIAL} shell getprop sys.boot_completed | tr -d '\\r')" = 1 ]; do sleep 1; done`,
  ].join('\n');
}

/**
 * Installs the target's `.apk` through the lease's own daemon, resolving to
 * the package agent-device reports: the client uploads the build to the
 * proxy, the same way the engine's `device.installApp()` does.
 */
async function installBuild(sandbox: E2BSandbox, request: DeviceRequest, appPath: string, daemon: { baseUrl: string; authToken: string }, signal: AbortSignal): Promise<string> {
  if (!appPath.toLowerCase().endsWith('.apk')) {
    throw new ConfigurationError('INVALID_CONFIG', `e2b() installs an .apk; app.appPath of target "${request.targetName}" is ${appPath}`);
  }
  // A session of its own, closed before the worker opens its session on the device.
  const client = createAgentDeviceClient({ session: `e2e-install-${sandbox.sandboxId}`, daemonBaseUrl: daemon.baseUrl, daemonAuthToken: daemon.authToken });
  try {
    const installed = await client.apps.install({ appPath, platform: 'android', serial: SERIAL, signal, ...(request.app === undefined ? {} : { app: request.app }) });
    // The same order the mobile engine reads an install's identity in.
    const app = installed.bundleId ?? installed.package ?? installed.appId ?? request.app;
    if (app === undefined) throw new Error(`installing ${appPath} reported no package; set app.bundleId to the package to open`);
    return app;
  } finally {
    await client.sessions.close({ signal }).catch(() => {});
  }
}

/** Polls the proxy's unauthenticated health route through the tunnel until it answers. */
async function waitForProxy(baseUrl: string, signal: AbortSignal): Promise<void> {
  await poll(`agent-device proxy at ${baseUrl} did not answer`, signal, async (attempt) => {
    const response = await fetch(`${baseUrl}/health`, { signal: attempt });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
}

/**
 * E2B Android for `mobile({ platform: 'android', device: e2b() })`: one
 * `android-16` sandbox per worker slot. Each sandbox runs the engine's
 * agent-device behind `agent-device proxy`, with a bearer token minted per
 * lease, so the runner needs no adb of its own. The sandbox refuses public
 * traffic: the lease's daemon is a loopback tunnel on the runner's machine
 * that adds E2B's traffic access token. A target's `app.appPath` (an `.apk`)
 * is installed through that daemon. Sandboxes are tagged
 * with the run, target, and slot, killed at release, and killed by E2B after
 * `timeoutMs` if the run died first.
 */
export function e2b(options: E2BOptions = {}): DeviceProvider {
  rejectUnknownKeys('e2b()', options, OPTION_KEYS);
  const template = templateOption('e2b()', options.template, DEFAULT_TEMPLATE);
  const timeoutMs = timeoutOption('e2b()', options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const clientFor = sandboxClients();
  const leases = leaseTunnels(clientFor);

  /** Starts agent-device behind its proxy and resolves to the daemon a worker connects to. */
  async function serve(sandbox: E2BSandbox, request: DeviceRequest): Promise<DeviceLease> {
    request.log(`sandbox ${sandbox.sandboxId}`);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SETUP_TIMEOUT_MS)]);
    await sandbox.run(setupScript(request.agentDeviceVersion), { timeoutMs: SETUP_TIMEOUT_MS, signal });
    const authToken = randomBytes(32).toString('hex');
    // Through `envs`, so the token is not in the command E2B receives. Not AGENT_DEVICE_DAEMON_AUTH_TOKEN:
    // the daemon the proxy starts would inherit it. The proxy prints its token, so stdout is dropped.
    await sandbox.start(`exec agent-device proxy --host 0.0.0.0 --port ${PROXY_PORT} --daemon-auth-token "$PROXY_TOKEN" >/dev/null 2>${PROXY_LOG}`, {
      envs: { PROXY_TOKEN: authToken },
      signal,
    });
    const tunnel = await openTunnel({ host: sandbox.host(PROXY_PORT), trafficToken: sandbox.trafficToken });
    return leases.hold(tunnel, () => connect(sandbox, request, { baseUrl: tunnel.url, authToken }, signal));
  }

  /** Waits for the proxy behind the tunnel, installs the build through it, and resolves to the lease. */
  async function connect(sandbox: E2BSandbox, request: DeviceRequest, daemon: { baseUrl: string; authToken: string }, signal: AbortSignal): Promise<DeviceLease> {
    await waitForProxy(daemon.baseUrl, signal).catch(async (cause: unknown) => {
      throw await withLog(sandbox, PROXY_LOG, cause, daemon.authToken);
    });
    const installedApp = request.appPath === undefined ? undefined : await installBuild(sandbox, request, request.appPath, daemon, signal);
    return { id: sandbox.sandboxId, daemon, deviceId: SERIAL, ...(installedApp === undefined ? {} : { installedApp }) };
  }

  return {
    name: 'e2b',
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      if (request.platform !== 'android') {
        throw new ConfigurationError('INVALID_CONFIG', `e2b() serves Android only; target "${request.targetName}" asks for ${request.platform}`);
      }
      if (!SEMVER.test(request.agentDeviceVersion)) throw new Error(`unexpected agent-device version ${JSON.stringify(request.agentDeviceVersion)}`);
      const metadata = leaseMetadata(request);
      return createAndServe(clientFor(request.env), { template, timeoutMs, metadata }, request.signal, (sandbox) => serve(sandbox, request));
    },
    release: (lease: DeviceLease, context: DeviceReleaseContext) => leases.release(lease.id, context),
  };
}
