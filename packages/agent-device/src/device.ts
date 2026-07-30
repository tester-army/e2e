/** The `device` capability, mapped onto agent-device system commands. */

import type { DriverDevice, OperationContext } from 'e2e/driver';
import type { AgentDeviceClient } from './client.ts';
import { translateAgentDeviceError, unsupported, withDeadline } from './support.ts';

/**
 * Public permission names map to agent-device permission targets. `location`
 * differs: agent-device exposes it as a permission on Android and only as a
 * simulated-position setting on iOS, so both platforms use the permission
 * target and let the backend report an unsupported combination.
 */
const PERMISSION_STATES = {
  allow: 'grant',
  deny: 'deny',
  unset: 'reset',
} as const;

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
    setPermission: (permission, state, operation) => {
      const target = PERMISSION_STATES[state];
      if (target === undefined) throw unsupported(`permission state "${String(state)}"`);
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
