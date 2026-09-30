/**
 * What the device engine is given: its options, and the agent-device client
 * it drives them through. Shared by the surface (one session per worker) and
 * the pool (the target's devices, one per worker slot).
 */

import type { createAgentDeviceClient } from 'agent-device';
import type { DeviceConnection } from './bindings.ts';
import type { DeviceProvider } from './provider.ts';

export type AgentDeviceClient = ReturnType<typeof createAgentDeviceClient>;

/**
 * Mints the agent-device client for one session, with the daemon and client
 * configuration a lease supplied when a provider leased the device, else
 * against the local daemon; the seam unit tests script.
 */
export type ClientFactory = (session: string, connection?: DeviceConnection) => AgentDeviceClient;

export type MobilePlatform = 'ios' | 'android';

/** Every permission agent-device can grant, deny, or reset on an app: what a target's `app.permissions` and `device.openApp` may name. */
export const DEVICE_PERMISSIONS = [
  'camera',
  'microphone',
  'photos',
  'contacts',
  'notifications',
  'calendar',
  'location',
  'reminders',
  'motion',
  'siri',
  'media-library',
] as const;

/** Permissions agent-device can grant, deny, or reset on an app. */
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];

/** A permission's state: held, refused, or not asked for yet, so the OS asks again. */
export type PermissionState = 'grant' | 'deny' | 'reset';

/** Permissions an app holds when it launches, by name. */
export type LaunchPermissions = Readonly<Partial<Record<DevicePermission, PermissionState>>>;

/**
 * Options of the device engine: which devices it drives and how. The app
 * under test is the target's `app` (`bundleId`, `appPath`,
 * `launchArguments`, `permissions`). Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface MobileOptions {
  /** Platform the target's device runs. */
  readonly platform: MobilePlatform;
  /**
   * Simulator or emulator to use, by name, simulator UDID, or emulator
   * serial (`emulator-5554`). A list is a pool: the
   * engine declares one worker per entry and worker slot `n` drives the
   * `n`th, so `workers` at or above the pool size runs the target's files
   * across every device at once. Omitted, the pool is every booted device of
   * the platform at `prepare`, as many as the run has slots; with none booted,
   * agent-device boots one. A `DeviceProvider` leases hosted devices instead:
   * one per worker slot at `prepare`, each driven through the daemon and
   * client configuration the lease names, all released when the run ends.
   */
  readonly device?: string | readonly string[] | DeviceProvider | undefined;
  /**
   * agent-device session name, before the worker slot: slot `n` drives its
   * device under `<session>-<n>`, `e2e-<target name>-<n>` by default. One run
   * per session at a time: concurrent runs on the same session interleave
   * taps.
   */
  readonly session?: string | undefined;
  /**
   * What an observation captures. `full` (default) includes static text, so
   * judgments can read values; `interactive` keeps only actionable nodes and
   * is cheaper on screens with long lists.
   */
  readonly snapshot?: 'full' | 'interactive' | undefined;
  /**
   * How long the UI must hold still after a tap, fill, screen scroll, or
   * back before the action counts as landed, in milliseconds; `false` skips
   * the wait. The wait keeps the observation that follows an action off a
   * transition frame; the runner's own polling (`expect`, actions waiting
   * for their node) covers the rest, so a short window suffices. Default
   * 150. Every frame of a running animation changes the tree, so a 150 ms
   * window still catches a transition in flight; raise it for slow devices
   * or apps that settle in stages, or lower it to 0 to keep only the first
   * re-observation.
   */
  readonly settle?: number | false | undefined;
  /**
   * How long a control that appeared or moved with the last action is given
   * to finish arriving before a test acts on it, in milliseconds. Default
   * 500, the length of a modal or screen transition. Accessibility frames
   * report a control's final position from the first frame of a transition,
   * so this budget is the only thing that keeps a test from tapping a point
   * the control has not reached; controls already on screen at the same
   * place before the action are acted on at once. Raise it for slower
   * transitions.
   */
  readonly transition?: number | undefined;
  /**
   * Whether a video recording draws agent-device's touch indicator where a
   * test tapped. Default `true`. `false` records the plain screen, and skips
   * the pass that draws the indicator once the recording stops: on a hosted
   * daemon that pass can outlast the attempt's `cleanupTimeout`.
   */
  readonly videoTouches?: boolean | undefined;
}
