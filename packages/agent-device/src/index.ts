/**
 * `@e2edev/agent-device` public surface: the `agentDevice()` backend factory,
 * the `device` fixture types, and a `test` typed with that fixture. `expect`
 * and `credentials` still come from `e2e`; the agent-side tool pack lives on
 * the `@e2edev/agent-device/tools` subpath so this entry never loads the AI SDK.
 */

import { test as base } from '@e2edev/e2e';
import type { Device } from './device.ts';

export { agentDevice } from './backend.ts';
export type { AgentDeviceOptions, AgentDevicePlatform } from './surface.ts';
export type { BiometricSensor, Device, DeviceOrientation, DevicePermission, ForegroundApp } from './device.ts';

/**
 * `test` typed with this backend's contributed `device` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = base.extend<{ device: Device }>();
