/**
 * What the device engine is given: its options, and the agent-device client
 * it drives them through. Shared by the surface (one session per worker) and
 * the pool (the target's devices, one per worker slot).
 */

import type { createAgentDeviceClient } from 'agent-device';
import type { DeviceLease, DeviceProvider } from './provider.ts';

export type AgentDeviceClient = ReturnType<typeof createAgentDeviceClient>;

/**
 * Mints the agent-device client for one session, against a leased daemon
 * when a provider supplied one, else the local daemon; the seam unit tests
 * script.
 */
export type ClientFactory = (session: string, daemon?: DeviceLease['daemon']) => AgentDeviceClient;

export type AgentDevicePlatform = 'ios' | 'android';

/**
 * Options of the device engine. Every optional value also accepts `undefined`,
 * so values read straight from `process.env` need no conditional spread.
 */
export interface AgentDeviceOptions {
  /** Platform the target's device runs. */
  readonly platform: AgentDevicePlatform;
  /**
   * App opened fresh at the start of every attempt: a bundle id, a package
   * name, or a display name agent-device resolves (`Settings`). Without it the
   * surface observes whatever is in the foreground, and `app.restart()` and
   * `app.clearState()` are not available.
   */
  readonly app?: string | undefined;
  /**
   * Build to install on the device once per worker, before the first attempt:
   * an iOS `.app` bundle or an Android `.apk`, resolved against the project
   * root (the config's directory). Without `app`, the installed bundle id or
   * package becomes the app opened fresh at the start of every attempt.
   */
  readonly appPath?: string | undefined;
  /**
   * Stable identity keying trace cache and session entries; defaults to `app`,
   * else `appPath`. Declare one when the pinned app differs per run (a build
   * path with a version in it) so entries survive the rename.
   */
  readonly identity?: string | undefined;
  /** Report label joining the cache identity; a simulator or emulator defaults to `test`. */
  readonly environment?: 'test' | 'staging' | 'production' | undefined;
  /**
   * Simulator or emulator to use, by name or UDID. A list is a pool: the
   * engine declares one worker per entry and worker slot `n` drives the
   * `n`th, so `workers` at or above the pool size runs the target's files
   * across every device at once. Omitted, the pool is every booted device of
   * the platform at `prepare`, as many as the run has slots; with none booted,
   * agent-device boots one. A `DeviceProvider` leases hosted devices instead:
   * one per worker slot at `prepare`, each driven through the daemon the
   * lease names, all released when the run ends.
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
   * How long the UI must hold still after a tap, fill, or back before the
   * action counts as landed, in milliseconds; `false` skips the wait. The
   * wait keeps the observation that follows an action off a transition
   * frame; the runner's own polling (`expect`, actions waiting for their
   * node) covers the rest, so a short window suffices. Default 150. Every
   * frame of a running animation changes the tree, so a 150 ms window still
   * catches a transition in flight; raise it for slow devices or apps that
   * settle in stages, or lower it to 0 to keep only the first re-observation.
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
}
