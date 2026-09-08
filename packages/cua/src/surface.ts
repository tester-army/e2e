/**
 * The Cua Driver surface: one desktop app window, driven through the
 * in-process Cua Driver runtime, exposed to the runner as the contract's
 * observe/locate/perform members. It owns the id space (one fresh generation
 * per observation), the attempt state (the launched process, its window, the
 * artifact directory, the screenshot counter), and every translation between
 * the contract's vocabulary and the driver's tools. The runner owns
 * everything else.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EngineError,
  InfrastructureError,
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
  type SelectOption,
  type SemanticNode,
} from '@e2edev/e2e/engine';
import type { ClientFactory, DriverClient, DriverToolResult } from './client.ts';
import { checkActionOutcome, PERMISSION_REMEDY, translateThrown, translateToolError } from './errors.ts';
import { parseKey } from './keys.ts';
import { resolveExpression } from './locate.ts';
import { projectSnapshot, type ProjectedNode, type ProjectedSnapshot, type RawWindowState } from './nodes.ts';
import { maskPng } from './png.ts';
import {
  invalidState,
  notActionable,
  readPngSize,
  sanitizeFilename,
  unsupported,
  windowUrl,
  type Rect,
} from './support.ts';

export interface CuaOptions {
  /**
   * The app launched fresh at the start of every attempt: a bundle identifier
   * (`com.apple.TextEdit`) or a display name (`TextEdit`). A bundle id is
   * unambiguous and preferred.
   */
  readonly app: string;
  /** Extra command-line arguments the app is launched with. */
  readonly args?: readonly string[];
  /** Files or URLs the app opens on launch. */
  readonly urls?: readonly string[];
  /**
   * Which of the app's windows the target observes, by title: a string that
   * the title must contain, or a regular expression it must match. Without
   * it, the first window on screen is the surface.
   */
  readonly window?: string | RegExp;
  /**
   * Stable identity keying trace cache and session entries; defaults to `app`.
   * Declare one when the launched app differs per run (a build path with a
   * version in it) so entries survive the rename.
   */
  readonly identity?: string;
  /** Report label joining the cache identity; a local desktop defaults to `test`. */
  readonly environment?: 'test' | 'staging' | 'production';
  /** Cap on the accessibility nodes one observation walks; the driver's default otherwise. */
  readonly maxElements?: number;
  /** Cap on the accessibility tree depth one observation walks; the driver's default otherwise. */
  readonly maxDepth?: number;
}

/** What `list_windows` says about one window; the engine reads these fields. */
interface RawWindow {
  readonly window_id?: number;
  readonly pid?: number;
  readonly title?: string;
  readonly app_name?: string;
  readonly is_on_screen?: boolean;
  readonly bounds?: { x?: number; y?: number; width?: number; height?: number };
}

interface RawLaunch {
  readonly pid?: number;
  readonly bundle_id?: string;
  readonly name?: string;
  readonly windows?: readonly RawWindow[];
}

interface RawPermissions {
  readonly accessibility?: boolean;
  readonly screen_recording?: boolean;
}

/** Action data only: located references never retain a projected snapshot through parent links. */
interface NodeBinding {
  readonly id: string;
  readonly token: string;
  readonly index: number | undefined;
  readonly snapshotId: string | undefined;
  readonly node: SemanticNode;
  readonly pixelCentre: { readonly x: number; readonly y: number } | undefined;
}

interface Attempt {
  readonly artifactsDir: string;
  screenshots: number;
}

interface Target {
  pid: number;
  windowId: number | undefined;
  title: string | undefined;
}

/** The facts of the newest window state that geometry depends on. */
interface Geometry {
  readonly pixelScale: number;
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
  readonly windowOrigin: { readonly x: number; readonly y: number } | undefined;
}

const MAX_LOCATED_REFS = 2048;
const WINDOW_POLL_MS = 250;
/** Codes after which the window is re-resolved once before the call is failed. */
const WINDOW_GONE_CODES = new Set(['window_id_not_found', 'window_owner_pid_mismatch', 'ambiguous_window_target']);
/** Scroll notches per momentum step. */
const SCROLL_AMOUNT: Readonly<Record<Momentum, number>> = { none: 3, slow: 1, fast: 8 };

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

function parseJson<T>(result: DriverToolResult): T | undefined {
  if (result.structuredJson === undefined) return undefined;
  try {
    return JSON.parse(result.structuredJson) as T;
  } catch {
    return undefined;
  }
}

/** True when `app` reads as a bundle identifier rather than a display name. */
function isBundleId(app: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app);
}

export class CuaSurface {
  private client: DriverClient | undefined;
  private testIdAttribute = 'data-testid';
  private attempt: Attempt | undefined;
  private target: Target | undefined;
  private appIdentity: string | undefined;
  /** Whether the host may capture pixels; undefined until the permission check ran. */
  private screenRecording: boolean | undefined;
  private generation = new Map<string, NodeBinding>();
  private readonly located = new Map<string, NodeBinding>();
  private idCounter = 0;
  private geometry: Geometry = { pixelScale: 1, viewport: undefined, windowOrigin: undefined };
  /**
   * Tool calls still running in the driver. A cancelled or timed-out call is
   * only abandoned by its caller; it keeps executing. The next attempt waits
   * for these to settle before it launches anything, so a ghost click can
   * never land in a retry.
   */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    readonly options: CuaOptions,
    private readonly createClient: ClientFactory,
  ) {}

  /** The live client; INVALID_STATE before init or after dispose. */
  requireClient(): DriverClient {
    if (this.client === undefined) throw invalidState('the cua engine is not initialized');
    return this.client;
  }

  /** The launched app's process and window; INVALID_STATE before the attempt launched it. */
  private requireTarget(): Target {
    if (this.target === undefined) throw invalidState('the app is not open; the attempt has not launched it');
    return this.target;
  }

  /**
   * Runs one driver tool under an operation budget and translates its
   * failure. A result that reports an error is thrown as the contract error
   * it maps to; contributed-fixture methods route through here too, so the
   * desktop fixture never carries its own error mapping.
   */
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal = new AbortController().signal,
    label = name,
  ): Promise<DriverToolResult> {
    const client = this.requireClient();
    let result: DriverToolResult;
    try {
      result = await raceAbort(() => this.track(client.call(name, args, signal)), signal, label);
    } catch (cause) {
      throw translateThrown(cause, label);
    }
    if (result.isError) throw translateToolError(result, label);
    return result;
  }

  /** Registers one driver call as in flight until it settles. */
  private track<T>(pending: Promise<T>): Promise<T> {
    this.inflight.add(pending);
    pending.then(
      () => this.inflight.delete(pending),
      () => this.inflight.delete(pending),
    );
    return pending;
  }

  /**
   * Waits for every abandoned call to settle, within the caller's budget. A
   * call that never settles fails the attempt launch instead of racing it:
   * the launch timeout is the honest bound on a stuck driver.
   */
  private async settleInflight(signal: AbortSignal): Promise<void> {
    while (this.inflight.size > 0) {
      await raceAbort(Promise.allSettled(this.inflight), signal, 'settling in-flight driver calls');
    }
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.testIdAttribute = info.testIdAttribute;
    this.client ??= this.createClient();
    await this.checkPermissions(info.signal);
  }

  /**
   * The host's Accessibility grant is what every observation and action
   * needs; without it the run cannot do anything, so it fails here, once, in
   * words that name the fix. Screen Recording only gates pixels: without it
   * observations carry the tree alone and screenshot artifacts are refused.
   * A platform whose driver has no permission report is taken at its word.
   */
  private async checkPermissions(signal: AbortSignal): Promise<void> {
    let result: DriverToolResult;
    try {
      result = await this.call('check_permissions', { prompt: false }, signal, 'permission check');
    } catch (cause) {
      if (cause instanceof EngineError && cause.code === 'UNSUPPORTED_CAPABILITY') return;
      if (cause instanceof EngineError && cause.code === 'ENGINE_FAILURE' && /unknown tool|not found/i.test(cause.message)) return;
      throw cause;
    }
    const permissions = parseJson<RawPermissions>(result);
    if (permissions === undefined) return;
    if (permissions.accessibility === false) {
      throw new InfrastructureError(
        'DESKTOP_PERMISSION_REQUIRED',
        `Cua Driver has no Accessibility permission, so it cannot read or drive any window: ${PERMISSION_REMEDY}`,
      );
    }
    this.screenRecording = permissions.screen_recording !== false;
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running on this cua engine');
    await this.settleInflight(context.signal);
    this.attempt = { artifactsDir: context.artifactsDir, screenshots: 0 };
    this.resetIds();
    await this.launch(context.signal);
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    this.attempt = undefined;
    this.resetIds();
    const target = this.target;
    this.target = undefined;
    if (target === undefined || this.client === undefined) return;
    await withinCleanupBudget(this.terminate(target.pid).catch(() => undefined), context);
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    const client = this.client;
    const target = this.target;
    this.client = undefined;
    this.attempt = undefined;
    this.target = undefined;
    this.appIdentity = undefined;
    this.screenRecording = undefined;
    this.resetIds();
    if (client === undefined) return;
    const teardown = async (): Promise<void> => {
      if (target !== undefined) await client.call('kill_app', { pid: target.pid }, context.signal).catch(() => undefined);
      await client.shutdown();
    };
    await withinCleanupBudget(teardown().catch(() => undefined), context);
  }

  private resetIds(): void {
    this.generation = new Map();
    this.located.clear();
  }

  /** Force-terminates the launched process; the app relaunches fresh next time. */
  private async terminate(pid: number): Promise<void> {
    await this.call('kill_app', { pid }, undefined, 'quit app');
  }

  /**
   * Launches the app fresh and waits for a window to observe. A process left
   * over from a previous attempt is terminated first so every attempt starts
   * from the app's launch state.
   */
  async launch(signal: AbortSignal): Promise<void> {
    if (this.target !== undefined) {
      await this.terminate(this.target.pid).catch(() => undefined);
      this.target = undefined;
    }
    this.resetIds();
    const args = {
      ...(isBundleId(this.options.app) ? { bundle_id: this.options.app } : { name: this.options.app }),
      ...(this.options.args === undefined ? {} : { additional_arguments: [...this.options.args] }),
      ...(this.options.urls === undefined ? {} : { urls: [...this.options.urls] }),
    };
    const launched = parseJson<RawLaunch>(await this.call('launch_app', args, signal, `launch ${this.options.app}`));
    if (launched?.pid === undefined) {
      throw new EngineError('ENGINE_FAILURE', `launch ${this.options.app} failed: the driver reported no process id`, {
        retryable: false,
      });
    }
    this.appIdentity = launched.bundle_id ?? launched.name ?? this.options.app;
    this.target = { pid: launched.pid, windowId: undefined, title: undefined };
    const initial = this.pickWindow(launched.windows ?? []);
    if (initial !== undefined) {
      this.target.windowId = initial.window_id;
      this.target.title = initial.title;
      return;
    }
    await this.awaitWindow(signal);
  }

  /** Polls the app's windows until one the options accept appears. */
  private async awaitWindow(signal: AbortSignal): Promise<void> {
    const target = this.requireTarget();
    for (;;) {
      if (signal.aborted) throw new EngineError('CANCELLED', `launch ${this.options.app} cancelled`, { retryable: false });
      const picked = await this.resolveWindow(signal);
      if (picked !== undefined) return;
      await sleep(WINDOW_POLL_MS, signal);
      if (this.target !== target) return;
    }
  }

  /** Re-reads the app's windows and adopts the one the options accept, if any. */
  private async resolveWindow(signal: AbortSignal): Promise<RawWindow | undefined> {
    const target = this.requireTarget();
    const listed = parseJson<{ windows?: readonly RawWindow[] } | readonly RawWindow[]>(
      await this.call('list_windows', { pid: target.pid }, signal, 'list windows'),
    );
    const windows = Array.isArray(listed) ? listed : (listed as { windows?: readonly RawWindow[] } | undefined)?.windows ?? [];
    const picked = this.pickWindow(windows);
    if (picked === undefined) return undefined;
    target.windowId = picked.window_id;
    target.title = picked.title;
    return picked;
  }

  /** The first window the `window` option accepts, on-screen windows first. */
  private pickWindow(windows: readonly RawWindow[]): RawWindow | undefined {
    const wanted = this.options.window;
    const accepts = (window: RawWindow): boolean => {
      if (window.window_id === undefined) return false;
      if (wanted === undefined) return true;
      const title = window.title ?? '';
      return typeof wanted === 'string' ? title.includes(wanted) : wanted.test(title);
    };
    const candidates = windows.filter(accepts);
    return candidates.find((window) => window.is_on_screen !== false) ?? candidates[0];
  }

  /**
   * One window snapshot from the driver. When the window the attempt adopted
   * is gone (the app replaced its main window), the app's windows are read
   * again once and the snapshot retried; a second miss is the app's state.
   */
  private async windowState(operation: OperationContext, includeScreenshot: boolean): Promise<RawWindowStateWithImages> {
    const target = this.requireTarget();
    if (target.windowId === undefined) {
      await this.resolveWindow(operation.signal);
      if (target.windowId === undefined) throw invalidState(`${this.options.app} has no window to observe`);
    }
    const args = {
      pid: target.pid,
      window_id: target.windowId,
      include_screenshot: includeScreenshot,
      ...(this.options.maxElements === undefined ? {} : { max_elements: this.options.maxElements }),
      ...(this.options.maxDepth === undefined ? {} : { max_depth: this.options.maxDepth }),
    };
    let result: DriverToolResult;
    try {
      result = await this.call('get_window_state', args, operation.signal, 'observe');
    } catch (cause) {
      if (!(cause instanceof EngineError) || cause.code !== 'INVALID_STATE' || !this.windowGone(cause)) throw cause;
      target.windowId = undefined;
      await this.resolveWindow(operation.signal);
      if (target.windowId === undefined) throw cause;
      result = await this.call('get_window_state', { ...args, window_id: target.windowId }, operation.signal, 'observe');
    }
    const state = parseJson<RawWindowState>(result) ?? {};
    return { state, images: result.images, degraded: result.degraded };
  }

  private windowGone(error: EngineError): boolean {
    return [...WINDOW_GONE_CODES].some((code) => error.message.includes(code)) || /window/i.test(error.message);
  }

  private project(state: RawWindowState): ProjectedSnapshot {
    const projected = projectSnapshot(state, {
      testIdAttribute: this.testIdAttribute,
      mintId: () => {
        this.idCounter += 1;
        return `n${this.idCounter}`;
      },
    });
    this.geometry = {
      pixelScale: projected.pixelScale,
      viewport: projected.viewport === undefined ? undefined : { width: projected.viewport.width, height: projected.viewport.height },
      windowOrigin: projected.windowOrigin,
    };
    return projected;
  }

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const wantPixels = options?.pixels === true && this.screenRecording !== false;
    const { state, images } = await this.windowState(operation, wantPixels);
    const projected = this.project(state);
    this.generation = new Map(projected.index.map((entry) => [entry.id, bind(entry, projected.snapshotId)]));
    const capture = wantPixels ? this.capturePixels(images, projected) : undefined;
    return {
      nodes: projected.roots,
      url: windowUrl(this.appIdentity ?? this.options.app, this.target?.title),
      ...(projected.viewport === undefined ? {} : { viewport: projected.viewport }),
      ...(capture === undefined ? {} : { pixels: capture.pixels, maskedRegionCount: capture.masked }),
    };
  }

  /** Retains only action bindings for matches, independently of the observation generation. */
  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const { state } = await this.windowState(operation, false);
    const projected = this.project(state);
    const matches = resolveExpression(expression, projected.index, { testIdAttribute: this.testIdAttribute });
    for (const entry of matches) this.located.set(entry.id, bind(entry, projected.snapshotId));
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

  /** The driver's address for one node: its token, else its index within its snapshot. */
  private elementTarget(entry: NodeBinding): Readonly<Record<string, unknown>> {
    const target = this.requireTarget();
    if (entry.token !== '') return { pid: target.pid, window_id: target.windowId, element_token: entry.token };
    if (entry.index !== undefined && entry.snapshotId !== undefined) {
      return { pid: target.pid, window_id: target.windowId, element_index: entry.index, snapshot_id: entry.snapshotId };
    }
    throw notActionable(`node ${entry.id} has no Cua Driver element handle to act on`);
  }

  /** Centre of a node in window screenshot pixels, the space pixel actions use. */
  private pixelCentre(entry: NodeBinding): { x: number; y: number } {
    if (entry.pixelCentre === undefined) throw notActionable(`node ${entry.id} has no bounds to act within`);
    return entry.pixelCentre;
  }

  /** Runs one action tool and judges its outcome. */
  private async action(name: string, args: Readonly<Record<string, unknown>>, operation: OperationContext, label: string): Promise<void> {
    const client = this.requireClient();
    let result: DriverToolResult;
    try {
      result = await raceAbort(() => this.track(client.call(name, args, operation.signal)), operation.signal, label);
    } catch (cause) {
      throw translateThrown(cause, label);
    }
    checkActionOutcome(result, label);
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const entry = this.resolveRef(ref);
    const label = `perform ${action.kind}`;
    const target = this.requireTarget();
    switch (action.kind) {
      case 'tap':
        return this.action('click', this.elementTarget(entry), operation, label);
      case 'doubleTap':
        return this.action('double_click', this.elementTarget(entry), operation, label);
      case 'focus':
        // A desktop field takes focus from a press on it; anything else has no
        // focus action the driver exposes short of clicking it, which would activate it.
        if (entry.node.role !== 'textbox' && entry.node.role !== 'combobox') {
          throw unsupported(`cua can only focus editable fields; node ${entry.id} is ${entry.node.role ?? 'unknown'}`);
        }
        return this.action('click', this.elementTarget(entry), operation, label);
      case 'hover': {
        // The real pointer moves only in desktop scope, in native desktop pixels.
        const centre = this.pixelCentre(entry);
        const origin = this.geometry.windowOrigin;
        if (origin === undefined) throw notActionable(`node ${entry.id} cannot be hovered: the window's position is unknown`);
        const scale = this.geometry.pixelScale;
        return this.action(
          'move_cursor',
          { scope: 'desktop', x: origin.x * scale + centre.x, y: origin.y * scale + centre.y },
          operation,
          label,
        );
      }
      case 'fill':
        return this.action('set_value', { ...this.elementTarget(entry), value: action.value }, operation, label);
      case 'clear':
        return this.action('set_value', { ...this.elementTarget(entry), value: '' }, operation, label);
      case 'check':
      case 'uncheck': {
        const wanted = action.kind === 'check';
        const checked = entry.node.states?.checked;
        // A toggle whose state the tree does not expose cannot be set, only
        // flipped; flipping blind could undo a correct state.
        if (checked === undefined) {
          throw unsupported(`cua cannot read whether node ${entry.id} is checked; tap it instead`);
        }
        if (checked === wanted) return;
        return this.action('click', this.elementTarget(entry), operation, label);
      }
      case 'press': {
        const parsed = parseKey(action.key);
        if (parsed.modifiers.length > 0) {
          return this.action('hotkey', { ...this.elementTarget(entry), keys: [...parsed.modifiers, parsed.key] }, operation, label);
        }
        return this.action('press_key', { ...this.elementTarget(entry), key: parsed.key }, operation, label);
      }
      case 'selectOption':
        return this.action(
          'set_value',
          { ...this.elementTarget(entry), value: optionLabel(action.value, entry.id) },
          operation,
          label,
        );
      case 'swipe': {
        const amount = SCROLL_AMOUNT[action.momentum ?? 'none'];
        return this.action(
          'scroll',
          { ...this.elementTarget(entry), direction: action.direction, amount },
          operation,
          label,
        );
      }
      case 'dragTo': {
        const from = this.pixelCentre(entry);
        const to = this.pixelCentre(this.resolveRef(action.target));
        return this.action(
          'drag',
          { pid: target.pid, window_id: target.windowId, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y },
          operation,
          label,
        );
      }
      case 'longPress':
      case 'scrollIntoView':
      case 'setInputFiles':
        throw unsupported(`cua cannot perform "${action.kind}" on a desktop window`);
    }
  }

  /** Viewport-level scroll: a wheel gesture at the window's centre. */
  async swipe(direction: ScrollDirection, momentum: Momentum | undefined, operation: OperationContext): Promise<void> {
    const target = this.requireTarget();
    const viewport = this.geometry.viewport;
    const scale = this.geometry.pixelScale;
    const point =
      viewport === undefined ? {} : { x: (viewport.width / 2) * scale, y: (viewport.height / 2) * scale };
    await this.action(
      'scroll',
      { pid: target.pid, window_id: target.windowId, ...point, direction, amount: SCROLL_AMOUNT[momentum ?? 'none'] },
      operation,
      'swipe',
    );
  }

  async restart(operation: OperationContext): Promise<void> {
    await this.launch(operation.signal);
  }

  /** The path anchor: `app://desktop/<app>/<window title>`; see `windowUrl`. */
  async url(operation: OperationContext): Promise<string> {
    if (this.target !== undefined) await this.resolveWindow(operation.signal).catch(() => undefined);
    return windowUrl(this.appIdentity ?? this.options.app, this.target?.title);
  }

  /**
   * A redacted screenshot artifact: the window's pixels with every secure
   * node's bounds painted over before the file is kept. A secure node without
   * bounds cannot be masked, and an image that cannot be redacted is not
   * written at all.
   */
  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    if (this.screenRecording === false) {
      throw new EngineError('ENGINE_FAILURE', `screenshot failed: the host has no Screen Recording permission; ${PERMISSION_REMEDY}`, {
        retryable: false,
      });
    }
    const { state, images } = await this.windowState(operation, true);
    const projected = this.project(state);
    const capture = this.capturePixels(images, projected);
    if (capture === undefined) {
      throw new EngineError('ENGINE_FAILURE', 'screenshot failed: the driver returned no image, or a secure field could not be masked', {
        retryable: false,
      });
    }
    attempt.screenshots += 1;
    const name = `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.png`;
    const relative = path.join('screenshots', name);
    mkdirSync(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    writeFileSync(path.join(attempt.artifactsDir, relative), capture.pixels.data);
    return relative;
  }

  /**
   * Window pixels for an observation, redacted. Best-effort: an image the
   * driver did not return, or one that cannot be redacted, costs the
   * observation its pixels, not the step.
   */
  private capturePixels(
    images: readonly { mimeType: string; dataBase64: string }[],
    projected: ProjectedSnapshot,
  ): { pixels: ObservationPixels; masked: number } | undefined {
    const image = images.find((candidate) => candidate.mimeType === 'image/png') ?? images[0];
    if (image === undefined || image.mimeType !== 'image/png') return undefined;
    const raw = new Uint8Array(Buffer.from(image.dataBase64, 'base64'));
    const redacted = redactSecure(raw, projected);
    if (redacted === undefined) return undefined;
    const size = readPngSize(redacted.data);
    if (size === undefined) return undefined;
    const viewport = projected.viewport;
    const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : projected.pixelScale;
    return {
      pixels: { data: redacted.data, mediaType: 'image/png', width: size.width, height: size.height, scale },
      masked: redacted.masked,
    };
  }

  /** Invokes one menu path (`['File', 'New']`) through the app's menu bar. */
  async invokeMenu(menuPath: readonly string[], signal: AbortSignal): Promise<void> {
    const target = this.requireTarget();
    const operation: OperationContext = { signal, timeoutMs: 30_000, runId: '', attemptId: '' };
    await this.action('invoke_menu', { pid: target.pid, window_id: target.windowId, path: [...menuPath] }, operation, 'desktop.menu');
  }

  /** Sends one key chord (`'Meta+n'`) to the app's window. */
  async hotkey(chord: string, signal: AbortSignal): Promise<void> {
    const target = this.requireTarget();
    const parsed = parseKey(chord);
    const operation: OperationContext = { signal, timeoutMs: 30_000, runId: '', attemptId: '' };
    if (parsed.modifiers.length === 0) {
      await this.action('press_key', { pid: target.pid, window_id: target.windowId, key: parsed.key }, operation, 'desktop.hotkey');
      return;
    }
    await this.action(
      'hotkey',
      { pid: target.pid, window_id: target.windowId, keys: [...parsed.modifiers, parsed.key] },
      operation,
      'desktop.hotkey',
    );
  }

  /** The observed window's title and bounds, freshly read. */
  async window(signal: AbortSignal): Promise<{ title: string; bounds: Rect | undefined }> {
    const picked = await this.resolveWindow(signal);
    const bounds = picked?.bounds;
    return {
      title: picked?.title ?? this.target?.title ?? '',
      bounds:
        bounds?.x === undefined || bounds.y === undefined || bounds.width === undefined || bounds.height === undefined
          ? undefined
          : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    };
  }
}

interface RawWindowStateWithImages {
  readonly state: RawWindowState;
  readonly images: readonly { mimeType: string; dataBase64: string }[];
  readonly degraded: boolean;
}

/** Copies the fields actions use; children never travel with a binding. */
function bind(entry: ProjectedNode, snapshotId: string | undefined): NodeBinding {
  const { children: _children, ...node } = entry.node;
  return { id: entry.id, token: entry.token, index: entry.index, snapshotId, node, pixelCentre: entry.pixelCentre };
}

/** The option label `set_value` picks on a pop-up button; an index has no label to pick by. */
function optionLabel(value: SelectOption, id: string): string {
  if (typeof value === 'string') return value;
  if (value.label !== undefined) return value.label;
  throw unsupported(`cua selects options by label; node ${id} was asked for option index ${value.index}`);
}

/**
 * Paints every secure node's bounds black on a screenshot of the same
 * window. Returns the masked bytes and how many regions were covered, or
 * undefined when a secure node has no bounds or the image cannot be edited:
 * the caller then withholds the image rather than ship one it could not
 * prove redacted. Bounds are in points; the image is at the window's
 * screenshot scale.
 */
function redactSecure(data: Uint8Array, projected: ProjectedSnapshot): { data: Uint8Array; masked: number } | undefined {
  const secure = projected.index.filter((entry) => entry.node.states?.secure === true);
  if (secure.length === 0) return { data, masked: 0 };
  const size = readPngSize(data);
  if (size === undefined) return undefined;
  const viewport = projected.viewport;
  const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : projected.pixelScale;
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
