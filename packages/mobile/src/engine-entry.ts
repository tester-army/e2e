/**
 * `@e2e-dev/mobile/engine`: the `mobile()` factory and its types, without
 * `test`, so a program that drives a device with `e2e-core` never loads the
 * test runner. The main entry re-exports all of it beside `test`.
 */

export { mobile } from './engine.ts';
/** The engine factory again, as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { mobile as default } from './engine.ts';
export type { DevicePermission, LaunchPermissions, MobileOptions, MobilePlatform, PermissionState } from './options.ts';
export type { DeviceClientConfig, DeviceConnection, DeviceDaemon } from './bindings.ts';
export type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from './provider.ts';
export type { FoldPose, InstallAppOptions, InstalledApp, OpenAppOptions } from './surface.ts';
export type { BiometricSensor, Device, DeviceOrientation, DeviceSession, DeviceSessionClient, ForegroundApp } from './device.ts';
export type { DeviceSelection } from './pool.ts';
export type { MobileFixtures } from './fixtures.ts';
