/**
 * `@e2e-dev/mobile` public surface: the `mobile()` engine factory, the
 * `device` fixture types, and `test`, `describe`, and the hooks typed with
 * that fixture. `expect`, `credentials`, and `secrets` still come from
 * `e2e`; the agent-side tool pack lives on the `@e2e-dev/mobile/tools`
 * subpath so this entry never loads the AI SDK.
 */

import { test as base } from 'e2e';
import type { Device } from './device.ts';

export { mobile } from './engine.ts';
export type { DevicePermission, LaunchPermissions, MobileOptions, MobilePlatform, PermissionState } from './options.ts';
export type { DeviceClientConfig, DeviceConnection, DeviceDaemon } from './bindings.ts';
export type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from './provider.ts';
export type { InstallAppOptions, InstalledApp, OpenAppOptions } from './surface.ts';
export type { BiometricSensor, Device, DeviceOrientation, ForegroundApp } from './device.ts';

/**
 * `test` typed with this engine's contributed `device` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ device: Device }>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `device` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
