/** E2B's `android-16` sandboxes as a `DeviceProvider` for the mobile engine. */

import { randomBytes } from 'node:crypto';
import { createAgentDeviceClient } from 'agent-device';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { sandboxClients, type E2BSandbox } from './client.ts';
import { leaseMetadata, poll, sandboxLeases, templateOption, timeoutOption, withLog } from './lease.ts';

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

/** The SHA-256 nodejs.org publishes for that version's linux-x64 tarball (`SHASUMS256.txt`). */
const NODE_SHA256 = '58a5ff5cc8f2200e458bea22e329d5c1994aa1b111d499ca46ec2411d58239ca';

/** Bounds the in-sandbox setup, Android's boot, the proxy's first answer, and the build's install, together. */
const SETUP_TIMEOUT_MS = 300_000;

/** A plain semver version: the only shape of `agentDeviceVersion` that reaches a shell. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Installs Node and the engine's agent-device in the sandbox and waits for
 * Android to finish booting. It runs on every sandbox because it cannot be
 * baked into a template: custom templates built on `android-16` do not boot
 * Android.
 */
function setupScript(agentDeviceVersion: string): string {
  return [
    'set -eu',
    // One command per line: under `set -e` a failed step inside an `&&` chain would not stop the script.
    'if ! command -v node >/dev/null; then',
    `  curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz -o /tmp/node.tar.gz`,
    `  echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c --quiet -`,
    '  sudo tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1',
    'fi',
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
  const leases = sandboxLeases(sandboxClients());

  /** Sets the sandbox up, starts agent-device behind its proxy, installs the build, and resolves to the lease. */
  async function ready(sandbox: E2BSandbox, baseUrl: string, request: DeviceRequest): Promise<DeviceLease> {
    request.log(`sandbox ${sandbox.sandboxId}`);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(SETUP_TIMEOUT_MS)]);
    await sandbox.run(setupScript(request.agentDeviceVersion), { timeoutMs: SETUP_TIMEOUT_MS, signal }).catch((cause: unknown) => {
      // The setup's own budget, not the run's interrupt: say which step ran out of time.
      if (signal.aborted && !request.signal.aborted) {
        throw new Error(`Android setup did not finish within ${SETUP_TIMEOUT_MS / 1000}s: installing Node and agent-device, or waiting for Android to boot`, { cause });
      }
      throw cause;
    });
    const daemon = { baseUrl, authToken: randomBytes(32).toString('hex') };
    // Through `envs`, so the token is not in the command E2B receives. Not AGENT_DEVICE_DAEMON_AUTH_TOKEN:
    // the daemon the proxy starts would inherit it. The proxy prints its token, so stdout is dropped.
    await sandbox.start(`exec agent-device proxy --host 0.0.0.0 --port ${PROXY_PORT} --daemon-auth-token "$PROXY_TOKEN" >/dev/null 2>${PROXY_LOG}`, {
      envs: { PROXY_TOKEN: daemon.authToken },
      signal,
    });
    await waitForProxy(baseUrl, signal).catch(async (cause: unknown) => {
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
      return leases.acquire(request, { template, timeoutMs, metadata: leaseMetadata(request), port: PROXY_PORT }, (sandbox, tunnel) => ready(sandbox, tunnel.url, request));
    },
    release: (lease: DeviceLease, context: DeviceReleaseContext) => leases.release(lease.id, context),
  };
}
