/**
 * Types for the agent-device typed client.
 *
 * agent-device exports its runtime entry points but not its types, so every
 * shape here is derived structurally from `createAgentDeviceClient`. That keeps
 * the driver pinned to the real contract: a shape change upstream becomes a
 * compile error here rather than a runtime surprise.
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
