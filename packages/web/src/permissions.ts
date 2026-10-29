/**
 * A web target's `app.permissions`: the browser permissions every page of an
 * attempt holds. The surface grants them on each context the attempt opens.
 */

import { ConfigurationError, rejectUnknownKeys, type AppPermissionState } from 'e2e/engine';
import type { BrowserName } from './browser-connection.ts';

/** The permission names Playwright grants on each browser (playwright-core 1.64). */
const BROWSER_PERMISSIONS = {
  chromium: [
    'accelerometer', 'ambient-light-sensor', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write',
    'geolocation', 'gyroscope', 'local-fonts', 'local-network-access', 'magnetometer', 'microphone', 'midi',
    'midi-sysex', 'notifications', 'payment-handler', 'screen-wake-lock', 'storage-access',
  ],
  firefox: ['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock'],
  webkit: ['camera', 'clipboard-read', 'geolocation', 'microphone', 'notifications', 'screen-wake-lock'],
} as const satisfies Record<BrowserName, readonly string[]>;

/**
 * Refuses a permission `browser` cannot grant, and any state but `grant`:
 * Playwright only grants, and Chromium denies every permission a grant
 * leaves out, so neither `deny` nor `reset` can mean what it does on a
 * device. The harness has checked the map's shape and states already.
 */
export function validatePermissions(targetName: string, browser: BrowserName, permissions: Readonly<Record<string, AppPermissionState>>): void {
  const where = `target "${targetName}" app.permissions`;
  rejectUnknownKeys(`${where} on ${browser}`, permissions, BROWSER_PERMISSIONS[browser]);
  for (const [name, state] of Object.entries(permissions)) {
    if (state !== 'grant') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where}.${name} is ${state}, but a web() target only grants; leave the permission out instead`,
      );
    }
  }
}
