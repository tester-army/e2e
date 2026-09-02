/**
 * The agent-device surface: one simulator or emulator session, driven through
 * agent-device's typed client, exposed to the runner as the contract's
 * observe/locate/perform members. It owns the id space (one fresh generation
 * per observation), the attempt state (artifact directory, screenshot
 * counter), and every translation between the contract's vocabulary and
 * agent-device's commands. The runner owns everything else.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { createAgentDeviceClient } from 'agent-device';
import {
  BackendError,
  type BackendAttemptContext,
  type BackendCleanupContext,
  type BackendInitInfo,
  type BackendObserveOptions,
  type BackendSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
} from 'e2e/backend';
import { staleOr, translateError } from './errors.ts';
import { resolveExpression } from './locate.ts';
import { isWithin, projectSnapshot, screenTitle, type ProjectedNode, type ProjectedSnapshot, type RawNode } from './nodes.ts';
import {
  invalidState,
  notActionable,
  raceAbort,
  readPngSize,
  sanitizeFilename,
  screenUrl,
  swipeWithin,
  unsupported,
  withinCleanupBudget,
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

/** The snapshot fields this backend reads off agent-device's response. */
interface RawSnapshot {
  readonly nodes?: readonly RawNode[];
  readonly appName?: string;
  readonly appBundleId?: string;
  readonly snapshotQuality?: { readonly state?: string };
}

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
  private generation = new Map<string, ProjectedNode>();
  private idCounter = 0;
  private appIdentity: string | undefined;

  constructor(
    readonly options: AgentDeviceOptions,
    private readonly createClient: ClientFactory,
  ) {}

  /** Whether the manifest declares app restart and state clearing. */
  get managesApp(): boolean {
    return this.options.app !== undefined;
  }

  /** The live client; INVALID_STATE before init or after dispose. */
  requireClient(): AgentDeviceClient {
    if (this.client === undefined) throw invalidState('the agent-device backend is not initialized');
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
      const pending = run(client);
      return await (signal === undefined ? pending : raceAbort(pending, signal, label));
    } catch (cause) {
      throw translateError(cause, label);
    }
  }

  async init(info: BackendInitInfo): Promise<void> {
    this.testIdAttribute = info.testIdAttribute;
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
  }

  async startAttempt(context: BackendAttemptContext): Promise<void> {
    if (this.attempt !== undefined) {
      throw invalidState('an attempt is already running on this agent-device backend');
    }
    this.attempt = { artifactsDir: context.artifactsDir, screenshots: 0 };
    this.generation = new Map();
    if (this.options.app === undefined) return;
    await this.openApp(this.options.app, true, context.signal);
  }

  async endAttempt(_context: BackendCleanupContext): Promise<void> {
    this.attempt = undefined;
    this.generation = new Map();
  }

  async dispose(context: BackendCleanupContext): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.attempt = undefined;
    this.generation = new Map();
    this.appIdentity = undefined;
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
  }

  private async snapshot(operation: OperationContext, interactiveOnly: boolean): Promise<RawSnapshot> {
    let last: RawSnapshot = {};
    for (const backoffMs of SPARSE_RETRY_BACKOFF_MS) {
      if (backoffMs > 0) await sleep(backoffMs, operation.signal);
      if (operation.signal.aborted) throw new BackendError('CANCELLED', 'snapshot cancelled', { retryable: false });
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
      if (!this.managesApp && cause instanceof BackendError && cause.code === 'INVALID_STATE') return { nodes: [] };
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

  async observe(operation: OperationContext, options?: BackendObserveOptions): Promise<BackendSnapshot> {
    const raw = await this.snapshotOrEmpty(operation, this.options.snapshot === 'interactive');
    const projected = this.project(raw);
    this.generation = new Map(projected.index.map((entry) => [entry.id, entry]));
    const pixels = options?.pixels === true ? await this.capturePixels(operation, projected.viewport) : undefined;
    return {
      nodes: projected.roots,
      ...(projected.viewport === undefined ? {} : { viewport: projected.viewport }),
      // The device paints secure fields as dots but this backend cannot mask
      // regions, so a screen with secure nodes reports zero masks and the
      // runner withholds the image. Honest beats helpful here.
      ...(pixels === undefined ? {} : { pixels, maskedRegionCount: 0 }),
    };
  }

  /**
   * The located snapshot joins the current generation instead of replacing
   * it, so an observation's ids stay valid across a `screen` query in the
   * same step. The whole snapshot joins, not only the matches: a later action
   * on a match may need its descendants (`controlOf`).
   */
  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const raw = await this.snapshotOrEmpty(operation, false);
    const projected = this.project(raw);
    const matches = resolveExpression(expression, projected.index, { testIdAttribute: this.testIdAttribute });
    for (const entry of projected.index) this.generation.set(entry.id, entry);
    return matches.map((entry) => entry.node);
  }

  private resolveRef(ref: NodeRef): ProjectedNode {
    const entry = this.generation.get(ref.id);
    if (entry === undefined) {
      throw new BackendError('NODE_STALE', `node ${ref.id} is not part of the newest observation`, { retryable: true });
    }
    return entry;
  }

  private actionTarget(entry: ProjectedNode): { ref: string } {
    if (entry.ref === '') throw notActionable(`node ${entry.id} has no agent-device ref to act on`);
    return { ref: `@${entry.ref}` };
  }

  /**
   * The node a toggle press must land on. UIKit reports a settings row as a
   * labelled `Switch` spanning the whole row with the real control as an
   * unlabelled `Switch` child at its trailing edge; a press at the row's
   * centre hits the label and changes nothing. The innermost same-role
   * descendant with a ref is the control; a node without one is its own.
   */
  private controlOf(entry: ProjectedNode): ProjectedNode {
    const role = entry.node.role;
    if (role !== 'switch' && role !== 'checkbox') return entry;
    let control = entry;
    let depth = 0;
    for (const candidate of this.generation.values()) {
      if (candidate.ref === '' || candidate.node.role !== role || !isWithin(candidate, entry)) continue;
      const candidateDepth = depthBelow(candidate, entry);
      if (candidateDepth > depth) {
        control = candidate;
        depth = candidateDepth;
      }
    }
    return control;
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
        case 'focus':
          return client.interactions.press({ ...this.actionTarget(this.controlOf(entry)), settle: true });
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
          if (entry.node.states?.checked === wanted) return undefined;
          return client.interactions.press({ ...this.actionTarget(this.controlOf(entry)), settle: true });
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
      await raceAbort(run(), operation.signal, label);
    } catch (cause) {
      throw staleOr(cause, label);
    }
  }

  /**
   * Keys on a touch surface: Enter submits through the soft keyboard, a
   * single character is typed into the focused field; there is no key event
   * bus to send `Escape` or `Tab` to.
   */
  private async pressKey(client: AgentDeviceClient, entry: ProjectedNode, key: string): Promise<unknown> {
    if (key === 'Enter' || key === 'Return') {
      return client.command.keyboard({ action: 'enter' });
    }
    if ([...key].length === 1) {
      if (entry.node.states?.focused !== true) {
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
    if (this.options.app === undefined) throw unsupported('app.restart needs the backend option `app`');
    await this.openApp(this.options.app, true, operation.signal);
  }

  async clearState(operation: OperationContext): Promise<void> {
    const app = this.options.app;
    if (app === undefined) throw unsupported('app.clearState needs the backend option `app`');
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

  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    attempt.screenshots += 1;
    const name = `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.png`;
    const relative = path.join('screenshots', name);
    mkdirSync(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    await this.command(
      'screenshot',
      (client) => client.capture.screenshot({ path: path.join(attempt.artifactsDir, relative) }),
      operation.signal,
    );
    return relative;
  }

  /** Raw screen pixels as a PNG, for the agent's screenshot tool. */
  async screenshotBytes(signal?: AbortSignal): Promise<Uint8Array> {
    const file = path.join(tmpdir(), `e2e-agent-device-${process.pid}-${Date.now()}.png`);
    try {
      const shot = await this.command('screenshot', (client) => client.capture.screenshot({ path: file }), signal);
      return new Uint8Array(readFileSync(shot.path ?? file));
    } finally {
      rmSync(file, { force: true });
    }
  }

  /**
   * Viewport pixels for an observation. Best-effort: a screenshot that cannot
   * be produced costs the observation its image, not the step.
   */
  private async capturePixels(
    operation: OperationContext,
    viewport: ProjectedSnapshot['viewport'],
  ): Promise<ObservationPixels | undefined> {
    let data: Uint8Array;
    try {
      data = await this.screenshotBytes(operation.signal);
    } catch {
      return undefined;
    }
    const size = readPngSize(data);
    if (size === undefined) return undefined;
    const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : 1;
    return { data, mediaType: 'image/png', width: size.width, height: size.height, scale };
  }
}
