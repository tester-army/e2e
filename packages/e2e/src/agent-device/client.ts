/**
 * The backend seam: everything this driver needs from agent-device, in one file.
 *
 * agent-device exports its runtime entry points but not its types, so every
 * shape here is derived structurally from `createAgentDeviceClient`. That keeps
 * the driver pinned to the real contract: a shape change upstream becomes a
 * compile error here rather than a runtime surprise.
 *
 * This module is also the only place that names the backend. The driver consumes
 * device primitives — snapshot, ref-addressed input, gestures, artifacts,
 * settings — and never agent-device's semantic layer: its `find` resolves and
 * mutates in one call and its `wait` adds hidden retries, both of which belong
 * to the runner under `spec/09-drivers.md`. Keeping the surface listed here
 * makes upstream drift a compile error in one file, and keeps a second backend
 * a possibility rather than a rewrite.
 */

import type { createAgentDeviceClient } from 'agent-device';

export type AgentDeviceClient = ReturnType<typeof createAgentDeviceClient>;
export type AgentDeviceClientConfig = NonNullable<Parameters<typeof createAgentDeviceClient>[0]>;
/** The daemon transport seam: one request in, one daemon response out. */
export type AgentDeviceTransport = NonNullable<
  NonNullable<Parameters<typeof createAgentDeviceClient>[1]>['transport']
>;

type Group<Name extends keyof AgentDeviceClient> = AgentDeviceClient[Name];
type Result<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
type Options<F> = F extends (options: infer O, ...rest: never[]) => unknown ? O : never;

export type SnapshotResult = Result<Group<'capture'>['snapshot']>;
export type SnapshotNode = SnapshotResult['nodes'][number];
/** The backend's own verdict on whether a capture can be trusted. */
export type SnapshotQuality = NonNullable<SnapshotResult['snapshotQuality']>;
export type ScreenshotResult = Result<Group<'capture'>['screenshot']>;
export type ScreenshotOptions = NonNullable<Options<Group<'capture'>['screenshot']>>;
export type AppOpenOptions = Options<Group<'apps'>['open']>;
export type AppOpenResult = Result<Group<'apps'>['open']>;
export type DeviceList = Result<Group<'devices'>['list']>;
export type DeviceInfo = DeviceList[number];
export type ScrollOptions = Options<Group<'interactions'>['scroll']>;
export type ClickOptions = Options<Group<'interactions'>['click']>;
export type FillOptions = Options<Group<'interactions'>['fill']>;
export type LongPressOptions = Options<Group<'interactions'>['longPress']>;
export type SwipeOptions = Options<Group<'interactions'>['swipe']>;
export type SettingsUpdateOptions = Options<Group<'settings'>['update']>;
export type RecordOptions = Options<Group<'recording'>['record']>;

/** A node's geometry, in device-independent points. */
export type NodeRect = NonNullable<SnapshotNode['rect']>;

/** The `scroll` direction vocabulary agent-device accepts. */
export type AgentDeviceScrollDirection = ScrollOptions['direction'];
