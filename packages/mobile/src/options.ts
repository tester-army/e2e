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
 * The `transition` budgets by the kind of the last action, in milliseconds,
 * each a non-negative integer. A `gesture` or `launch` budget left out takes
 * the `default` one.
 */
export interface TransitionBudgets {
  /** After any action except a gesture or a launch: a tap, fill, key, back, and the rest. Default 500. */
  readonly default?: number | undefined;
  /**
   * After a scroll or swipe, which can return while the content is still
   * moving. The least wait. The wait then goes on until the control stops
   * moving, two reads agreeing, at most 4 s after the gesture. A budget above
   * 4 s ends the wait at that budget, and 0 is no wait at all. Default: the
   * `default` budget.
   */
  readonly gesture?: number | undefined;
  /** After the app launches, relaunches, or closes, or a link opens into it. Default: the `default` budget. */
  readonly launch?: number | undefined;
}

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
   * Device to use: a simulator or emulator by name, simulator UDID, or
   * emulator serial (`emulator-5554`), or a connected phone by name. A list
   * is a pool: the engine declares one worker per entry and worker slot `n`
   * drives the `n`th, so `workers` at or above the pool size runs the target's
   * files across every device at once. Omitted, the pool is every booted device
   * of the platform at `prepare` that no other agent-device session holds, as
   * many as the run has slots. A paired iPhone or iPad that is reachable (USB or network) counts as booted and
   * joins the pool. With none booted, agent-device boots a shut-down one: on
   * iOS an iPhone over an iPad over an Apple TV, on Android a phone or tablet
   * over a TV, then the newest OS, then name order (a stopped Android emulator
   * reports no OS version, so the name decides). With every booted one held,
   * `prepare` fails. A `DeviceProvider` leases hosted devices
   * instead: one per worker slot at `prepare`, each driven through the daemon
   * and client configuration the lease names. A replacement worker resumes a
   * healthy agent-device session on the same lease. Forced worker shutdown
   * can close the session. `device.closeApp()` ends the agent-device session,
   * allowing another session to take the device. If agent-device has not
   * confirmed a recording stop, the engine resets the recording before the
   * next attempt. This reset also ends the session. The provider lease stays
   * held until run end. At run end, the engine closes its sessions and the
   * provider releases its leases.
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
   * back before the agent observes again, in milliseconds; `false` skips the
   * wait. The wait keeps that observation off a transition frame; the runner's
   * own polling (`expect`, actions waiting for their node) covers the rest,
   * so a short window suffices. Default 150.
   * Every frame of a running animation changes the tree, so a 150 ms
   * window still catches a transition in flight; raise it for slow devices
   * or apps that settle in stages, or lower it to 0 to keep only the first
   * re-observation. A test's steps do not settle, except `device.back()`:
   * `expect` verifies their outcome, and `transition` covers a control that is
   * still arriving.
   */
  readonly settle?: number | false | undefined;
  /**
   * How long a control that appeared or moved with the last action is given
   * to finish arriving before a test acts on it, in milliseconds. Default
   * 500, the length of a modal or screen transition. Accessibility bounds
   * cannot tell a sliding control from a landed one (iOS reports the final
   * frame at once, Android the frame in flight), so the control is found
   * again in a fresh snapshot once the wait is over and acted on where it
   * landed. Unmoved controls are acted on immediately only when keyboard
   * visibility is unchanged. Opening or closing the keyboard also uses the
   * remaining budget. Screen swipes in tests wait out the remaining budget
   * before scrolling. Raise it for slower transitions. A number is that
   * budget after every action. An object sets it by the kind of the last
   * action: `default` for any action except a gesture or a launch, `gesture`
   * after a scroll or swipe, `launch` after the app launches, relaunches, or
   * closes, or a link opens into it. A `gesture` or `launch` budget left out
   * takes the `default` one. A scroll or swipe can return while its content
   * still moves, and the tree shows that content in flight, so the `gesture`
   * budget is only the least wait. A control that arrived or moved with the
   * gesture is then read until it stops moving, which is two reads that
   * agree on where it and any control that looks like it sit, at most 4 s
   * after the gesture, or at the budget when that is larger, or sooner when
   * the action's own timeout cannot fit another read. A plain number sets the
   * `gesture` budget too. A budget of 0 is no wait at all. After any other
   * action the budget is the whole wait.
   */
  readonly transition?: number | TransitionBudgets | undefined;
  /**
   * Whether a video recording draws agent-device's touch indicator where a
   * test tapped. Default `true`. `false` records the plain screen, and skips
   * the pass that draws the indicator once the recording stops: on a hosted
   * daemon such as Expo Simulators' that pass can outlast the attempt's
   * `cleanupTimeout`.
   */
  readonly videoTouches?: boolean | undefined;
}
