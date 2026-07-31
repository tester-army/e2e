/** The `device` capability, mapped onto agent-device system commands. */

import type { DriverDevice, OperationContext } from 'e2e/driver';
import type { AgentDeviceClient } from './client.ts';
import { translateAgentDeviceError, unsupported, withDeadline } from './support.ts';

/** Public permission names map to agent-device permission targets. */
const PERMISSION_STATES = {
  allow: 'grant',
  deny: 'deny',
  unset: 'reset',
} as const;

type Permission = Parameters<DriverDevice['setPermission']>[0];

/**
 * Which permissions each platform can actually express, measured rather than
 * assumed. The two platforms grant through different mechanisms and the sets
 * are nearly disjoint: iOS goes through `simctl privacy`, which has no service
 * for `camera` or `notifications`, and Android goes through `pm`, which has no
 * permission target for `location` — a simulated position is a setting there,
 * not a grant, and `device.setLocation` is how a test reaches it. `contacts` is
 * the only one both express.
 *
 * `spec/16-mobile.md` makes a permission the platform does not expose
 * `UNSUPPORTED_CAPABILITY`, and this is where that is decided. Deciding it here
 * rather than letting the call travel means the failure names the platform and
 * the alternatives instead of quoting a backend's internals, and it costs no
 * device round trip.
 */
const PLATFORM_PERMISSIONS: Readonly<Record<'ios' | 'android', ReadonlySet<Permission>>> = {
  ios: new Set<Permission>(['location', 'contacts']),
  android: new Set<Permission>(['camera', 'contacts', 'notifications']),
};

export interface DeviceScope {
  readonly platform: 'ios' | 'android';
  /** Resolved application identity, so every call is app-scoped. */
  readonly app: string;
}

/**
 * Builds the `DriverDevice` surface. Each call is bounded by the runner's
 * operation budget; the runner owns step recording and URL policy.
 */
export function createDriverDevice(
  client: AgentDeviceClient,
  scope: DeviceScope,
): DriverDevice {
  const platform = scope.platform;

  const run = async <T>(
    label: string,
    work: Promise<T>,
    operation: OperationContext,
  ): Promise<void> => {
    try {
      await withDeadline(work, operation, label);
    } catch (cause) {
      throw translateAgentDeviceError(cause, label);
    }
  };

  return {
    home: (operation) => run('device.home', client.command.home({ platform }), operation),
    hideKeyboard: (operation) =>
      run('device.hideKeyboard', client.command.keyboard({ platform, action: 'dismiss' }), operation),
    openUrl: (url, operation) =>
      // The app identity accompanies the URL: agent-device 0.20.2 drops a URL
      // sent on its own, which would silently open nothing.
      run('device.openUrl', client.apps.open({ platform, app: scope.app, url }), operation),
    setLocation: (location, operation) =>
      run(
        'device.setLocation',
        client.settings.update({
          platform,
          setting: 'location',
          state: 'set',
          latitude: location.latitude,
          longitude: location.longitude,
        }),
        operation,
      ),
    // Async so that a rejected combination arrives as a rejected promise. The
    // SPI declares one, and a caller that only wrote `.catch` would otherwise
    // miss a synchronous throw.
    setPermission: async (permission, state, operation) => {
      const target = PERMISSION_STATES[state];
      if (target === undefined) throw unsupported(`permission state "${String(state)}"`);
      const available = PLATFORM_PERMISSIONS[platform];
      if (!available.has(permission)) {
        throw unsupported(
          `the "${permission}" permission on ${platform}; ` +
            `${platform} expresses ${[...available].toSorted().join(', ')}` +
            (permission === 'location' ? ', and device.setLocation sets the position' : ''),
        );
      }
      // Permission actions are scoped to the session's active application,
      // which is this target's app, satisfying the app-scoping requirement.
      return run(
        'device.setPermission',
        client.settings.update({ platform, setting: 'permission', state: target, permission }),
        operation,
      );
    },
    pushNotification: (payload, operation) =>
      run(
        'device.pushNotification',
        // Serializing here both matches the string payload form the backend
        // accepts and proves the payload is JSON-safe before it is delivered.
        client.apps.push({ platform, app: scope.app, payload: JSON.stringify(payload) }),
        operation,
      ),
  };
}
