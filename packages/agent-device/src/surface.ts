/**
 * The agent-device surface: one simulator or emulator session, driven through
 * agent-device's typed client, exposed to the runner as the contract's
 * observe/locate/perform members. It owns the id space (one fresh generation
 * per observation), the attempt state (artifact directory, screenshot
 * counter), and every translation between the contract's vocabulary and
 * agent-device's commands. The runner owns everything else.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { createAgentDeviceClient } from 'agent-device';
import {
  EngineError,
  raceAbort,
  withinCleanupBudget,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
} from '@e2edev/e2e/engine';
import { staleOr, translateError } from './errors.ts';
import { resolveExpression } from './locate.ts';
import { isWithin, projectSnapshot, screenTitle, type ProjectedNode, type ProjectedSnapshot, type RawNode } from './nodes.ts';
import { maskPng } from './png.ts';
import {
  invalidState,
  notActionable,
  readPngSize,
  sanitizeFilename,
  screenUrl,
  swipeWithin,
  unsupported,
  type Rect,
} from './support.ts';

export type AgentDeviceClient = ReturnType<typeof createAgentDeviceClient>;

/** Mints the agent-device client for one session; the seam unit tests script. */
export type ClientFactory = (session: string) => AgentDeviceClient;

export type AgentDevicePlatform = 'ios' | 'android';

export interface AgentDeviceOptions {
  /** Platform the target's device runs. */
  readonly platform: AgentDevicePlatform;
  /**
   * App opened fresh at the start of every attempt: a bundle id, a package
   * name, or a display name agent-device resolves (`Settings`). Without it the
   * surface observes whatever is in the foreground, and `app.restart` and
   * `app.clearState` are not declared.
   */
  readonly app?: string;
  /**
   * Build to install on the device once per worker, before the first attempt:
   * an iOS `.app` bundle or an Android `.apk`, resolved against the project
   * root (the config's directory). Without `app`, the installed bundle id or
   * package becomes the app opened fresh at the start of every attempt.
   */
  readonly appPath?: string;
  /**
   * Stable identity keying trace cache and session entries; defaults to `app`,
   * else `appPath`. Declare one when the pinned app differs per run (a build
   * path with a version in it) so entries survive the rename.
   */
  readonly identity?: string;
  /** Report label joining the cache identity; a simulator or emulator defaults to `test`. */
  readonly environment?: 'test' | 'staging' | 'production';
  /** Simulator or emulator to use, by name or id; agent-device picks a booted one otherwise. */
  readonly device?: string;
  /**
   * agent-device session name; defaults to `e2e-<target name>`. One run per
   * session at a time: concurrent runs on the same session interleave taps.
   */
  readonly session?: string;
  /**
   * What an observation captures. `full` (default) includes static text, so
   * judgments can read values; `interactive` keeps only actionable nodes and
   * is cheaper on screens with long lists.
   */
  readonly snapshot?: 'full' | 'interactive';
}

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

/** The install fields this engine reads off agent-device's response. */
interface RawInstallResult {
  readonly app: string;
  readonly appId?: string;
  readonly bundleId?: string;
  readonly package?: string;
}

/** The snapshot fields this engine reads off agent-device's response. */
interface RawSnapshot {
  readonly nodes?: readonly RawNode[];
  readonly appName?: string;
  readonly appBundleId?: string;
  readonly snapshotQuality?: { readonly state?: string };
}

/** Action data only: located references never retain a projected snapshot through parent links. */
interface NodeBinding {
  readonly id: string;
  readonly ref: string;
  readonly node: SemanticNode;
  readonly controlRef: string;
}

const MAX_LOCATED_REFS = 2048;

interface Attempt {
  readonly artifactsDir: string;
  screenshots: number;
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

export class AgentDeviceSurface {
  private client: AgentDeviceClient | undefined;
  private testIdAttribute = 'data-testid';
  private attempt: Attempt | undefined;
  private generation = new Map<string, NodeBinding>();
  private readonly located = new Map<string, NodeBinding>();
  private idCounter = 0;
  private appIdentity: string | undefined;
  /** The app `appPath` installed at init, when no `app` option names one. */
  private installedApp: string | undefined;
  /** Where relative build paths resolve; the run's project root once init has told us. */
  private projectRoot = process.cwd();
  /**
   * Commands still running on the device. agent-device takes no abort
   * signal, so a cancelled or timed-out call is only abandoned by its
   * caller; it keeps executing. The next attempt waits for these to settle
   * before it opens anything, so a ghost tap can never land in a retry.
   */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    readonly options: AgentDeviceOptions,
    private readonly createClient: ClientFactory,
  ) {}

  /** Whether the manifest declares app restart and state clearing. */
  get managesApp(): boolean {
    return this.options.app !== undefined || this.options.appPath !== undefined;
  }

  /** The app opened fresh per attempt: the `app` option, else the build `appPath` installed. */
  get pinnedApp(): string | undefined {
    return this.options.app ?? this.installedApp;
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
    try {
      return await raceAbort(() => this.track(run(client)), signal ?? new AbortController().signal, label);
    } catch (cause) {
      throw translateError(cause, label);
    }
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

  async init(info: EngineInitInfo): Promise<void> {
    this.testIdAttribute = info.testIdAttribute;
    this.projectRoot = info.projectRoot;
    this.client ??= this.createClient(this.options.session ?? `e2e-${info.targetName}`);
    await this.command(
      'boot',
      (client) =>
        client.devices.boot({
          platform: this.options.platform,
          ...(this.options.device === undefined ? {} : { device: this.options.device }),
        }),
      info.signal,
    );
    if (this.options.appPath === undefined) return;
    const installed = await this.installApp(
      this.options.appPath,
      this.options.app === undefined ? {} : { app: this.options.app },
      info.signal,
    );
    if (this.options.app === undefined) this.installedApp = installed.app;
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) {
      throw invalidState('an attempt is already running on this agent-device engine');
    }
    await this.settleInflight(context.signal);
    this.attempt = { artifactsDir: context.artifactsDir, screenshots: 0 };
    this.generation = new Map();
    this.located.clear();
    const app = this.pinnedApp;
    if (app === undefined) return;
    await this.openApp(app, true, context.signal);
  }

  async endAttempt(_context: EngineCleanupContext): Promise<void> {
    this.attempt = undefined;
    this.generation = new Map();
    this.located.clear();
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.attempt = undefined;
    this.generation = new Map();
    this.located.clear();
    this.appIdentity = undefined;
    this.installedApp = undefined;
    if (client === undefined) return;
    await withinCleanupBudget(client.sessions.close().catch(() => undefined), context);
  }

  /** Opens an app in the session, remembering its identity for the path anchor. */
  async openApp(app: string, relaunch: boolean, signal: AbortSignal): Promise<void> {
    const result = await this.command(
      `open ${app}`,
      (client) =>
        client.apps.open({
          app,
          platform: this.options.platform,
          ...(this.options.device === undefined ? {} : { device: this.options.device }),
          ...(relaunch ? { relaunch: true } : {}),
        }),
      signal,
    );
    this.appIdentity = result.appBundleId ?? result.appName ?? app;
    this.generation = new Map();
    this.located.clear();
  }

  /**
   * Installs a build on the session's device. `reinstall` removes the app
   * named by `options.app` (else the pinned app) first, so the build starts
   * with no data; a plain install replaces the binary and keeps its data.
   */
  async installApp(appPath: string, options: InstallAppOptions, signal: AbortSignal): Promise<InstalledApp> {
    const resolved = path.resolve(this.projectRoot, appPath);
    const selection = {
      platform: this.options.platform,
      ...(this.options.device === undefined ? {} : { device: this.options.device }),
    };
    const app = options.app ?? (options.reinstall === true ? this.pinnedApp : undefined);
    if (options.reinstall === true && app === undefined) {
      throw invalidState('reinstall needs an app: pass `app`, or pin one with the engine option `app` or `appPath`');
    }
    const result = (await this.command(
      `install ${resolved}`,
      (client) =>
        options.reinstall === true && app !== undefined
          ? client.apps.reinstall({ ...selection, app, appPath: resolved })
          : client.apps.install({ ...selection, ...(app === undefined ? {} : { app }), appPath: resolved }),
      signal,
    )) as RawInstallResult;
    const identity = result.bundleId ?? result.package ?? result.appId;
    return { app: identity ?? result.app, ...(identity === undefined ? {} : { bundleId: identity }) };
  }

  private async snapshot(operation: OperationContext, interactiveOnly: boolean): Promise<RawSnapshot> {
    let last: RawSnapshot = {};
    for (const backoffMs of SPARSE_RETRY_BACKOFF_MS) {
      if (backoffMs > 0) await sleep(backoffMs, operation.signal);
      if (operation.signal.aborted) throw new EngineError('CANCELLED', 'snapshot cancelled', { retryable: false });
      last = (await this.command(
        'snapshot',
        (client) => client.capture.snapshot({ interactiveOnly }),
        operation.signal,
      )) as RawSnapshot;
      if (last.appBundleId !== undefined || last.appName !== undefined) {
        this.appIdentity = last.appBundleId ?? last.appName;
      }
      if (last.snapshotQuality?.state !== 'sparse') return last;
    }
    return last;
  }

  /**
   * Snapshot for an observation. Without a pinned app, an observation before
   * anything is open is an empty screen rather than a fault: the model's next
   * move is the open tool, and failing the step would take that move away.
   */
  private async snapshotOrEmpty(operation: OperationContext, interactiveOnly: boolean): Promise<RawSnapshot> {
    try {
      return await this.snapshot(operation, interactiveOnly);
    } catch (cause) {
      if (!this.managesApp && cause instanceof EngineError && cause.code === 'INVALID_STATE') return { nodes: [] };
      throw cause;
    }
  }

  private project(raw: RawSnapshot): ProjectedSnapshot {
    return projectSnapshot(raw.nodes ?? [], {
      testIdAttribute: this.testIdAttribute,
      mintId: () => {
        this.idCounter += 1;
        return `n${this.idCounter}`;
      },
    });
  }

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const raw = await this.snapshotOrEmpty(operation, this.options.snapshot === 'interactive');
    const projected = this.project(raw);
    this.generation = new Map(projected.index.map((entry) => [entry.id, this.bind(entry, projected.index)]));
    const identity = raw.appBundleId ?? raw.appName ?? this.appIdentity;
    const capture = options?.pixels === true ? await this.capturePixels(operation, projected) : undefined;
    return {
      nodes: projected.roots,
      ...(identity === undefined ? {} : { url: screenUrl(identity, screenTitle(projected)) }),
      ...(projected.viewport === undefined ? {} : { viewport: projected.viewport }),
      ...(capture === undefined ? {} : { pixels: capture.pixels, maskedRegionCount: capture.masked }),
    };
  }

  /** Retains only action bindings for matches, independently of the observation generation. */
  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const raw = await this.snapshotOrEmpty(operation, false);
    const projected = this.project(raw);
    const matches = resolveExpression(expression, projected.index, { testIdAttribute: this.testIdAttribute });
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
    return { id: entry.id, ref: entry.ref, node, controlRef: this.controlOf(entry, snapshot).ref };
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const entry = this.resolveRef(ref);
    const label = `perform ${action.kind}`;
    const client = this.requireClient();
    const run = async (): Promise<unknown> => {
      switch (action.kind) {
        // `settle` waits for the UI to go quiet after the input lands, so the
        // observation that follows describes the screen the action produced,
        // not a frame of its transition. Best-effort on agent-device's side.
        case 'tap':
          return client.interactions.press({ ...this.actionTarget(entry, true), settle: true });
        case 'focus':
          // A touch surface focuses by tapping, and a tap on anything but an
          // editable field activates it; focus is offered for fields only.
          if (entry.node.role !== 'textbox') {
            throw unsupported(`agent-device can only focus editable fields; node ${entry.id} is ${entry.node.role ?? 'unknown'}`);
          }
          return client.interactions.press({ ...this.actionTarget(entry), settle: true });
        case 'doubleTap':
          return client.interactions.press({ ...this.actionTarget(entry), doubleTap: true, settle: true });
        case 'longPress':
          return client.interactions.longPress({
            ...this.actionTarget(entry),
            settle: true,
            ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
          });
        case 'hover':
          return client.interactions.hover(this.actionTarget(entry));
        case 'fill':
          // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- agent-device fill, not Array#fill
          return client.interactions.fill({ ...this.actionTarget(entry), text: action.value, settle: true });
        case 'clear':
          // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- agent-device fill, not Array#fill
          return client.interactions.fill({ ...this.actionTarget(entry), text: '', settle: true });
        case 'check':
        case 'uncheck': {
          const wanted = action.kind === 'check';
          const checked = entry.node.states?.checked;
          // A toggle whose state the tree does not expose (Android switches)
          // cannot be set, only flipped; flipping blind could undo a correct state.
          if (checked === undefined) {
            throw unsupported(`agent-device cannot read whether node ${entry.id} is checked; tap it instead`);
          }
          if (checked === wanted) return undefined;
          return client.interactions.press({ ...this.actionTarget(entry, true), settle: true });
        }
        case 'press':
          return this.pressKey(client, entry, action.key);
        case 'swipe': {
          const rect = entry.node.rect;
          if (rect === undefined) throw notActionable(`node ${entry.id} has no bounds to swipe within`);
          return client.interactions.swipe(swipeWithin(rect, action.direction, action.momentum));
        }
        case 'dragTo': {
          const destination = this.resolveRef(action.target);
          return client.interactions.drag({
            source: this.actionTarget(entry).ref,
            destination: this.actionTarget(destination).ref,
          });
        }
        case 'scrollIntoView':
        case 'selectOption':
        case 'setInputFiles':
          throw unsupported(`agent-device cannot perform "${action.kind}" on a device surface`);
      }
    };
    try {
      await raceAbort(() => this.track(run()), operation.signal, label);
    } catch (cause) {
      throw staleOr(cause, label);
    }
  }

  /**
   * Keys on a touch surface: Enter submits through the soft keyboard, a
   * single character is typed into the focused field; there is no key event
   * bus to send `Escape` or `Tab` to.
   */
  private async pressKey(client: AgentDeviceClient, entry: NodeBinding, key: string): Promise<unknown> {
    if (key === 'Enter' || key === 'Return') {
      return client.command.keyboard({ action: 'enter' });
    }
    if ([...key].length === 1) {
      if (entry.node.role === 'textbox' && entry.node.states?.focused !== true) {
        await client.interactions.press({ ...this.actionTarget(entry), settle: true });
      }
      return client.interactions.type({ text: key });
    }
    throw unsupported(`agent-device cannot press "${key}" on a device surface; only Enter and single characters are supported`);
  }

  async swipe(direction: ScrollDirection, _momentum: Momentum | undefined, operation: OperationContext): Promise<void> {
    await this.command('swipe', (client) => client.interactions.scroll({ direction }), operation.signal);
  }

  async back(operation: OperationContext): Promise<void> {
    await this.command('back', (client) => client.command.back({ settle: true }), operation.signal);
  }

  async restart(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported('app.restart needs the engine option `app` or `appPath`');
    await this.openApp(app, true, operation.signal);
  }

  async clearState(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported('app.clearState needs the engine option `app` or `appPath`');
    await this.command(
      'clear app state',
      (client) => client.settings.update({ setting: 'clear-app-state', state: 'clear', app }),
      operation.signal,
    );
    await this.openApp(app, true, operation.signal);
  }

  /** The path anchor: `app://<app>/<screen title>`; see `screenUrl`. */
  async url(operation: OperationContext): Promise<string> {
    const raw = await this.snapshot(operation, false);
    const projected = projectSnapshot(raw.nodes ?? [], { testIdAttribute: this.testIdAttribute, mintId: () => 'anchor' });
    return screenUrl(raw.appBundleId ?? raw.appName ?? this.appIdentity, screenTitle(projected));
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
  private async rawScreenshot(signal?: AbortSignal): Promise<Uint8Array> {
    return this.command('screenshot', async (client) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-'));
      const file = path.join(directory, 'screenshot.png');
      try {
        const shot = await client.capture.screenshot({ path: file });
        return new Uint8Array(readFileSync(shot.path ?? file));
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
    };
    const projected = this.project(await this.snapshotOrEmpty(operation, false));
    const data = await this.rawScreenshot(signal);
    const masked = redactSecure(data, projected);
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
  ): Promise<{ pixels: ObservationPixels; masked: number } | undefined> {
    let raw: Uint8Array;
    try {
      raw = await this.rawScreenshot(operation.signal);
    } catch {
      return undefined;
    }
    const redacted = redactSecure(raw, projected);
    if (redacted === undefined) return undefined;
    const size = readPngSize(redacted.data);
    if (size === undefined) return undefined;
    const viewport = projected.viewport;
    const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : 1;
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
function redactSecure(data: Uint8Array, projected: ProjectedSnapshot): { data: Uint8Array; masked: number } | undefined {
  const secure = projected.index.filter((entry) => entry.node.states?.secure === true);
  if (secure.length === 0) return { data, masked: 0 };
  const size = readPngSize(data);
  if (size === undefined) return undefined;
  const viewport = projected.viewport;
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
