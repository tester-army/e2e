/**
 * The `mobile-0.1` driver session.
 *
 * One session drives one agent-device session against one simulator or
 * emulator. Snapshots are the revision unit: each capture mints a revision, and
 * every ref the runner holds is valid only for the revision it came from.
 */

import { readFile } from 'node:fs/promises';
import { sleep } from 'e2e/internal';
import {
  DriverError,
  type CleanupContext,
  type DriverApp,
  type DriverArtifacts,
  type DriverAgentActions,
  type DriverContext,
  type DriverDevice,
  type DriverRuntime,
  type DriverScreen,
  type DriverSession,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type Observation,
  type ObserveOptions,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
} from 'e2e/driver';
import {
  assertActionable,
  performAction,
  requireKeyText,
  performScroll,
  performSwipe,
  requireRect,
  type InteractionScope,
} from './actions.ts';
import type { AgentDeviceClient, SnapshotResult } from './client.ts';
import { createDriverDevice } from './device.ts';
import { resolveExpression } from './locators.ts';
import {
  nearestScrollContainer,
  projectSnapshot,
  toObservationTree,
  toSemanticNode,
  type ProjectedNode,
  type ProjectedSnapshot,
} from './snapshot.ts';
import {
  assertNotAborted,
  containedArtifact,
  describeUnusableCapture,
  invalidState,
  translateAgentDeviceError,
  withDeadline,
} from './support.ts';

/**
 * Reported only when the device never revealed its geometry. The runner treats
 * a non-positive viewport as unresolved and omits it from the report rather
 * than publishing zeros.
 */
const UNKNOWN_VIEWPORT = { width: 0, height: 0, scale: 1 } as const;

/** Retries for a capture the backend reports as unusable, then give up. */
const CAPTURE_RETRIES = 2;
const CAPTURE_RETRY_DELAY_MS = 250;

/** Everything the session needs that the factory resolved once per instance. */
export interface MobileSessionOptions {
  readonly client: AgentDeviceClient;
  readonly platform: 'ios' | 'android';
  /** Application identity, already resolved from config or an install. */
  readonly app: string;
  readonly context: DriverContext;
  readonly device: { readonly name: string; readonly os: string };
}

export class MobileSession implements DriverSession {
  readonly device: DriverDevice;

  private readonly client: AgentDeviceClient;
  private readonly platform: 'ios' | 'android';
  private readonly appId: string;
  private readonly context: DriverContext;
  private readonly deviceInfo: { readonly name: string; readonly os: string };
  /**
   * Device geometry in points. It is unknown until a snapshot or a pixel
   * capture reveals it: a mobile target has no configured viewport, and
   * inventing one would put a placeholder into report provenance.
   */
  private viewport: { width: number; height: number; scale: number } | null = null;

  /** The current snapshot, or null when no capture is valid. */
  private snapshot: ProjectedSnapshot | null = null;
  private revisionCounter = 0;
  private artifactCounter = 0;
  private opened = false;
  private closed = false;
  private recording = false;

  constructor(options: MobileSessionOptions) {
    this.client = options.client;
    this.platform = options.platform;
    this.appId = options.app;
    this.context = options.context;
    this.deviceInfo = options.device;
    this.device = createDriverDevice(options.client, {
      platform: options.platform,
      app: options.app,
    });
  }

  private get scope(): InteractionScope {
    return {
      platform: this.platform,
      ...(this.viewport !== null
        ? { viewport: { width: this.viewport.width, height: this.viewport.height } }
        : {}),
    };
  }

  /**
   * Prepares isolated app state for one attempt without launching the app.
   *
   * Launch leaves the app not yet foreground, so the attempt's own `app.open`
   * performs the single launch. Clearing here and launching there costs one
   * app start per attempt instead of two.
   */
  async resetState(mode: 'clear-state' | 'relaunch', operation: OperationContext): Promise<void> {
    this.assertUsable(operation);
    this.invalidate();
    // `relaunch` needs no work: `app.open` replaces any running instance, so
    // the attempt already starts against a freshly started app.
    if (mode === 'relaunch') return;
    try {
      await withDeadline(
        this.client.settings.update({
          platform: this.platform,
          setting: 'clear-app-state',
          state: 'clear',
          app: this.appId,
        }),
        operation,
        'reset app state',
      );
    } catch (cause) {
      throw translateAgentDeviceError(cause, 'reset app state');
    }
  }

  /**
   * Opens a deep link.
   *
   * The app identity is always sent alongside the URL: agent-device 0.20.2
   * drops a URL passed on its own, so a URL-only open would silently do
   * nothing. Sending both is also the documented deep-link form.
   */
  private openUrl(url: string): Promise<unknown> {
    return this.client.apps.open({ platform: this.platform, app: this.appId, url });
  }

  /**
   * Waits for the UI to go quiet, for mutations whose command cannot fold the
   * wait in. Navigation animates for a few hundred milliseconds, so without this
   * a direct read straight after `back` returns the previous screen and reports
   * success. It is best effort: failing to settle is not a reason to fail an
   * action that already committed.
   */
  private async settle(operation: OperationContext): Promise<void> {
    await withDeadline(
      this.client.command
        .wait({ platform: this.platform, stable: true, quietMs: 250, timeoutMs: 5_000 })
        .then(() => undefined)
        .catch(() => undefined),
      operation,
      'settle',
    ).catch(() => undefined);
  }

  /** Rejects use of a closed session, and honors cancellation up front. */
  private assertUsable(operation: OperationContext): void {
    if (this.closed) throw invalidState('driver session is closed');
    assertNotAborted(operation.signal);
  }

  private assertOpened(): void {
    if (!this.opened) {
      throw invalidState('the app is not open; call app.open first');
    }
  }

  /**
   * Invalidates the current snapshot. Every mutation calls it, so a ref minted
   * before the mutation is reported stale instead of addressing a moved node.
   */
  private invalidate(): void {
    this.snapshot = null;
  }

  /**
   * Captures a fresh snapshot and projects it.
   *
   * `raw: true` is required: the backend's default view collapses off-screen
   * content into prose summaries, which would make a locator resolve to zero
   * matches for an element that exists below the fold.
   */
  private async capture(operation: OperationContext): Promise<ProjectedSnapshot> {
    this.assertOpened();
    // A degraded capture is retried rather than trusted: the backend can fall
    // back to a mode that returns a tree with no names, and resolving against
    // that reports a screen that is not there.
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.captureOnce(operation);
      const unusable = describeUnusableCapture(result);
      if (unusable === undefined) return this.project(result);
      if (attempt >= CAPTURE_RETRIES || operation.signal.aborted) {
        throw new DriverError('NODE_STALE', `snapshot is unusable: ${unusable}`, {
          // Retryable so the runner re-resolves within its own deadline: a
          // degraded capture is a transient backend condition, not a verdict
          // about the app.
          retryable: true,
        });
      }
      await sleep(CAPTURE_RETRY_DELAY_MS, operation.signal);
    }
  }

  /** One snapshot request, translated at the SPI boundary. */
  private async captureOnce(operation: OperationContext): Promise<SnapshotResult> {
    try {
      return await withDeadline(
        this.client.capture.snapshot({ platform: this.platform, raw: true }),
        operation,
        'snapshot',
      );
    } catch (cause) {
      throw translateAgentDeviceError(cause, 'snapshot');
    }
  }

  /** Projects one accepted capture and caches it as the current revision. */
  private project(result: SnapshotResult): ProjectedSnapshot {
    // The backend's ref-frame epoch is the natural revision. Without one, a
    // local counter still guarantees a ref never outlives its capture.
    const revision =
      result.refsGeneration === undefined
        ? `r${++this.revisionCounter}`
        : `g${result.refsGeneration}`;
    const projected = projectSnapshot(result, this.platform, revision);
    this.snapshot = projected;
    if (this.viewport === null) {
      const size = projected.viewport;
      // Snapshot geometry is in points, which is the space actions dispatch in,
      // so the scale that goes with it is 1. Whichever capture resolves the
      // viewport first fixes it for the session; see `capturePixels`.
      if (size !== undefined) this.viewport = { ...size, scale: 1 };
    }
    return projected;
  }

  /** Resolves a ref against the current snapshot, or reports it stale. */
  private requireNode(ref: NodeRef): ProjectedNode {
    const snapshot = this.snapshot;
    if (snapshot === null || snapshot.revision !== ref.revision) {
      throw new DriverError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    }
    const node = snapshot.byRef.get(ref.id);
    if (node === undefined) {
      throw new DriverError('NODE_STALE', `node ${ref.id} is no longer present`, {
        retryable: true,
      });
    }
    return node;
  }

  // --- DriverApp ---

  readonly app: DriverApp = {
    open: async (openPath, operation) => {
      this.assertUsable(operation);
      try {
        await withDeadline(
          this.client.apps.open({ platform: this.platform, app: this.appId, relaunch: true }),
          operation,
          'app.open',
        );
        this.opened = true;
        this.invalidate();
        await this.settle(operation);
        // A path is a deep link on mobile: the app launches first, then
        // receives the link, per spec/16-mobile.md.
        if (openPath !== undefined) {
          await withDeadline(this.openUrl(openPath), operation, 'app.open deep link');
        }
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'app.open');
      }
    },
    restart: async (operation) => {
      this.assertUsable(operation);
      try {
        await withDeadline(
          this.client.apps.open({ platform: this.platform, app: this.appId, relaunch: true }),
          operation,
          'app.restart',
        );
        this.opened = true;
        this.invalidate();
        await this.settle(operation);
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'app.restart');
      }
    },
    clearState: async (operation) => {
      this.assertUsable(operation);
      try {
        await withDeadline(
          this.client.settings.update({
            platform: this.platform,
            setting: 'clear-app-state',
            state: 'clear',
            app: this.appId,
          }),
          operation,
          'app.clearState',
        );
        await withDeadline(
          this.client.apps.open({ platform: this.platform, app: this.appId, relaunch: true }),
          operation,
          'app.clearState relaunch',
        );
        this.opened = true;
        this.invalidate();
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'app.clearState');
      }
    },
    back: async (operation) => {
      this.assertUsable(operation);
      this.assertOpened();
      this.invalidate();
      try {
        // `in-app` is app-owned back navigation, which is what `app.back`
        // means; system back is a device concern.
        await withDeadline(
          this.client.command.back({ platform: this.platform, mode: 'in-app' }),
          operation,
          'app.back',
        );
        await this.settle(operation);
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'app.back', { committed: true });
      }
    },
    deepLink: async (url, operation) => {
      this.assertUsable(operation);
      this.invalidate();
      try {
        await withDeadline(this.openUrl(url), operation, 'app.deepLink');
        this.opened = true;
        await this.settle(operation);
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'app.deepLink', { committed: true });
      }
    },
  };

  // --- DriverScreen ---

  readonly screen: DriverScreen = {
    resolve: async (expression: LocatorExpression, operation) => {
      this.assertUsable(operation);
      const snapshot = await this.capture(operation);
      return resolveExpression(snapshot, expression).map((node) => ({
        id: node.ref,
        revision: snapshot.revision,
      }));
    },
    read: async (ref, operation) => {
      this.assertUsable(operation);
      const node = this.requireNode(ref);
      // A direct read is unbounded: only observation trees are truncated.
      return toSemanticNode(node, ref.revision, { bounded: false });
    },
    perform: async (ref, action: LocatorAction, operation) => {
      this.assertUsable(operation);
      const node = this.requireNode(ref);
      assertActionable(node, action.kind);
      this.invalidate();
      try {
        await performAction(this.client, this.scope, node, action, operation);
      } catch (cause) {
        throw translateAgentDeviceError(cause, `perform ${action.kind}`, { committed: true });
      }
    },
    swipe: async (direction, momentum, operation) => {
      this.assertUsable(operation);
      this.assertOpened();
      this.invalidate();
      try {
        await performScroll(this.client, this.scope, direction, momentum ?? 'none', operation);
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'swipe', { committed: true });
      }
    },
  };

  // --- DriverAgentActions ---

  readonly actions: DriverAgentActions = {
    tap: (target, operation) => this.screen.perform(target.ref, { kind: 'tap' }, operation),
    longPress: (target, durationMs, operation) =>
      this.screen.perform(
        target.ref,
        { kind: 'longPress', ...(durationMs !== undefined ? { durationMs } : {}) },
        operation,
      ),
    type: (target, value, sensitive, operation) =>
      this.screen.perform(target.ref, { kind: 'fill', value, sensitive }, operation),
    scroll: async (direction: ScrollDirection, options, operation) => {
      this.assertUsable(operation);
      const momentum: Momentum = options.momentum ?? 'none';
      if (options.target === undefined) {
        return this.screen.swipe(direction, momentum, operation);
      }
      const node = this.requireNode(options.target);
      // A node-scoped scroll drives its nearest scroll container, falling back
      // to the node itself when nothing above it scrolls.
      const container = nearestScrollContainer(node) ?? node;
      this.invalidate();
      try {
        await performSwipe(
          this.client,
          this.scope,
          requireRect(container),
          direction,
          momentum,
          operation,
        );
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'scroll', { committed: true });
      }
      return undefined;
    },
    press: async (key, operation) => {
      this.assertUsable(operation);
      this.assertOpened();
      const text = requireKeyText(key, this.platform);
      this.invalidate();
      try {
        await withDeadline(
          this.client.interactions.type({ platform: this.platform, text }),
          operation,
          'press',
        );
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'press', { committed: true });
      }
    },
    tapPoint: async (point, operation) => {
      this.assertUsable(operation);
      this.assertOpened();
      this.invalidate();
      try {
        await withDeadline(
          this.client.interactions.click({
            platform: this.platform,
            x: Math.round(point.x),
            y: Math.round(point.y),
          }),
          operation,
          'tapPoint',
        );
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'tapPoint', { committed: true });
      }
    },
  };

  // --- DriverArtifacts ---

  readonly artifacts: DriverArtifacts = {
    screenshot: async (label, operation) => {
      this.assertUsable(operation);
      const { absolute, relative } = containedArtifact(
        this.context.artifactsDir,
        `${label ?? 'screenshot'}-${++this.artifactCounter}.png`,
      );
      await this.captureScreenshot(absolute, operation);
      return relative;
    },
    startVideo: async (operation) => {
      this.assertUsable(operation);
      if (this.recording) return;
      const { absolute } = containedArtifact(this.context.artifactsDir, 'video.mp4');
      try {
        await withDeadline(
          this.client.recording.record({ action: 'start', path: absolute }),
          operation,
          'startVideo',
        );
        this.recording = true;
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'startVideo');
      }
    },
    stopVideo: async (operation) => {
      this.assertUsable(operation);
      const { absolute, relative } = containedArtifact(this.context.artifactsDir, 'video.mp4');
      if (!this.recording) return relative;
      this.recording = false;
      try {
        await withDeadline(
          this.client.recording.record({ action: 'stop', path: absolute }),
          operation,
          'stopVideo',
        );
      } catch (cause) {
        throw translateAgentDeviceError(cause, 'stopVideo');
      }
      return relative;
    },
  };

  /** Writes one screenshot to an already-contained absolute path. */
  private async captureScreenshot(absolute: string, operation: OperationContext): Promise<void> {
    try {
      await withDeadline(
        this.client.capture.screenshot({ path: absolute }),
        operation,
        'screenshot',
      );
    } catch (cause) {
      throw translateAgentDeviceError(cause, 'screenshot');
    }
  }

  // --- observation, runtime, lifecycle ---

  async observe(operation: OperationContext, options?: ObserveOptions): Promise<Observation> {
    this.assertUsable(operation);
    const snapshot = await this.capture(operation);
    const tree: SemanticNode = toObservationTree(snapshot);
    const secureNodeCount = snapshot.ordered.filter((node) => node.secure).length;

    // Pixels are omitted when a secure node is visible: mobile has no masking
    // primitive, and returning unmasked pixels would leak the secret while
    // reporting incomplete redaction would only make the runner discard the
    // observation. See spec/16-mobile.md.
    const wantsPixels = options?.pixels === true && !snapshot.secureVisible;
    let pixels: Observation['pixels'];
    if (wantsPixels) {
      pixels = await this.capturePixels(operation);
    }

    return {
      revision: snapshot.revision,
      capturedAt: new Date().toISOString(),
      tree,
      ...(pixels !== undefined ? { pixels } : {}),
      viewport: { ...(this.viewport ?? UNKNOWN_VIEWPORT) },
      redaction: {
        secureNodeCount,
        maskedRegionCount: 0,
        complete: true,
      },
    };
  }

  /**
   * Captures masked-free pixels for the current revision, and resolves the
   * viewport when nothing has yet: the screenshot is the only place the backend
   * reports the device's true logical size and pixel density.
   */
  private async capturePixels(operation: OperationContext): Promise<Observation['pixels']> {
    const { absolute } = containedArtifact(
      this.context.artifactsDir,
      `observation-${++this.artifactCounter}.png`,
    );
    let result;
    try {
      result = await withDeadline(
        this.client.capture.screenshot({ path: absolute }),
        operation,
        'observe pixels',
      );
    } catch {
      // A driver that cannot capture pixels omits them rather than failing the
      // observation, per spec/09-drivers.md.
      return undefined;
    }
    const width = result.width;
    const height = result.height;
    if (width === undefined || height === undefined) return undefined;
    const logicalWidth = result.logicalWidth ?? width;
    const logicalHeight = result.logicalHeight ?? height;
    // Resolve the viewport, never revise it, and keep it in point space.
    //
    // The observation viewport is identity-bearing: the locate cache
    // fingerprints `WxH@scale`, so a viewport that moves mid-session re-keys
    // every later step. Adopting the screenshot's pixel density here did
    // exactly that, and only on the runs that happened to capture pixels, so a
    // vision escalation churned the cache instead of filling it.
    //
    // Scale 1 is not a placeholder for a density that has not been measured. A
    // mobile node's geometry is in points, and points are the space actions
    // dispatch in, so the viewport describing them is 1:1 by construction.
    // Device density belongs to the image, and is reported on `pixels.scale`
    // below, which is where the vision tier reads it.
    this.viewport ??= { width: logicalWidth, height: logicalHeight, scale: 1 };
    const data = await readFile(absolute);
    return {
      data: new Uint8Array(data),
      mediaType: 'image/png',
      width,
      height,
      // Image pixels per point: the space every coordinate read off the image
      // refers to, relative to the space actions dispatch in.
      scale: width / logicalWidth,
    };
  }

  async runtime(operation: OperationContext): Promise<DriverRuntime> {
    this.assertUsable(operation);
    // Geometry comes from the device, so it needs one capture when the session
    // has not observed the screen yet.
    if (this.viewport === null && this.opened) {
      await this.capture(operation).catch(() => undefined);
    }
    return {
      device: { name: this.deviceInfo.name, os: this.deviceInfo.os },
      viewport: { ...(this.viewport ?? UNKNOWN_VIEWPORT) },
    };
  }

  async close(context: CleanupContext): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    // Finalize a running recording so a partial artifact is still usable.
    if (this.recording) {
      this.recording = false;
      const { absolute } = containedArtifact(this.context.artifactsDir, 'video.mp4');
      await this.client.recording
        .record({ action: 'stop', path: absolute })
        .catch(() => undefined);
    }
    // The app closes, but the device stays booted: it is an instance-level
    // resource that `dispose` releases after every session.
    await withDeadline(
      this.client.apps.close({}).then(() => undefined),
      { signal: context.signal, timeoutMs: context.timeoutMs },
      'close',
    ).catch(() => undefined);
  }
}
