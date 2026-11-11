/**
 * Revyl's hosted iOS simulators and Android emulators as a `DeviceProvider`
 * for the mobile engine, through agent-device's `@agent-device/revyl` plugin:
 * each lease comes from its own agent-device daemon, which starts a Revyl
 * device with the app installed from an `https` URL.
 */

import type { DeviceClientConfig, DeviceLease, DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { agentDeviceLeases, type LeaseSelectors } from '@e2e-dev/mobile/lease';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { credentialsEnv, revylCredentials } from './credentials.ts';
import { assertPluginVersion, installPlugin } from './daemon.ts';

/** agent-device's name for Revyl, as the lease provider and the tenant. */
const PROVIDER = 'revyl';

/** Every option `revyl()` takes, kept equal to `RevylOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  app: true,
  device: true,
  osVersion: true,
} satisfies Record<keyof RevylOptions, true>);

/** What `revyl()` takes: the build Revyl installs, and the device model it runs on. */
export interface RevylOptions {
  /**
   * `https` URL Revyl downloads the build from when it starts each device: an
   * iOS simulator build (`.app` zipped) or an Android `.apk`. A local path is
   * refused, since Revyl cannot read it.
   */
  readonly app: string;
  /** Device model as Revyl lists it: `iPhone 17 Pro Max`, `Pixel 7`. */
  readonly device: string;
  /** OS version as Revyl lists it for that model: `iOS 27.0`, `Android 14`. Absent, Revyl's default for the model. */
  readonly osVersion?: string | undefined;
}

/**
 * Revyl devices for `mobile({ device: revyl({ app, device }) })`: one hosted
 * device and isolated agent-device daemon per worker slot. Allocating the
 * lease starts the Revyl device, which installs `app`; releasing it stops the
 * daemon, which ends the device session.
 */
export function revyl(options: RevylOptions): DeviceProvider {
  rejectUnknownKeys('revyl()', options, OPTION_KEYS);
  for (const key of ['app', 'device'] as const) {
    const value: unknown = options[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigurationError('INVALID_CONFIG', `revyl: \`${key}\` is required, as a non-empty string`);
    }
  }
  const osVersion: unknown = options.osVersion;
  if (osVersion !== undefined && (typeof osVersion !== 'string' || osVersion.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `osVersion` must be a non-empty string');
  }
  if (!isHttpsUrl(options.app)) {
    throw new ConfigurationError('INVALID_CONFIG', `revyl: \`app\` must be an https URL Revyl can download the build from, not ${JSON.stringify(options.app)}`);
  }
  const { app, device } = options;
  const leases = agentDeviceLeases({ provider: PROVIDER, label: 'Revyl' });

  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      assertPluginVersion(request.agentDeviceVersion);
      if (request.appPath !== undefined) throw new Error("Revyl installs the app from `app`; leave the target's `app.appPath` out");
      const credentials = revylCredentials(request.env);
      const selectors = {
        device,
        providerApp: app,
        ...(options.osVersion === undefined ? {} : { providerOsVersion: options.osVersion }),
      } satisfies LeaseSelectors;
      const lease = await leases.acquire(request, {
        env: credentialsEnv(credentials),
        selectors,
        summary: `${device}, ${request.platform}${options.osVersion === undefined ? '' : ` ${options.osVersion}`}; Revyl device started`,
        prepareHome: installPlugin,
      });
      return withoutModelName(lease);
    },
    release: (lease, context) => leases.release(lease, context),
  };
}

/**
 * The lease without `device` on its client. The model only selects which
 * device Revyl starts; the plugin lists the started device under its own
 * name (`Revyl android <id>`), so a worker selecting it by model would find no
 * device. The lease scope already picks the one device the daemon holds.
 */
function withoutModelName(lease: DeviceLease): DeviceLease {
  if (lease.client === undefined) return lease;
  // `@e2e-dev/mobile/lease` spreads the selectors onto the client at runtime, though its type does not name `device`.
  const client = Object.fromEntries(Object.entries(lease.client).filter(([key]) => key !== 'device')) as DeviceClientConfig;
  return { ...lease, client };
}

/** An `https` URL without credentials in it, the only app source the Revyl plugin accepts. */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}
