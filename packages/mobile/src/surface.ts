/**
 * The agent-device surface: one simulator or emulator session, driven through
 * agent-device's typed client, exposed to the runner as the contract's
 * observe/locate/perform members. It owns the id space (one fresh generation
 * per observation), the attempt state (artifact directory, screenshot
 * counter), and every translation between the contract's vocabulary and
 * agent-device's commands. Its device and session come from the target's
 * `DevicePool`, by worker slot. The runner owns everything else.
 *
 * Every observation is reported under one root of a stable id (`ROOT_ID`)
 * wrapping the device's top-level elements; a `swipe` performed on that root
 * scrolls the whole screen.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppDeployResult, CaptureSnapshotResult } from 'agent-device';
import {
  EngineError,
  KEY_NAMES,
  parseKey,
  raceAbort,
  rejectUnknownKeys,
  stopProviderRecording,
  withinCleanupBudget,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EngineSnapshot,
  type EngineAppInfo,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type ProviderRecording,
  type VideoSegment,
  type SemanticNode,
  type ViewportPoint,
  type ViewportSize,
  ConfigurationError,
  TestError,
} from 'e2e/engine';
import { isNoSessionApp, isSnapshotPresentationFailure, runCommand, staleOr } from './errors.ts';
import { pointerInteraction, DEFAULT_LONG_PRESS_MS } from './actions.ts';
import { resolveExpression } from './locate.ts';
import {
  isWithin,
  projectSnapshot,
  ROOT_ID,
  screenRoot,
  screenTitle,
  type ProjectedNode,
  type ProjectedSnapshot,
} from './nodes.ts';
import { DEVICE_PERMISSIONS, type AgentDeviceClient, type ClientFactory, type DevicePermission, type LaunchPermissions, type MobileOptions, type PermissionState } from './options.ts';
import { maskPng } from './png.ts';
import { deviceLabel, pinnedApp, type SlotBinding } from './bindings.ts';
import { assertAppId } from './links.ts';
import { DevicePool, deviceSelection, type DeviceSelection } from './pool.ts';
import { recordLease, travelledLease, type DeviceLease, type RecordingDeviceProvider } from './provider.ts';
import {
  invalidState,
  notActionable,
  logicalScreenSize,
  readPngSize,
  sanitizeFilename,
  screenLocation,
  type RawScreenshotResult,
  swipeWithin,
  unsupported,
  type Rect,
  type Point,
} from './support.ts';

/** Hinge poses `device.fold` accepts: `closed` lights the outer display, `half-open` and `open` the inner one. */
export type FoldPose = 'closed' | 'half-open' | 'open';

/** How `installApp` puts a build on the device. */
export interface InstallAppOptions {
  /**
   * Bundle id or package of the build. `reinstall` needs one: agent-device
   * removes that app before installing. Defaults to the pinned app.
   */
  readonly app?: string;
  /** Remove the installed app first so the build starts with no data. */
  readonly reinstall?: boolean;
}

/** What an install put on the device, as agent-device identified it. */
export interface InstalledApp {
  /** The bundle id or package to open the app by. */
  readonly app: string;
  readonly bundleId?: string;
}

/** Why nothing is pinned with `appPath` alone: the install is the suite's. */
const UNINSTALLED_BUILD = "the build the target's `app.appPath` names installed first with `device.installApp()`";

/**
 * The install fields this engine reads off agent-device's response. Its
 * `app` is left out: it echoes the `app` passed in, else the identity, else
 * the build's path, so it cannot tell an id from a file.
 */
type InstallIdentity = Pick<AppDeployResult, 'appId' | 'bundleId' | 'package'>;

/** How `device.openApp` launches an app. */
export interface OpenAppOptions {
  /** Terminate the app first, so it starts fresh; without it a running app is brought forward as it is. */
  readonly relaunch?: boolean;
  /**
   * Arguments this launch hands the app: its process arguments on iOS,
   * `am start` arguments on Android. Replaces the target's
   * `app.launchArguments` for a relaunch of the pinned app.
   */
  readonly launchArguments?: readonly string[];
  /**
   * Permissions the app holds before this launch, each granted, denied, or
   * reset. Replaces the target's `app.permissions` for a relaunch of the
   * pinned app.
   */
  readonly permissions?: LaunchPermissions;
}

/**
 * The snapshot fields this engine reads off agent-device's response. `keyboard`
 * is the band the capture's producer measured: `visible` with its frame,
 * `absent`, or that it could not look.
 */
type RawSnapshot = Partial<Pick<CaptureSnapshotResult, 'nodes' | 'truncated' | 'appName' | 'appBundleId' | 'snapshotQuality' | 'keyboard'>>;

/** Platform element types that are the soft keyboard or one of its keys, as agent-device names them. */
const KEYBOARD_TYPES: ReadonlySet<string> = new Set(['keyboard', 'key']);

/**
 * How far the dismissing drag travels, as a share of the viewport: short
 * enough that a list under the finger barely moves, long enough for a scroll
 * view to read it as a drag and let go of the keyboard. The same ratio
 * Maestro's `hideKeyboard` uses.
 */
const KEYBOARD_DRAG_RATIO = 0.03;

/**
 * Whether a capture shows the soft keyboard: the band its producer measured
 * when it measured one, else a keyboard or key element in the tree, the probe
 * Maestro's `hideKeyboard` uses. A capture that says nothing either way
 * counts as no keyboard: a drag on a guess costs more than a keyboard a later
 * tap refuses against by name.
 */
function keyboardShowing(raw: RawSnapshot): boolean {
  if (raw.keyboard?.kind === 'visible') return true;
  if (raw.keyboard?.kind === 'absent') return false;
  return (raw.nodes ?? []).some((node) => KEYBOARD_TYPES.has((node.type ?? '').toLowerCase()));
}

/**
 * Whether a snapshot leaves out nodes that are on screen: agent-device says
 * it cut the tree, or the tree is still sparse after the retries (one
 * application node while the app publishes its tree). The harness never
 * calls such a screen unchanged, and the trace cache records the flag.
 */
function isTruncated(raw: RawSnapshot): boolean {
  return raw.truncated === true || raw.snapshotQuality?.state === 'sparse';
}

/** Action data only: located references never retain a projected snapshot through parent links. */
interface NodeBinding {
  readonly id: string;
  readonly ref: string;
  readonly node: SemanticNode;
  readonly controlRef: string;
}


/**
 * How long a control that appeared or moved with the last action is given to
 * finish arriving before a test acts on it. The tree cannot tell a sliding
 * control from a landed one: iOS reports the final frame the moment a
 * transition starts, Android the frame in flight, so a modal or pushed screen
 * keeps sliding for about half a second after the action that opened it and
 * a tap aimed from either frame lands on whatever is behind the control.
 * Once the budget has passed the control is found again in a fresh
 * snapshot. Controls that were already on screen at the same place before
 * the action are acted on at once.
 */
const DEFAULT_TRANSITION_MS = 500;

/** The centre of a rect in logical pixels. */
function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Whether two rects are the same to the pixel; a missing rect never matches, so a target must be measurable to be stable. */
function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

const MAX_LOCATED_REFS = 2048;

interface Attempt {
  readonly attemptId: string;
  readonly artifactsDir: string;
  screenshots: number;
  /**
   * The recording the device was asked for. Marked before the start command
   * goes out, since a start that outlives its budget still records, and
   * cleared only once a stop succeeded: either way `endAttempt` can stop it.
   */
  video: Recording | undefined;
}

/** One recording of the device: agent-device's screen recording, or the device provider's own. */
type Recording = ScreenRecording | LeaseRecording;

/** agent-device's screen recording: where its file lands, and when the device confirmed it was on. */
interface ScreenRecording {
  readonly kind: 'screen';
  readonly relative: string;
  readonly absolute: string;
  startedAt: string;
}

/** The device provider's recording of the leased device, as its `record` is starting it or started it. */
interface LeaseRecording {
  readonly kind: 'lease';
  readonly recorder: LeaseRecorder;
  readonly started: Promise<ProviderRecording>;
  /** The stop in flight, shared: a retry while a stop that ran out of budget is still running waits for it instead of stopping twice. */
  stopping?: Promise<VideoSegment> | undefined;
}

/** What a worker records its device through when its provider records: the provider, and the lease the slot rides. */
interface LeaseRecorder {
  readonly provider: RecordingDeviceProvider;
  readonly lease: DeviceLease;
  readonly runId: string;
  readonly targetName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The Apple runner defers a full snapshot after slow accessibility work and
 * returns a sparse one-node tree. Retrying device-side costs under a second;
 * returning the sparse tree costs the model a confused turn.
 */
const SPARSE_RETRY_BACKOFF_MS = [0, 1_200, 3_000] as const;

/** Number of parent hops from `entry` up to `ancestor`. */
function depthBelow(entry: ProjectedNode, ancestor: ProjectedNode): number {
  let hops = 0;
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    hops += 1;
    if (current === ancestor) return hops;
  }
  return hops;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** What agent-device is told about settling after an action. */
type SettleOptions = { readonly settle: true; readonly settleQuietMs: number } | Record<never, never>;

const DEFAULT_SETTLE_QUIET_MS = 150;

/** Every option `mobile()` takes, kept equal to `MobileOptions` by the compiler. */
const MOBILE_OPTION_KEYS: readonly string[] = Object.keys({
  platform: true,
  device: true,
  session: true,
  snapshot: true,
  settle: true,
  transition: true,
  videoTouches: true,
} satisfies Record<keyof MobileOptions, true>);

/** Every state a permission takes, kept equal to `PermissionState` by the compiler. */
const PERMISSION_STATES: readonly string[] = Object.keys({ grant: true, deny: true, reset: true } satisfies Record<PermissionState, true>);

/**
 * Refuses a permissions map before any device command: anything but a plain
 * object, a name agent-device
 * does not set, naming the nearest, or a state other than grant, deny, or
 * reset. `INVALID_CONFIG` for a target's `app.permissions`, `INVALID_ARGUMENT`
 * for a test's `device.openApp`. An `undefined` state is skipped, as the preset
 * skips it.
 */
export function assertPermissions(label: string, permissions: unknown, code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT'): void {
  const fail = (message: string): never => {
    throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
  };
  // A Map or class instance carries no own keys to check, and the preset would apply none of it.
  const prototype: unknown = typeof permissions === 'object' && permissions !== null ? Object.getPrototypeOf(permissions) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object of permission names to ${PERMISSION_STATES.join(', ')}`);
  }
  rejectUnknownKeys(label, permissions as object, DEVICE_PERMISSIONS, code);
  for (const [name, state] of Object.entries(permissions as Record<string, unknown>)) {
    if (state !== undefined && !PERMISSION_STATES.includes(state as string)) {
      fail(`${label}.${name} must be one of ${PERMISSION_STATES.join(', ')}, got ${typeof state === 'string' ? `"${state}"` : String(state)}`);
    }
  }
}

/** Resolves the `transition` option: the default budget or a custom one. */
function transitionMs(transition: MobileOptions['transition']): number {
  const budget = transition ?? DEFAULT_TRANSITION_MS;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobile: `transition` must be a non-negative integer of milliseconds');
  }
  return budget;
}

/** Resolves the `settle` option: the default window, a custom one, or no wait at all. */
function settleOptions(settle: MobileOptions['settle']): SettleOptions {
  if (settle === false) return {};
  const quietMs = settle ?? DEFAULT_SETTLE_QUIET_MS;
  if (!Number.isInteger(quietMs) || quietMs < 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobile: `settle` must be a non-negative integer of milliseconds, or false');
  }
  return { settle: true, settleQuietMs: quietMs };
}

export class AgentDeviceSurface {
  private client: AgentDeviceClient | undefined;
  private attempt: Attempt | undefined;
  /** The device this worker drives, the pool's binding for its slot; undefined leaves the choice to agent-device. */
  private device: Pick<SlotBinding, 'device' | 'deviceId'> | undefined;
  private generation = new Map<string, NodeBinding>();
  private readonly located = new Map<string, NodeBinding>();
  private idCounter = 0;
  private appIdentity: string | undefined;
  /**
   * The app this worker's agent-device session is on, and so the app a
   * permission command there acts on: what the warm-up in `prepare` opened
   * under the session this worker resumed, while that session is still open,
   * then whatever this surface last opened. Undefined while nothing has been opened in the session, and once
   * `closeApp` ended it.
   */
  private sessionApp: string | undefined;
  /** The app the build `appPath` installed, once `init` has, itself or through a lease. */
  private installedApp: string | undefined;
  /** The target's app, as `init` received it. */
  private app: EngineAppInfo = {};
  /** Where relative build paths resolve; the run's project root once init has told us. */
  private projectRoot = process.cwd();
  /** The session and device this worker drives, for the error messages whose recovery is per device; set in init. */
  private where: string | undefined;
  /** How this worker's device records through its provider: set in init when the pool's provider records and the slot rides one of its leases. */
  private leaseRecorder: LeaseRecorder | undefined;
  /**
   * Commands still running on the device. agent-device takes no abort
   * signal, so a cancelled or timed-out call is only abandoned by its
   * caller; it keeps executing. The next attempt waits for these to settle
   * before it opens anything, so a ghost tap can never land in a retry.
   */
  private readonly inflight = new Set<Promise<unknown>>();

  /** The target's devices, one per worker slot; `init` takes this worker's from it. */
  readonly pool: DevicePool;
  /** The settle wait every action carries: quiet window from the `settle` option, or nothing when it is `false`. */
  readonly settleOptions: SettleOptions;
  /** When this surface last acted on the device (an input or an app launch); the screen may be in transition for a while after. */
  private lastActionAt = 0;
  /** The screen as last projected before that action, to tell controls that were already there from ones that came with it. */
  private indexBeforeAction: readonly ProjectedNode[] | undefined;
  /** The most recent projection of the screen, from any observe or locate. */
  private latestIndex: readonly ProjectedNode[] | undefined;
  /** Budget a control that came with the last action gets to finish arriving; see DEFAULT_TRANSITION_MS. */
  private readonly transitionMs: number;
  /**
   * The screen's logical size as last learned from a snapshot with geometry
   * or from the device itself, so a snapshot without geometry (an empty
   * screen before any app is open, a sparse tree) still reports the viewport
   * every observation must carry.
   */
  private knownViewport: ViewportSize | undefined;

  constructor(
    readonly options: MobileOptions,
    private readonly createClient: ClientFactory,
  ) {
    rejectUnknownKeys('mobile()', options, MOBILE_OPTION_KEYS);
    this.pool = new DevicePool(options, createClient);
    this.settleOptions = settleOptions(options.settle);
    this.transitionMs = transitionMs(options.transition);
  }

  /** Whether the target pins an app for `app.open()`, `app.restart()`, and `app.clearState()` to launch. */
  private get managesApp(): boolean {
    return this.app.bundleId !== undefined || this.app.appPath !== undefined;
  }

  /** The app `app.open()` launches: the target's `bundleId`, else the app its build `appPath` installed. */
  get pinnedApp(): string | undefined {
    return pinnedApp(this.app, this.installedApp);
  }

  /** The build the target's `app.appPath` names, as declared. */
  get appPath(): string | undefined {
    return this.app.appPath;
  }

  /** Whether an attempt is running on this surface right now. */
  get attemptRunning(): boolean {
    return this.attempt !== undefined;
  }

  /** The live client; INVALID_STATE before init or after dispose. */
  requireClient(): AgentDeviceClient {
    if (this.client === undefined) throw invalidState('the agent-device engine is not initialized');
    return this.client;
  }

  /**
   * Runs one agent-device command under an operation budget and translates
   * its failure. Contributed-fixture methods route through here too, so the
   * device fixture never carries its own error mapping.
   */
  async command<T>(label: string, run: (client: AgentDeviceClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = this.requireClient();
    return runCommand(label, () => this.track(run(client)), signal ?? new AbortController().signal, this.where);
  }

  /**
   * Runs a fixture command that changes the screen (a back, the home screen,
   * a dismissed alert or keyboard, a rotation) and records it as an action,
   * so a control that arrives with the change waits out the transition
   * budget before a test acts on it, as it does after a tap. Without this a
   * `device.back()` followed by a tap lands where the returning screen has
   * not yet arrived.
   */
  async screenCommand<T>(label: string, run: (client: AgentDeviceClient) => Promise<T>, signal: AbortSignal): Promise<T> {
    const before = this.latestIndex;
    const result = await this.command(label, run, signal);
    this.markAction(before);
    return result;
  }

  /** Registers one device command as in flight until it settles. */
  private track<T>(pending: Promise<T>): Promise<T> {
    this.inflight.add(pending);
    pending.then(
      () => this.inflight.delete(pending),
      () => this.inflight.delete(pending),
    );
    return pending;
  }

  /**
   * Waits for every abandoned command to settle, within the caller's
   * budget. A command that never settles fails the attempt launch instead of
   * racing it: the launch timeout is the honest bound on a stuck device.
   */
  private async settleInflight(signal: AbortSignal): Promise<void> {
    while (this.inflight.size > 0) {
      await raceAbort(Promise.allSettled(this.inflight), signal, 'settling in-flight device commands');
    }
  }

  /** The device selection this worker's commands take. */
  private selection(): DeviceSelection {
    return deviceSelection(this.options.platform, this.device);
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.app = info.app;
    const binding = this.pool.binding(info.targetName, info.workerSlot, info.env);
    this.device = binding;
    const session = this.pool.session(info.targetName, info.workerSlot);
    const label = deviceLabel(binding);
    this.where = `session ${session}${label === undefined ? '' : ` on ${label}`}`;
    this.client ??= this.createClient(session, binding);
    const provider = this.pool.recorder;
    const lease = travelledLease(binding);
    this.leaseRecorder =
      provider === undefined || lease === undefined
        ? undefined
        : { provider, lease, runId: info.runId, targetName: info.targetName, env: info.env };
    await this.command('boot', (client) => client.devices.boot(this.selection()), info.signal);
    this.sessionApp = binding?.sessionApp === undefined ? undefined : await this.resumedSessionApp(session, binding.sessionApp, info.signal);
    // Nothing is installed here: a device provider that installed the build
    // from `appPath` says so on the binding, and otherwise the suite installs
    // it where it wants to, with `device.installApp()`.
    this.installedApp = binding?.installedApp;
  }

  /**
   * The app the warm-up left the slot's session on, while agent-device still
   * holds that session. Only the slot's first worker finds it: a worker
   * retired after a failing test closed it in `dispose`, and a permission
   * command on a closed session reaches no device. A session not listed, or
   * a list that fails, leaves the app unknown, and the first permission
   * change opens it again.
   */
  private async resumedSessionApp(session: string, app: string, signal: AbortSignal): Promise<string | undefined> {
    const sessions: unknown = await this.command('sessions', (client) => client.sessions.list(), signal).catch((cause: unknown) => {
      if (signal.aborted) throw cause;
      return undefined;
    });
    if (!Array.isArray(sessions)) return undefined;
    const open = sessions.some((entry: { name?: unknown; address?: unknown }) => (entry.address ?? entry.name) === session);
    return open ? app : undefined;
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) {
      throw invalidState('an attempt is already running on this agent-device engine');
    }
    await this.settleInflight(context.signal);
    // Nothing is launched here: the app is where the last test, or the
    // worker's `prepare`, left it, and a test that wants it fresh calls
    // `app.open()`, which is `restart` below. The bindings are forgotten, the
    // screen is not, so a control still in place is acted on at once.
    this.attempt = { attemptId: context.attemptId, artifactsDir: context.artifactsDir, screenshots: 0, video: undefined };
    this.generation = new Map();
    this.located.clear();
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const attempt = this.attempt;
    const dangling = attempt?.video;
    this.attempt = undefined;
    this.generation = new Map();
    this.located.clear();
    // The harness stops the video before it ends the attempt; a recording still
    // marked here belongs to an attempt cut short, or to a stop that failed,
    // and the device must not keep recording into the next one. A start that
    // outlived its budget may still be landing: it settles first, so the stop
    // cannot overtake it.
    if (attempt !== undefined && dangling?.kind === 'lease') {
      await this.stopLeaseRecording(dangling, attempt.artifactsDir, context.signal).catch(() => undefined);
    } else if (dangling !== undefined) {
      await this.settleInflight(context.signal).catch(() => undefined);
      await this.stopScreenRecording(context.signal).catch(() => undefined);
    }
  }

  // --- video ---

  /**
   * Asks the device to record its screen into the attempt directory. Taps stay
   * visible in the recording (agent-device's touch indicator), which is the
   * closest a phone comes to a cursor, unless `videoTouches` is `false`. A
   * device provider that records its devices records the attempt instead,
   * when the slot rides one of its leases.
   */
  async startVideo(operation: OperationContext): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('startVideo outside an attempt');
    if (attempt.video !== undefined) throw invalidState('a video is already recording');
    if (this.leaseRecorder !== undefined) {
      await this.startLeaseRecording(attempt, this.leaseRecorder, operation.signal);
      return;
    }
    const relative = path.join('video', 'video.mp4');
    const absolute = path.join(attempt.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    // Marked before the device is asked: a start that outlives its budget
    // still records, and `endAttempt` must be able to stop it.
    const recording: ScreenRecording = { kind: 'screen', relative, absolute, startedAt: new Date().toISOString() };
    attempt.video = recording;
    await this.command(
      'start video recording',
      // The whole screen: an app scope refuses to start while no app is open, before `app.open()` and after `closeApp()`.
      (client) =>
        client.recording.record({
          action: 'start',
          path: absolute,
          quality: 'medium',
          recordingScope: 'device',
          ...(this.options.videoTouches === false ? { hideTouches: true } : {}),
        }),
      operation.signal,
    );
    // The device confirmed: it is recording from about now.
    recording.startedAt = new Date().toISOString();
  }

  /** Stops the recording and returns its one segment, or none when the device wrote nothing. */
  async stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('stopVideo outside an attempt');
    const video = attempt.video;
    if (video === undefined) return [];
    if (video.kind === 'lease') {
      const segment = await this.stopLeaseRecording(video, attempt.artifactsDir, operation.signal);
      // Cleared only now: a stop that failed leaves the recording for `endAttempt`.
      attempt.video = undefined;
      return [segment];
    }
    const result = await this.stopScreenRecording(operation.signal);
    // Cleared only now: a stop that failed leaves the recording for `endAttempt`.
    attempt.video = undefined;
    // The device may finalize the file under a path of its own choosing; the
    // artifact must live where the attempt directory expects it.
    const written = typeof result.outPath === 'string' ? result.outPath : video.absolute;
    if (written !== video.absolute && existsSync(written)) renameSync(written, video.absolute);
    if (!existsSync(video.absolute)) return [];
    return [{ path: video.relative, startedAt: video.startedAt }];
  }

  /**
   * Stops the device's screen recording. A device-scope recording started
   * with no session made one of its own, and stopping it ends that session,
   * whatever the test opened in it since, so the session is then as
   * `closeApp` leaves it.
   */
  private async stopScreenRecording(signal: AbortSignal): Promise<{ readonly outPath?: unknown }> {
    const result = await this.command('stop video recording', (client) => client.recording.record({ action: 'stop' }), signal);
    if (result.recordOnlySession === true) {
      this.sessionApp = undefined;
      this.screenReplaced();
    }
    return result;
  }

  /**
   * Starts the device provider's recording of the leased device. Marked
   * the moment `record` is called, before it settles, as the screen
   * recording is before its start command: a start that outlives its budget
   * may still come up, and `endAttempt` then stops it.
   */
  private async startLeaseRecording(attempt: Attempt, recorder: LeaseRecorder, signal: AbortSignal): Promise<void> {
    const { provider, lease, runId, targetName, env } = recorder;
    const started = recordLease(provider, lease, { runId, targetName, attemptId: attempt.attemptId, env, signal });
    attempt.video = { kind: 'lease', recorder, started };
    await raceAbort(started, signal, 'start video recording');
  }

  /** Ends the provider's recording as the attempt's one segment, a file in its `video` directory or a link. */
  private async stopLeaseRecording(video: LeaseRecording, artifactsDir: string, signal: AbortSignal): Promise<VideoSegment> {
    const { provider, lease } = video.recorder;
    video.stopping ??= (async () =>
      stopProviderRecording(await video.started, { artifactsDir, provider: `device provider "${provider.name}"`, leaseId: lease.id, signal }))().finally(() => {
      video.stopping = undefined;
    });
    return raceAbort(video.stopping, signal, 'stop video recording');
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    const client = this.client;
    const attempt = this.attempt;
    // A worker torn down mid-attempt must not leave the provider recording the device.
    if (attempt?.video?.kind === 'lease') {
      await withinCleanupBudget(this.stopLeaseRecording(attempt.video, attempt.artifactsDir, context.signal), context).catch(() => undefined);
    }
    this.client = undefined;
    this.attempt = undefined;
    this.generation = new Map();
    this.located.clear();
    this.appIdentity = undefined;
    this.sessionApp = undefined;
    this.installedApp = undefined;
    this.knownViewport = undefined;
    if (client === undefined) return;
    await withinCleanupBudget(client.sessions.close().catch(() => undefined), context);
  }

  /**
   * Opens an app in the session, remembering its identity for the path
   * anchor. A link is refused before the device sees it: agent-device would
   * open it as a URL, and `openLink` is the path that carries the
   * navigation rule.
   */
  async openApp(app: string, options: OpenAppOptions, signal: AbortSignal): Promise<void> {
    assertAppId(app);
    if (options.permissions !== undefined) assertPermissions('device.openApp({ permissions })', options.permissions, 'INVALID_ARGUMENT');
    const relaunch = options.relaunch === true;
    // The engine's own launch options belong to a fresh launch of the pinned
    // app. A foreground-only open of a running app takes no arguments, and a
    // permission change there would terminate the app it means to keep.
    const configured = relaunch && app === this.pinnedApp;
    const launchArguments = options.launchArguments ?? (configured ? this.app.launchArguments : undefined);
    const permissions = options.permissions ?? (configured ? this.app.permissions : undefined);
    if (permissions !== undefined) await this.presetPermissions(app, permissions, signal);
    await this.open(app, relaunch, launchArguments, signal);
  }

  /** One `open` of an app, remembered as the session's app and as the screen's replacement. */
  private async open(app: string, relaunch: boolean, launchArguments: readonly string[] | undefined, signal: AbortSignal): Promise<void> {
    const result = await this.command(
      `open ${app}`,
      (client) =>
        client.apps.open({
          app,
          ...this.selection(),
          ...(relaunch ? { relaunch: true } : {}),
          ...(launchArguments === undefined || launchArguments.length === 0 ? {} : { launchArgs: [...launchArguments] }),
        }),
      signal,
    );
    this.sessionApp = app;
    this.launched(result.appBundleId ?? result.appName ?? app);
  }

  /**
   * Puts an app's permissions in place before it launches. agent-device sets
   * a permission on the app its session is on, so a session on another app,
   * or on none yet, is first brought onto this one with a foreground open;
   * the warm-up in `prepare` did that for the pinned app under the session
   * this worker resumed, so its first launch needs none. Before the launch,
   * never after: iOS terminates a running app whose
   * permission changed, and Android one whose permission was revoked, so a
   * change after the launch would leave the test on no screen.
   */
  private async presetPermissions(app: string, permissions: LaunchPermissions, signal: AbortSignal): Promise<void> {
    const entries = Object.entries(permissions).filter(
      (entry): entry is [DevicePermission, PermissionState] => entry[1] !== undefined,
    );
    if (entries.length === 0) return;
    if (this.sessionApp !== app) await this.open(app, false, undefined, signal);
    for (const [permission, state] of entries) await this.permission(permission, state, signal);
  }

  /**
   * One permission change for `device.setPermission`: on the app the session
   * is on, which is what agent-device acts on. With none known here (nothing
   * opened yet, `closeApp`, a worker resumed on a bare session) the pinned
   * app is brought to the foreground first. agent-device's own refusal, met
   * when its session lost the app since (a failed attempt left it on none),
   * gets the same foreground open and the command once more.
   */
  async setPermission(permission: DevicePermission, state: PermissionState, signal: AbortSignal): Promise<void> {
    const app = this.pinnedApp;
    if (this.sessionApp === undefined && app !== undefined) await this.open(app, false, undefined, signal);
    try {
      await this.permission(permission, state, signal);
    } catch (cause) {
      if (signal.aborted || app === undefined || !isNoSessionApp(cause)) throw cause;
      await this.open(app, false, undefined, signal);
      await this.permission(permission, state, signal);
    }
  }

  private async permission(permission: DevicePermission, state: PermissionState, signal: AbortSignal): Promise<void> {
    await this.command(
      `permission ${permission} ${state}`,
      (client) => client.settings.update({ setting: 'permission', permission, state }),
      signal,
    );
  }

  /**
   * Opens a link on the device, into `app` (the pinned app when none is
   * named). Bound to an app, agent-device hands the link to it and the
   * session observes that app afterwards: iOS launches the app first for a
   * web link and then opens the URL, Android starts a VIEW intent on the
   * package. Without an app the OS routes the link to the scheme's app, a
   * verified app link owner, or the browser. iOS needs the app: an unbound
   * `open <url>` there leaves no app session, so the next snapshot would
   * fail, and agent-device refuses a deep link without one on a physical
   * device anyway. An unbound open reports the URL as its app name, which is
   * no identity, and the package that took the link as its bundle id when
   * the OS told it; the next snapshot names the foreground app either way.
   */
  async openLink(url: URL, app: string | undefined, signal: AbortSignal): Promise<void> {
    const target = app ?? this.pinnedApp;
    if (target === undefined && this.options.platform === 'ios') {
      throw new TestError(
        'INVALID_ARGUMENT',
        "openLink needs an app on iOS: pass `app`, or pin one with the target's app.bundleId or app.appPath; the session observes the app a link is opened into",
      );
    }
    const result = await this.command(
      'device.openLink',
      (client) =>
        client.apps.open({
          ...this.selection(),
          ...(target === undefined ? { app: url.href } : { app: target, url: url.href }),
        }),
      signal,
    );
    this.sessionApp = target;
    this.launched(result.appBundleId ?? (target === undefined ? undefined : (result.appName ?? target)));
  }

  /**
   * What a launch leaves behind. The identity is the app agent-device named;
   * a link the OS routed keeps the last known one until the next snapshot
   * reports the foreground app.
   */
  private launched(identity: string | undefined): void {
    if (identity !== undefined) this.appIdentity = identity;
    this.screenReplaced();
  }

  /**
   * Forgets the screen after a launch or a close. There is no screen before
   * it worth matching against: every control of whatever shows next is
   * arriving, whatever the previous screen looked like, and none of its
   * bindings names a node that still exists.
   */
  private screenReplaced(): void {
    this.markAction(undefined);
    this.generation = new Map();
    this.located.clear();
  }

  /**
   * Terminates the session's app, then ends the session. agent-device's bare
   * `close` ends the session and leaves the app running, so the next
   * `openApp` would resume it mid-flow; a close that names the app
   * terminates it first. The app is the one the session last observed, else
   * the pinned one; with neither known there is nothing to terminate and
   * only the session ends.
   */
  async closeApp(signal: AbortSignal): Promise<void> {
    const app = this.appIdentity ?? this.pinnedApp;
    await this.command('device.closeApp', (client) => client.apps.close(app === undefined ? {} : { app }), signal);
    this.sessionApp = undefined;
    this.screenReplaced();
  }

  /**
   * Installs a build on the session's device. `reinstall` removes the app
   * named by `options.app` (else the pinned app) first, so the build starts
   * with no data; a plain install replaces the binary and keeps its data.
   */
  async installApp(appPath: string | undefined, options: InstallAppOptions, signal: AbortSignal): Promise<InstalledApp> {
    const build = appPath ?? this.app.appPath;
    if (build === undefined) throw invalidState("installApp needs a build: pass a path, or name one with the target's app.appPath");
    const resolved = path.resolve(this.projectRoot, build);
    const selection = this.selection();
    const engineBuild = appPath === undefined || (this.app.appPath !== undefined && resolved === path.resolve(this.projectRoot, this.app.appPath));
    const app = options.app ?? (engineBuild ? this.app.bundleId : undefined) ?? (options.reinstall === true ? this.pinnedApp : undefined);
    if (options.reinstall === true && app === undefined) {
      throw invalidState("reinstall needs an app: pass `app`, or pin one with the target's app.bundleId or app.appPath");
    }
    const result: InstallIdentity = await this.command(
      `install ${resolved}`,
      (client) =>
        options.reinstall === true && app !== undefined
          ? client.apps.reinstall({ ...selection, app, appPath: resolved })
          : client.apps.install({ ...selection, ...(app === undefined ? {} : { app }), appPath: resolved }),
      signal,
    );
    const identity = result.bundleId ?? result.package ?? result.appId;
    const opensBy = identity ?? app;
    if (opensBy === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `installed ${resolved}, but agent-device reported no bundle id or package for it, so nothing can open it: name the app with the target's \`app.bundleId\` or installApp's \`app\` option`,
        { retryable: false },
      );
    }
    const installed: InstalledApp = { app: opensBy, ...(identity === undefined ? {} : { bundleId: identity }) };
    // The engine's own build, installed: without `app`, this is what `app.open()` launches from here on.
    if (engineBuild) this.installedApp = installed.app;
    return installed;
  }

  private async snapshot(signal: AbortSignal, interactiveOnly: boolean): Promise<RawSnapshot> {
    let last: RawSnapshot = {};
    for (const backoffMs of SPARSE_RETRY_BACKOFF_MS) {
      if (backoffMs > 0) await sleep(backoffMs, signal);
      if (signal.aborted) throw new EngineError('CANCELLED', 'snapshot cancelled', { retryable: false });
      last = await this.capture(signal, interactiveOnly);
      if (last.appBundleId !== undefined || last.appName !== undefined) {
        this.appIdentity = last.appBundleId ?? last.appName;
      }
      if (last.snapshotQuality?.state !== 'sparse') return last;
    }
    return last;
  }

  /**
   * One capture, taken again once when the iOS runner acquired the tree but
   * failed its own presentation check on it (a viewport it could not read, a
   * malformed graph). The check is per capture and a capture is a read, so
   * the retry is safe; a second failure is the runner's and propagates.
   */
  private async capture(signal: AbortSignal, interactiveOnly: boolean): Promise<RawSnapshot> {
    const take = (): Promise<RawSnapshot> =>
      this.command('snapshot', (client) => client.capture.snapshot({ interactiveOnly }), signal);
    try {
      return await take();
    } catch (cause) {
      if (signal.aborted || !isSnapshotPresentationFailure(cause)) throw cause;
      return take();
    }
  }

  /**
   * Snapshot for an observation. Without a pinned app, an observation before
   * anything is open is an empty screen rather than a fault: the model's next
   * move is the open tool, and failing the step would take that move away.
   */
  private async snapshotOrEmpty(operation: OperationContext, interactiveOnly: boolean): Promise<RawSnapshot> {
    try {
      return await this.snapshot(operation.signal, interactiveOnly);
    } catch (cause) {
      if (!this.managesApp && cause instanceof EngineError && cause.code === 'INVALID_STATE') return { nodes: [] };
      throw cause;
    }
  }

  private project(raw: RawSnapshot): ProjectedSnapshot {
    const projected = projectSnapshot(raw.nodes ?? [], {
      mintId: () => {
        this.idCounter += 1;
        return `n${this.idCounter}`;
      },
    });
    this.latestIndex = projected.index;
    if (projected.viewport !== undefined) this.knownViewport = projected.viewport;
    return projected;
  }

  /**
   * The viewport of a snapshot: its own geometry, else the last one this
   * session learned, else the device's logical screen size read off one
   * screenshot. A device whose size cannot be learned fails the observation:
   * the harness measures every rect and point against the viewport, so an
   * invented one would misplace every tap.
   */
  private async viewportFor(projected: ProjectedSnapshot, signal: AbortSignal): Promise<ViewportSize> {
    const known = projected.viewport ?? this.knownViewport;
    if (known !== undefined) return known;
    const probed = await this.probeViewport(signal);
    if (probed === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        'the device reported no screen geometry: the snapshot has no bounds and the screenshot no logical size, so the viewport is unknown',
        { retryable: false },
      );
    }
    this.knownViewport = probed;
    return probed;
  }

  /** The device's logical screen size as its screenshot reports it; undefined when it reports none. */
  private async probeViewport(signal: AbortSignal): Promise<ViewportSize | undefined> {
    const result = await this.captureScreenshot(signal, async (shot) => shot);
    return logicalScreenSize(result);
  }

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const raw = await this.snapshotOrEmpty(operation, this.options.snapshot === 'interactive');
    const projected = this.project(raw);
    this.generation = new Map(projected.index.map((entry) => [entry.id, this.bind(entry, projected.index)]));
    const viewport = await this.viewportFor(projected, operation.signal);
    const location = screenLocation(raw.appBundleId ?? raw.appName ?? this.appIdentity, screenTitle(projected));
    const capture = options?.pixels === true ? await this.capturePixels(operation, projected, viewport) : undefined;
    return {
      root: screenRoot(projected.roots, viewport),
      viewport,
      ...(isTruncated(raw) ? { truncated: true } : {}),
      ...(location === undefined ? {} : { location }),
      ...(capture === undefined ? {} : { pixels: capture.pixels, maskedRegionCount: capture.masked }),
    };
  }

  /** Retains only action bindings for matches, independently of the observation generation. */
  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const raw = await this.snapshotOrEmpty(operation, false);
    const projected = this.project(raw);
    const matches = resolveExpression(expression, projected.index);
    for (const entry of matches) this.located.set(entry.id, this.bind(entry, projected.index));
    for (const oldest of this.located.keys()) {
      if (this.located.size <= MAX_LOCATED_REFS) break;
      this.located.delete(oldest);
    }
    return matches.map((entry) => entry.node);
  }

  private resolveRef(ref: NodeRef): NodeBinding {
    const entry = this.located.get(ref.id) ?? this.generation.get(ref.id);
    if (entry === undefined) {
      throw new EngineError('NODE_STALE', `node ${ref.id} is not part of the newest observation`, { retryable: true });
    }
    return entry;
  }

  private actionTarget(entry: NodeBinding, control = false): { ref: string } {
    const ref = control ? entry.controlRef : entry.ref;
    if (ref === '') throw notActionable(`node ${entry.id} has no agent-device ref to act on`);
    return { ref: `@${ref}` };
  }

  /**
   * The node a toggle press must land on. UIKit reports a settings row as a
   * labelled `Switch` spanning the whole row with the real control as an
   * unlabelled `Switch` child at its trailing edge; a press at the row's
   * centre hits the label and changes nothing. The innermost same-role
   * descendant with a ref is the control; a node without one is its own.
   */
  private controlOf(entry: ProjectedNode, snapshot: readonly ProjectedNode[]): ProjectedNode {
    const role = entry.node.role;
    if (role !== 'switch' && role !== 'checkbox') return entry;
    let control = entry;
    let depth = 0;
    for (const candidate of snapshot) {
      if (candidate.ref === '' || candidate.node.role !== role || !isWithin(candidate, entry)) continue;
      const candidateDepth = depthBelow(candidate, entry);
      if (candidateDepth > depth) {
        control = candidate;
        depth = candidateDepth;
      }
    }
    return control;
  }

  /** Copies the fields actions use and pre-resolves a toggle's inner control. */
  private bind(entry: ProjectedNode, snapshot: readonly ProjectedNode[]): NodeBinding {
    const { children: _children, ...node } = entry.node;
    const control = this.controlOf(entry, snapshot);
    return { id: entry.id, ref: entry.ref, node, controlRef: control.ref };
  }

  /**
   * The node a binding stands for, in a fresh snapshot: same role, same test
   * id, same name and text, and of those the one closest to where it was.
   */
  private refind(entry: NodeBinding, index: readonly ProjectedNode[]): ProjectedNode | undefined {
    const candidates = index.filter(
      (candidate) =>
        candidate.node.role === entry.node.role &&
        candidate.node.testId === entry.node.testId &&
        candidate.node.name === entry.node.name &&
        candidate.node.text === entry.node.text,
    );
    if (candidates.length <= 1 || entry.node.rect === undefined) return candidates[0];
    const was = centreOf(entry.node.rect);
    let best = candidates[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.node.rect === undefined) continue;
      const at = centreOf(candidate.node.rect);
      const distance = Math.hypot(at.x - was.x, at.y - was.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Lets a control that came with the last action finish arriving before a
   * test acts on it, and answers the binding to act on. A control already
   * present at the same place in the snapshot the last action was resolved
   * from is not in transition and is acted on at once; anything else waits
   * out the remainder of the transition budget since that action and is then
   * found again in a fresh snapshot. The budget is the only signal that the
   * transition is over, since the tree cannot tell a sliding control from a
   * landed one; the fresh snapshot is where the control landed. Android
   * reports a window's frames while it slides in, so a ref resolved
   * mid-flight would send the action where the control was: below the
   * screen, for a modal rising from the bottom.
   */
  private async settled(entry: NodeBinding, operation: OperationContext): Promise<NodeBinding> {
    const since = Date.now() - this.lastActionAt;
    const remaining = this.transitionMs - since;
    if (remaining <= 0) return entry;
    const before = this.indexBeforeAction;
    if (before !== undefined) {
      const prior = this.refind(entry, before);
      if (prior !== undefined && sameRect(prior.node.rect, entry.node.rect)) return entry;
    }
    await sleep(remaining, operation.signal);
    // The sleep resolves on abort; the action behind it must not go out once
    // the caller has already been told the operation was cancelled.
    if (operation.signal.aborted) {
      throw new EngineError('CANCELLED', 'transition wait cancelled', { retryable: false });
    }
    return this.relocated(entry, operation);
  }

  /** The same control in a fresh snapshot; the binding as it was when the snapshot no longer lists it. */
  private async relocated(entry: NodeBinding, operation: OperationContext): Promise<NodeBinding> {
    const projected = this.project(await this.snapshotOrEmpty(operation, false));
    const found = this.refind(entry, projected.index);
    return found === undefined ? entry : this.bind(found, projected.index);
  }

  /**
   * Records an action the device received: the screen as it was projected
   * before it, and when it returned. The transition budget counts from the
   * return, since the input lands late in the command's own round trip.
   */
  private markAction(before: readonly ProjectedNode[] | undefined): void {
    this.indexBeforeAction = before;
    this.lastActionAt = Date.now();
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    // A test's step verifies its outcome with `expect`, so it never waits for
    // the screen to settle afterwards; it only lets a control that came with
    // the last action finish arriving. The agent reads the screen right after
    // acting, so its actions settle first.
    const deterministic = operation.origin === 'test';
    const settle = deterministic ? {} : this.settleOptions;
    // The observation root is the screen: a swipe on it scrolls the whole
    // viewport, which is the one action a screen takes. It sends no `amount`
    // and keeps agent-device's default for every momentum and every origin:
    // agent-device centres the gesture on the viewport, so the finger starts
    // at `0.5 + amount / 2` of the height, and a larger amount lands it in
    // bottom chrome (a sticky footer, a tab bar) that swallows the drag. A
    // live iOS run lost every `slow` scroll of the mobile benchmark's sticky
    // chrome flow that way. Only the settle wait varies here, by origin.
    if (ref.id === ROOT_ID) {
      if (action.kind !== 'swipe') throw notActionable(`the screen root takes swipe only, not ${action.kind}; act on a node`);
      const before = this.latestIndex;
      await this.command('swipe', (client) => client.interactions.scroll({ direction: action.direction, ...settle }), operation.signal);
      this.markAction(before);
      return;
    }
    const entry = this.resolveRef(ref);
    const label = `perform ${action.kind}`;
    const client = this.requireClient();
    // A toggle already in the wanted state sends nothing, so it neither waits
    // for a transition nor counts as an action the next control must wait on.
    if ((action.kind === 'check' || action.kind === 'uncheck') && entry.node.states?.checked === (action.kind === 'check')) {
      return;
    }
    const before = this.latestIndex;
    const run = async (): Promise<unknown> => {
      const target = deterministic ? await this.settled(entry, operation) : entry;
      switch (action.kind) {
        case 'tap':
          return client.interactions.press({ ...this.actionTarget(target, true), ...settle });
        case 'focus':
          // A touch surface focuses by tapping, and a tap on anything but an
          // editable field activates it; focus is offered for fields only.
          if (target.node.role !== 'textbox') {
            throw unsupported(`agent-device can only focus editable fields; node ${target.id} is ${target.node.role ?? 'unknown'}`);
          }
          return client.interactions.press({ ...this.actionTarget(target), ...settle });
        case 'doubleTap':
          return client.interactions.press({ ...this.actionTarget(target), count: 2, ...settle });
        case 'longPress':
          return client.interactions.longPress({ ...this.actionTarget(target), ...settle, durationMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
        case 'hover':
          return client.interactions.hover(this.actionTarget(target));
        case 'fill':
          // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- agent-device fill, not Array#fill
          return client.interactions.fill({ ...this.actionTarget(target), text: action.value, ...settle });
        case 'clear':
          // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- agent-device fill, not Array#fill
          return client.interactions.fill({ ...this.actionTarget(target), text: '', ...settle });
        case 'check':
        case 'uncheck': {
          const wanted = action.kind === 'check';
          const checked = target.node.states?.checked;
          // A toggle whose state the tree does not expose (Android switches)
          // cannot be set, only flipped; flipping blind could undo a correct state.
          if (checked === undefined) {
            throw unsupported(`agent-device cannot read whether node ${target.id} is checked; tap it instead`);
          }
          if (checked === wanted) return undefined;
          return client.interactions.press({ ...this.actionTarget(target, true), ...settle });
        }
        case 'press':
          return this.pressKey(client, target, action.key, settle);
        case 'swipe': {
          const rect = target.node.rect;
          if (rect === undefined) throw notActionable(`node ${target.id} has no bounds to swipe within`);
          return client.interactions.swipe(swipeWithin(rect, action.direction, action.momentum));
        }
        case 'dragTo': {
          const destination = this.resolveRef(action.target);
          return client.interactions.drag({
            source: this.actionTarget(target).ref,
            destination: this.actionTarget(destination).ref,
          });
        }
        case 'scrollIntoView':
        case 'selectOption':
        case 'setInputFiles':
          // Not in DEVICE_ACTIONS (actions.ts), so the harness never sends them; kept exhaustive.
          throw unsupported(`agent-device cannot perform "${action.kind}" on a device surface`);
      }
    };
    try {
      await raceAbort(() => this.track(run()), operation.signal, label);
    } catch (cause) {
      throw staleOr(cause, label, this.where);
    }
    this.markAction(before);
  }

  /**
   * Keys on a touch surface, in the contract's key grammar: `Enter` submits
   * through the soft keyboard, `Space` and any single character are typed
   * into the focused field. agent-device exposes no key event bus, so
   * modifiers and the other named keys (`Escape`, `Tab`, `Backspace`, the
   * arrows) have nothing to land on and are refused.
   */
  private async pressKey(client: AgentDeviceClient, entry: NodeBinding, key: string, settle: SettleOptions): Promise<unknown> {
    const parsed = parseKey(key);
    if (parsed === undefined) {
      throw unsupported(
        `"${key}" is not a key: press takes one key in the form [Modifier+]...Key, a named key (${KEY_NAMES.join(', ')}) or one character`,
      );
    }
    if (parsed.modifiers.length > 0) {
      throw unsupported(`agent-device cannot hold ${parsed.modifiers.join('+')} on a device surface; press the key alone`);
    }
    if (parsed.key.kind === 'named' && parsed.key.name === 'Enter') {
      return client.command.keyboard({ action: 'enter' });
    }
    if (parsed.key.kind === 'char' || parsed.key.name === 'Space') {
      const text = parsed.key.kind === 'char' ? parsed.key.char : ' ';
      if (entry.node.role === 'textbox' && entry.node.states?.focused !== true) {
        await client.interactions.press({ ...this.actionTarget(entry), ...settle });
      }
      return client.interactions.type({ text });
    }
    throw unsupported(`agent-device cannot press ${parsed.key.name} on a device surface; only Enter, Space, and single characters reach the soft keyboard`);
  }

  /**
   * One pointer action at a screen point in logical pixels, the space every
   * node's bounds are in, with no element resolved behind it. `settle` waits
   * for the UI to go quiet, as the node taps do.
   */
  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    const settle = operation.origin === 'test' ? {} : this.settleOptions;
    const before = this.latestIndex;
    await this.command(`${action.kind} at point`, (client) => pointerInteraction(client, point, action, settle), operation.signal);
    this.markAction(before);
  }

  /**
   * Types into whatever holds focus through the device's text-input path;
   * agent-device's `type` lands on the focused field. `replace` is not a
   * device primitive without a target, so it is refused rather than faked:
   * the model clears a listed field by filling it by id.
   */
  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    if (options.replace) {
      throw unsupported('agent-device cannot clear the focused field without a node; type into a listed field by id to replace its value');
    }
    const before = this.latestIndex;
    await this.command('keyboard.type', (client) => client.interactions.type({ text }), operation.signal);
    this.markAction(before);
  }

  /**
   * One key to the focused field, with the same reach as a node press: Enter
   * submits through the soft keyboard, Space and single characters are typed.
   * Modifiers and the other named keys have no event bus to land on.
   */
  async pressFocusedKey(key: string, operation: OperationContext): Promise<void> {
    const parsed = parseKey(key);
    if (parsed === undefined) {
      throw unsupported(
        `"${key}" is not a key: press takes one key in the form [Modifier+]...Key, a named key (${KEY_NAMES.join(', ')}) or one character`,
      );
    }
    if (parsed.modifiers.length > 0) {
      throw unsupported(`agent-device cannot hold ${parsed.modifiers.join('+')} on a device surface; press the key alone`);
    }
    const before = this.latestIndex;
    if (parsed.key.kind === 'named' && parsed.key.name === 'Enter') {
      await this.command('keyboard.press', (client) => client.command.keyboard({ action: 'enter' }), operation.signal);
    } else if (parsed.key.kind === 'char' || parsed.key.name === 'Space') {
      const text = parsed.key.kind === 'char' ? parsed.key.char : ' ';
      await this.command('keyboard.press', (client) => client.interactions.type({ text }), operation.signal);
    } else {
      throw unsupported(`agent-device cannot press ${parsed.key.name} on a device surface; only Enter, Space, and single characters reach the soft keyboard`);
    }
    this.markAction(before);
  }

  /**
   * Hides the soft keyboard, so a control it covered can be reached.
   * agent-device presses the keyboard's own dismiss key and refuses when the
   * keyboard has none (an iPhone), because a touch outside the keyboard is a
   * guess about the screen it never makes on a caller's behalf. The engine
   * makes that guess, the way a user does and Maestro's `hideKeyboard` does,
   * in {@link dismissKeyboardByGesture}.
   */
  async dismissKeyboard(signal: AbortSignal): Promise<void> {
    const before = this.latestIndex;
    try {
      await this.command('keyboard.dismiss', (client) => client.command.keyboard({ action: 'dismiss' }), signal);
    } catch (cause) {
      if (!(cause instanceof EngineError && cause.code === 'UNSUPPORTED_CAPABILITY')) throw cause;
      await this.dismissKeyboardByGesture(signal);
    }
    this.markAction(before);
  }

  /**
   * A keyboard with no dismiss key goes the way a user sends it away: a short
   * drag at the centre of the screen, which a scroll view turns into a
   * dismissal, each followed by a fresh look at whether the keyboard is still
   * there. Horizontal first: on a vertical scroll view it is no scroll, so
   * React Native's scroll view takes it as the touch outside the keyboard
   * that dismisses by default, where a vertical drag scrolls the content and
   * dismisses only under `keyboardDismissMode="on-drag"`. Vertical second,
   * for the scroll views that dismiss on a drag alone. Maestro's
   * `hideKeyboard` drags in the other order, and on a React Native screen
   * that costs a drag plus the settle after it. The simulator's "Speed up
   * your typing" tip, which sits over a keyboard the first time it appears,
   * goes through its Continue button first. A drag is a guess about what sits
   * at the centre, so the sequence stops the moment the keyboard is gone, and
   * a keyboard that outlives both drags fails naming what does work. Each
   * look is the observation's own capture, sparse-tree retries included: a
   * one-node tree has no keys and would pass for a dismissed keyboard.
   */
  private async dismissKeyboardByGesture(signal: AbortSignal): Promise<void> {
    let raw = await this.dismissKeyboardTip(await this.snapshot(signal, false), signal);
    if (!keyboardShowing(raw)) return;
    const projected = projectSnapshot(raw.nodes ?? [], { mintId: () => 'keyboard' });
    const viewport = await this.viewportFor(projected, signal);
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const drags: readonly Point[] = [
      { x: centre.x - viewport.width * KEYBOARD_DRAG_RATIO, y: centre.y },
      { x: centre.x, y: centre.y - viewport.height * KEYBOARD_DRAG_RATIO },
    ];
    for (const to of drags) {
      await this.command('keyboard.dismiss', (client) => client.interactions.swipe({ from: centre, to }), signal);
      raw = await this.snapshot(signal, false);
      if (!keyboardShowing(raw)) return;
    }
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      'keyboard dismissal failed: the keyboard has no dismiss key and stayed up through a horizontal and a vertical drag at the centre of the screen. Tap the app\'s own Done or close control, or press Enter on the field when submitting is what you want.',
      { retryable: false },
    );
  }

  /**
   * The simulator shows a "Speed up your typing" tip over the keyboard the
   * first time it appears; its Continue button is the only way past it, and
   * Maestro's `hideKeyboard` presses it too. Answers the capture after the
   * press, or the one given when no tip is showing.
   */
  private async dismissKeyboardTip(raw: RawSnapshot, signal: AbortSignal): Promise<RawSnapshot> {
    const nodes = raw.nodes ?? [];
    const tip = nodes.find((node) => (node.label ?? node.value ?? '').startsWith('Speed up your typing'));
    if (tip?.rect === undefined) return raw;
    const tipTop = tip.rect.y;
    const button = nodes.find((node) => node.label === 'Continue' && node.rect !== undefined && node.rect.y > tipTop);
    if (button?.rect === undefined) return raw;
    await this.command('keyboard.dismiss', (client) => client.interactions.press(centreOf(button.rect!)), signal);
    return await this.snapshot(signal, false);
  }

  async back(operation: OperationContext): Promise<void> {
    const settle = operation.origin === 'test' ? {} : this.settleOptions;
    const before = this.latestIndex;
    await this.command('back', (client) => client.command.back({ ...settle }), operation.signal);
    this.markAction(before);
  }

  async restart(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported(`launching the app needs the target's \`app.bundleId\`, or ${UNINSTALLED_BUILD}`);
    await this.openApp(app, { relaunch: true }, operation.signal);
  }

  /** Clears the pinned app's persisted state and relaunches it: the device equivalent of a fresh context. */
  async reset(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported(`app.clearState needs the target's \`app.bundleId\`, or ${UNINSTALLED_BUILD}`);
    await this.command(
      'clear app state',
      (client) => client.settings.update({ setting: 'clear-app-state', state: 'clear', app }),
      operation.signal,
    );
    await this.openApp(app, { relaunch: true }, operation.signal);
  }

  /**
   * Sends a foldable iOS simulator's hinge to a pose; agent-device confirms
   * the angle through CoreDevice before it answers. The pose moves the app to
   * another panel, so it counts as an action like a rotation.
   */
  async fold(pose: FoldPose, signal: AbortSignal): Promise<void> {
    if (this.options.platform !== 'ios') {
      throw unsupported('device.fold drives a foldable iOS simulator (iPhone Duo) through agent-device; it has no Android driver');
    }
    await this.screenCommand('device.fold', (client) => client.command.fold({ pose }), signal);
  }

  /**
   * Resets the simulator's keychain through agent-device. simctl resets the
   * whole simulator's, not one app's, and only a simulator has one to reset:
   * Android is refused before any device command.
   */
  async clearKeychain(signal: AbortSignal): Promise<void> {
    if (this.options.platform !== 'ios') {
      throw unsupported('device.clearKeychain resets an iOS simulator keychain; Android has none to reset');
    }
    await this.command(
      'device.clearKeychain',
      (client) => client.settings.update({ setting: 'reset-keychain', state: 'clear' }),
      signal,
    );
  }

  /**
   * A redacted screenshot artifact. The device paints secure fields as dots,
   * but the last typed character shows in clear, so every secure node's
   * bounds are painted over before the file is kept. A secure node without
   * bounds cannot be masked, and an image that cannot be redacted is not
   * written at all.
   */
  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    const masked = await this.maskedScreenshot(operation.signal);
    attempt.screenshots += 1;
    const name = `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.png`;
    const relative = path.join('screenshots', name);
    mkdirSync(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    writeFileSync(path.join(attempt.artifactsDir, relative), masked.data);
    return relative;
  }

  /** Raw device pixels; cleanup follows the capture even when its caller abandons it. */
  private rawScreenshot(signal?: AbortSignal): Promise<Uint8Array> {
    return this.captureScreenshot(signal, async (shot, file) => new Uint8Array(readFileSync(shot.path ?? file)));
  }

  /**
   * One screenshot into a temp directory that is removed once `read` has
   * taken what it needs from the response or the file, even when the caller
   * abandons the capture.
   */
  private captureScreenshot<T>(
    signal: AbortSignal | undefined,
    read: (shot: RawScreenshotResult, file: string) => Promise<T>,
  ): Promise<T> {
    return this.command('screenshot', async (client) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-'));
      const file = path.join(directory, 'screenshot.png');
      try {
        return await read(await client.capture.screenshot({ path: file }), file);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, signal);
  }

  /**
   * Screenshot with every secure node on the current screen painted over.
   * Observes first so the regions describe the screen the pixels show;
   * throws when a secure field cannot be covered, because an image that may
   * hold a credential must not leave the engine.
   */
  private async maskedScreenshot(signal?: AbortSignal): Promise<{ data: Uint8Array; masked: number }> {
    const operation: OperationContext = {
      signal: signal ?? new AbortController().signal,
      timeoutMs: 30_000,
      runId: '',
      attemptId: '',
      origin: 'test',
    };
    const projected = this.project(await this.snapshotOrEmpty(operation, false));
    const data = await this.rawScreenshot(signal);
    const masked = redactSecure(data, projected, projected.viewport ?? this.knownViewport);
    if (masked === undefined) {
      throw new EngineError('ENGINE_FAILURE', 'a secure field on screen could not be masked; screenshot withheld', {
        retryable: false,
      });
    }
    return masked;
  }

  /**
   * Viewport pixels for an observation. Best-effort: a screenshot that cannot
   * be produced or redacted costs the observation its image, not the step.
   */
  private async capturePixels(
    operation: OperationContext,
    projected: ProjectedSnapshot,
    viewport: ViewportSize,
  ): Promise<{ pixels: ObservationPixels; masked: number } | undefined> {
    let raw: Uint8Array;
    try {
      raw = await this.rawScreenshot(operation.signal);
    } catch {
      return undefined;
    }
    const redacted = redactSecure(raw, projected, viewport);
    if (redacted === undefined) return undefined;
    const size = readPngSize(redacted.data);
    if (size === undefined) return undefined;
    const scale = viewport.width > 0 ? size.width / viewport.width : 1;
    return {
      pixels: { data: redacted.data, mediaType: 'image/png', width: size.width, height: size.height, scale },
      masked: redacted.masked,
    };
  }
}

/**
 * Paints every secure node's bounds black on a screenshot of the same
 * screen. Returns the masked bytes and how many regions were covered, or
 * undefined when a secure node has no bounds or the image format cannot be
 * edited: the caller then withholds the image rather than ship one it could
 * not prove redacted. Bounds are in logical points; the image may be at
 * device scale, so they are scaled by the image-to-viewport ratio.
 */
function redactSecure(
  data: Uint8Array,
  projected: ProjectedSnapshot,
  viewport: ViewportSize | undefined,
): { data: Uint8Array; masked: number } | undefined {
  const secure = projected.index.filter((entry) => entry.node.states?.secure === true);
  if (secure.length === 0) return { data, masked: 0 };
  const size = readPngSize(data);
  if (size === undefined) return undefined;
  const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : 1;
  const rects: Rect[] = [];
  for (const entry of secure) {
    const rect = entry.node.rect;
    if (rect === undefined) return undefined;
    rects.push({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  }
  try {
    return { data: maskPng(data, rects), masked: rects.length };
  } catch {
    return undefined;
  }
}
