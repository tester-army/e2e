/**
 * The action grammar of one step, policed and recorded.
 *
 * Every verb an executor can call bottoms out here in the same four moves:
 * validate the argument, resolve the target against what the feed has seen,
 * perform through the engine session under a bounded operation, and hand back
 * the committed action for the event line and the trace cache. The verb table
 * is `buildActions`; a new verb is one entry there and one small method, and
 * nothing else in the step changes. Project tools run through the same budget
 * and queue as `runTool`.
 */

import type { LocatorActionKind, SemanticNode, ViewportPoint } from '../engine/surface.ts';
import { asEngineError, TestError } from '../internal/errors.ts';
import { requireKey } from '../internal/keys.ts';
import { clampToViewport, requireFinitePoint, viewportShare } from '../internal/geometry.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import type { JsonValue, Momentum, ScrollDirection, Secret } from '../types.ts';
import { PROJECT_TOOL_EVENT_PREFIX, type GrammarActionName } from './action-names.ts';
import { containerKey, describeAction, type Placement, type RecordableAction } from './actions.ts';
import { describePosition } from '../cache/relocate.ts';
import type { NodeActionName, PointActionName, RecordedAction } from '../cache/trace.ts';
import { derivedReason } from './derived.ts';
import { AgentError } from './error.ts';
import type { ExecutorActions, ExecutorTarget, PointHit, PointTapResult } from './executor.ts';
import type { AgentContext } from './invocation.ts';
import type { ObservationFeed, Resolved } from './observation-feed.ts';
import { resolveScrollTarget } from './scroll-target.ts';
import type { OperationQueue } from './operation-queue.ts';
import { instrumentPhase, recordPolicyEvent } from './phases.ts';
import { describePointAction, describePointHit, hitTest, POINT_VERBS, type PointProse } from './point-tap.ts';
import { nodeReading, normalizeReading, readingShape } from './reading.ts';
import type { AgentObservation, SemanticAgentObservation } from './observation.ts';
import { authorizeSecretFill } from './secrets.ts';
import { SETTLE_AFTER } from './settle-policy.ts';
import type { StepAccounting } from './step-accounting.ts';
import type { StepTraceSession } from './step-cache.ts';
import { authorizeUploadPaths } from './upload-paths.ts';

/**
 * How many times a targeted action re-finds its node after the engine reports
 * it stale. One relocation covers a re-render between the observation and the
 * action; the second covers a render tick landing between the fresh look and
 * the action itself. A control that keeps vanishing faster than that is
 * reported to the model as gone.
 */
const MAX_STALE_RELOCATIONS = 2;

/**
 * How far one grammar scroll moves. The engine's default flick is half the
 * scrolled box; a deliberate scroll of three quarters keeps every row on
 * screen at least once while covering a long feed in fewer actions.
 */
const SCROLL_MOMENTUM: Momentum = 'slow';

/**
 * How many pages a scroll to a text may turn. Each page moves as a grammar
 * scroll does (`SCROLL_MOMENTUM`): three quarters of the list, so every row
 * is on screen in at least one look and none is skipped between pages, and a
 * drag that starts inside the list, not in the chrome under it, which a
 * longer flick on a full-screen list lands in and loses. A windowed table of
 * five thousand short rows is over four hundred pages on a browser; the cap
 * bounds a text that never shows, the step's own clock bounds the time, and a
 * screen that stops moving ends the paging before either.
 */
const MAX_SCROLL_UNTIL_SCREENS = 800;
const MAX_SCROLL_UNTIL_TEXT_CHARS = 200;
/**
 * Pages that must leave the screen exactly as it was before the list counts
 * as ended, and before that, before the list named as the target is given
 * up for the viewport: a loaded device drops a swipe now and then, and one
 * unchanged look is that as often as it is the end or the wrong list.
 */
const SCROLL_UNTIL_STILL_PAGES = 3;
const SCROLL_UNTIL_WRONG_LIST_PAGES = 2;

/** The engine action each node verb performs; also the name its engine event carries. */
const NODE_ACTION_KINDS = {
  tap: 'tap',
  doubleTap: 'doubleTap',
  longPress: 'longPress',
  secondaryTap: 'secondaryTap',
  hover: 'hover',
  scrollTo: 'scrollIntoView',
} as const satisfies Record<NodeActionName, LocatorActionKind & GrammarActionName>;

export interface ActionDispatcherOptions {
  readonly instruction: string;
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
  /** Secrets declared in the step's params, by stable name; the only ones `typeSecret` may fill. */
  readonly secrets: ReadonlyMap<string, Secret>;
  /** The step's trace-cache session, read at commit time; undefined when caching is off. */
  readonly trace: () => StepTraceSession | undefined;
}

export class ActionDispatcher {
  /**
   * The action grammar, shared verbatim by the executor context and the
   * replay engine: a replayed action runs under exactly the same deadline,
   * budget, policy, and recording as a live one. Committed actions are
   * recorded into the step trace with the node they actually acted on —
   * capture at commit time is what makes the descriptor durable evidence
   * rather than a guess.
   */
  readonly actions: ExecutorActions;

  constructor(
    private readonly runtime: AgentContext,
    private readonly accounting: StepAccounting,
    private readonly feed: ObservationFeed,
    private readonly queue: OperationQueue,
    private readonly options: ActionDispatcherOptions,
  ) {
    this.actions = {
      tap: (target) => this.nodeVerb('tap', target),
      doubleTap: (target) => this.nodeVerb('doubleTap', target),
      longPress: (target) => this.nodeVerb('longPress', target),
      secondaryTap: (target) => this.nodeVerb('secondaryTap', target),
      hover: (target) => this.nodeVerb('hover', target),
      type: (target, value) => this.type(target, value),
      typeSecret: (target, name) => this.typeSecret(target, name),
      press: (target, key) => this.press(target, key),
      select: (target, value) => this.select(target, value),
      check: (target, checked) => this.check(target, checked),
      drag: (source, destination) => this.drag(source, destination),
      scrollTo: (target) => this.nodeVerb('scrollTo', target),
      upload: (target, paths) => this.upload(target, paths),
      scroll: (direction, target) => this.scroll(direction, target),
      scrollUntil: (text, direction, list) => this.scrollUntil(text, direction, list),
      navigate: (url) => this.navigate(url),
      back: () => this.back(),
      tapAt: (point) => this.pointVerb('tapAt', point),
      hoverAt: (point) => this.pointVerb('hoverAt', point),
      hitTest: (point) => this.hitTest(point),
      typeText: (value, typing) => this.typeText(value, typing?.replace === true),
      pressKey: (key) => this.pressKey(key),
      dismissKeyboard: () => this.dismissKeyboard(),
    };
  }

  /**
   * Keyboard input to whatever holds focus. No node is resolved, so no
   * descriptor is recorded: the trace keeps the value and replays it as
   * given after the actions that gave the field focus. An engine that finds
   * nothing editable focused refuses (`NOT_ACTIONABLE`), which reaches the
   * executor as an ordinary failed action to read and work around.
   */
  private typeText(value: string, replace: boolean): Promise<void> {
    if (typeof value !== 'string') {
      throw new TestError('INVALID_ARGUMENT', 'typeText value must be a string');
    }
    return this.runAction('typeText', async () => {
      await this.session.keyboard.type(value, { replace }, this.accounting.actionOperation());
      return { name: 'typeText', value, replace };
    });
  }

  private pressKey(key: string): Promise<void> {
    requireKey(key);
    return this.runAction('pressKey', async () => {
      await this.session.keyboard.press(key, this.accounting.actionOperation());
      return { name: 'pressKey', key };
    });
  }

  private dismissKeyboard(): Promise<void> {
    return this.runAction('dismissKeyboard', async () => {
      await this.session.keyboard.dismiss(this.accounting.actionOperation());
      return { name: 'dismissKeyboard' };
    });
  }

  /**
   * What the newest observation lists at a point, resolved in queue order so
   * a batched turn reads each point against the screen its earlier actions
   * left. Costs no action: the verb the executor calls with the result does.
   */
  hitTest(point: ViewportPoint): Promise<PointHit> {
    requireFinitePoint(point, 'hitTest');
    return this.queue.run(() => {
      const observation = this.feed.requireLatest();
      const clamped = clampToViewport(point, observation.viewport);
      // The control is reported whatever the engine can do with it: the verb
      // the executor calls next is gated on its own action kind, and only a
      // point verb needs to ignore a listed control when its node verb is missing.
      const hit = hitTest(observation, clamped);
      return Promise.resolve({
        point: clamped,
        ...(hit.control === undefined ? {} : { control: { id: hit.control.ref.id } }),
        ...(hit.under === undefined ? {} : { under: { id: hit.under.ref.id } }),
        summary: describePointHit({ point: clamped, control: hit.control, under: hit.under, ...this.prose(observation) }),
      });
    });
  }

  /** One node verb that carries nothing but its target: a tap or one of its variants, a hover, a scroll into view. */
  private nodeVerb(name: NodeActionName, target: ExecutorTarget): Promise<void> {
    return this.commitTargeted(NODE_ACTION_KINDS[name], target, (node) => this.performNode(name, node));
  }

  /**
   * Taps or hovers one viewport point, routed onto the tree in queue order
   * against the newest observation, like a targeted action's resolution. A
   * listed, enabled control containing the point is acted on by its id, so
   * policy, stale relocation, and the trace descriptor see an ordinary node
   * action; a point on nothing listed goes to the engine as a bare point
   * when it takes one. The point is clamped to the viewport first, so one
   * placed off the edge lands on the edge rather than failing the engine.
   */
  private pointVerb(verb: PointActionName, point: ViewportPoint): Promise<PointTapResult> {
    requireFinitePoint(point, verb);
    const nodeVerb = POINT_VERBS[verb].node;
    return this.queue.run(async () => {
      const observation = this.feed.requireLatest();
      const clamped = clampToViewport(point, observation.viewport);
      const hit = hitTest(observation, clamped);
      // An engine without the node verb gets the bare point even under a listed control.
      const control = this.verbs.has(nodeVerb) ? hit.control : undefined;
      const summary = describePointAction({ verb, point: clamped, control, under: hit.under, ...this.prose(observation) });
      if (control !== undefined) {
        const target = { id: control.ref.id };
        await this.runActionNow(nodeVerb, () => this.targeted(this.feed.resolve(target), (node) => this.performNode(nodeVerb, node)));
        return { point: clamped, target, summary };
      }
      if (!this.verbs.has(verb)) {
        throw new TestError(
          'UNSUPPORTED_CAPABILITY',
          `the point (${String(clamped.x)}, ${String(clamped.y)}) is on nothing the screen lists and this engine ${nodeVerb}s listed nodes only; ${nodeVerb} a node by id instead`,
        );
      }
      // The node whose box contained the point is the trace's handle on it;
      // the tree's root is the page itself and follows no layout shift.
      const under = hit.under === undefined || (observation.kind === 'semantic' && hit.under.ref.id === observation.tree.ref.id) ? undefined : hit.under;
      await this.runActionNow(verb, async () => {
        this.runtime.steps.amendTarget({
          point: { x: clamped.x, y: clamped.y },
          ...(under?.rect === undefined ? {} : { box: { x: under.rect.x, y: under.rect.y, width: under.rect.width, height: under.rect.height } }),
        });
        await this.session.performAt(clamped, { kind: nodeVerb }, this.accounting.actionOperation());
        return {
          name: verb,
          point: clamped,
          viewport: { width: observation.viewport.width, height: observation.viewport.height },
          ...(under === undefined ? {} : { under }),
        };
      });
      return { point: clamped, summary };
    });
  }

  /** Records project tools through the same budget and operation queue as grammar actions. */
  runTool<T>(call: { name: string; mutates: boolean }, body: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.accounting.checkpoint();
      if (this.accounting.closed) throw new AgentError('CANCELLED', 'the step has ended');
      if (call.mutates) {
        this.accounting.reserveAction();
        this.options.trace()?.recordGap(call.name);
      }
      const value = await instrumentPhase(
        this.runtime,
        { api: this.accounting.api, kind: 'engine', phase: 'agent.action', name: `${PROJECT_TOOL_EVENT_PREFIX}${call.name}` },
        body,
      );
      if (call.mutates) this.armAfter('tool');
      return value;
    };
    return call.mutates ? this.queue.run(run) : run();
  }

  private get session() {
    return this.runtime.engine.session;
  }

  /** How point results name nodes: by the line of the observation the model holds. */
  private prose(observation: AgentObservation): PointProse {
    return { observation };
  }

  private get verbs() {
    return this.runtime.target.verbs;
  }

  private async performNode(name: NodeActionName, node: SemanticNode): Promise<RecordableAction> {
    await this.session.perform(node.ref, { kind: NODE_ACTION_KINDS[name] }, this.accounting.actionOperation());
    return { name, node };
  }

  /**
   * Sets a checkbox, switch, or radio to a state. The engine's `check` and
   * `uncheck` leave a control already in the wanted state alone, which is
   * what tells this verb from a tap that flips whatever it finds.
   */
  private check(target: ExecutorTarget, checked: boolean): Promise<void> {
    if (typeof checked !== 'boolean') {
      throw new TestError('INVALID_ARGUMENT', 'check requires checked to be a boolean');
    }
    const kind = checked ? 'check' : 'uncheck';
    return this.commitTargeted(kind, target, async (node) => {
      await this.session.perform(node.ref, { kind }, this.accounting.actionOperation());
      return { name: 'check', node, checked };
    });
  }

  /**
   * Drags one node onto another. The drop target is resolved beside the
   * source on every attempt of the relocation loop, so both come from the
   * same look at the screen; its placement is recorded like the source's, so
   * replay can tell one "Done" column from another.
   */
  private drag(source: ExecutorTarget, destination: ExecutorTarget): Promise<void> {
    return this.commitTargeted('dragTo', source, async (node) => {
      const dropped = this.feed.resolve(destination);
      await this.session.perform(node.ref, { kind: 'dragTo', target: dropped.node.ref }, this.accounting.actionOperation());
      return { name: 'drag', node, destination: { node: dropped.node, ...this.placementOf(dropped) } };
    });
  }

  /**
   * Attaches files to a file input. The paths are authorized against the
   * project root before the node is resolved, each decision recorded on the
   * step; the trace keeps them as given and replay authorizes them again.
   */
  private upload(target: ExecutorTarget, paths: readonly string[]): Promise<void> {
    const authorized = authorizeUploadPaths(this.policyHost(), paths, this.runtime.config.projectRoot);
    return this.commitTargeted('setInputFiles', target, async (node) => {
      await this.session.perform(node.ref, { kind: 'setInputFiles', paths: authorized.resolved }, this.accounting.actionOperation());
      return { name: 'upload', node, paths: authorized.given };
    });
  }

  /** One step back: the browser history on a page, the in-app back on a device. */
  private back(): Promise<void> {
    return this.runAction('back', async () => {
      await this.session.app.back(this.accounting.operation());
      return { name: 'back' };
    });
  }

  private type(target: ExecutorTarget, value: string): Promise<void> {
    if (typeof value !== 'string') {
      throw new TestError('INVALID_ARGUMENT', 'type value must be a string');
    }
    return this.commitTargeted('type', target, async (node) => {
      await this.session.perform(node.ref, { kind: 'fill', value, sensitive: false }, this.accounting.actionOperation());
      return { name: 'type', node, value };
    });
  }

  private press(target: ExecutorTarget, key: string): Promise<void> {
    // Checked before the action is committed, as the locator tier does, so a
    // bad argument is INVALID_ARGUMENT to the executor and never a failed action.
    requireKey(key);
    return this.commitTargeted('press', target, async (node) => {
      await this.session.perform(node.ref, { kind: 'press', key }, this.accounting.actionOperation());
      return { name: 'press', node, key };
    });
  }

  private select(target: ExecutorTarget, value: string): Promise<void> {
    if (typeof value !== 'string' || value === '') {
      throw new TestError('INVALID_ARGUMENT', 'select value must be a non-empty option label');
    }
    return this.commitTargeted('selectOption', target, async (node) => {
      await this.session.perform(node.ref, { kind: 'selectOption', value }, this.accounting.actionOperation());
      return { name: 'select', node, value };
    });
  }

  private async scroll(direction: ScrollDirection, target: ExecutorTarget | undefined): Promise<void> {
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new TestError('INVALID_ARGUMENT', `invalid scroll direction "${String(direction)}"`);
    }
    const viewport = async (): Promise<RecordableAction> => {
      await this.session.swipe(direction, SCROLL_MOMENTUM, this.accounting.actionOperation());
      return { name: 'scroll', direction };
    };
    if (target === undefined) return this.runAction('scroll', viewport);
    await this.runAction('scroll', async () => {
      // A list that filled the screen and left the tree scrolls as the
      // viewport does (`scroll-target.ts`).
      const resolved = resolveScrollTarget(this.feed, target);
      if (resolved === undefined) return viewport();
      return this.targeted(resolved, async (node, observation) => {
        await this.session.perform(
          node.ref,
          { kind: 'swipe', direction, momentum: SCROLL_MOMENTUM },
          this.accounting.actionOperation(),
        );
        // How much of the screen the list covered decides, on replay, whether
        // a list that cannot be re-found scrolls as the viewport.
        return {
          name: 'scroll',
          direction,
          node,
          ...(node.rect === undefined ? {} : { spans: viewportShare(node.rect, observation.viewport) }),
        };
      });
    });
  }

  /**
   * Pages a list, or the viewport, until a node reading `text` is in view,
   * as one action: the model names what it is after, the harness turns the
   * pages, reading each settled screen for it, and brings the node into the
   * viewport when the engine can. A screen that stops changing means the
   * list ended without it; the cap means the text is not where the model
   * thought. Either is `LOCATOR_NOT_FOUND`, an action failure the model
   * reads and re-aims from. The list is re-found before every page, since a
   * device renumbers its tree on each look, and a list that filled the
   * screen and left the tree pages as the viewport (`scroll-target.ts`), as
   * does one the pages leave nothing to re-find by: a device names a scroll
   * view after its first visible row, and twenty pages down neither name nor
   * place is what it was. A list whose page moves nothing is not the list
   * either: a device shows two scroll views per screen, the navigator's
   * wrapper and the app's, and a model picks the wrong one now and then. The
   * viewport takes over in both cases, scrolling whatever is under the
   * finger, and the record says so.
   */
  private async scrollUntil(text: string, direction: ScrollDirection, list: ExecutorTarget | undefined): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SCROLL_UNTIL_TEXT_CHARS) {
      throw new TestError('INVALID_ARGUMENT', `scroll to a text requires the text to reach, up to ${String(MAX_SCROLL_UNTIL_TEXT_CHARS)} characters`);
    }
    if (!['up', 'down', 'left', 'right'].includes(direction)) {
      throw new TestError('INVALID_ARGUMENT', `invalid scroll direction "${String(direction)}"`);
    }
    const needle = normalizeReading(text);
    const notFound = (why: string) => new TestError('LOCATOR_NOT_FOUND', `nothing reading ${JSON.stringify(text)} came into view ${why}`);
    await this.runAction('scrollUntil', async () => {
      let observation = this.feed.requireLatest();
      let paged: Pick<Extract<RecordableAction, { name: 'scrollUntil' }>, 'node' | 'spans'> = {};
      let previous: string | undefined;
      let still = 0;
      let within = list;
      for (let screens = 0; ; screens += 1) {
        // Only the list being paged is read while it is on screen; once it is
        // gone the whole screen is, as the paging itself falls back to the viewport.
        const scope = within === undefined || observation.kind !== 'semantic' ? undefined : observation.nodes.get(within.id);
        const found = observation.kind === 'semantic' ? nodeReading(observation, needle, scope) : undefined;
        if (found !== undefined) {
          // An engine that can bring a node in does, whatever the box says: a
          // windowed list renders a row a little before it is visible. One
          // that cannot, a device lists what it draws, takes one more page
          // for a row still past the edge.
          if (this.verbs.has('scrollTo')) {
            await this.session.perform(found.ref, { kind: 'scrollIntoView' }, this.accounting.actionOperation());
            return { name: 'scrollUntil', text, direction, screens, ...paged };
          }
          if (isInViewport(found.rect, observation.viewport)) return { name: 'scrollUntil', text, direction, screens, ...paged };
        }
        if (screens >= MAX_SCROLL_UNTIL_SCREENS) throw notFound(`within ${String(MAX_SCROLL_UNTIL_SCREENS)} screens ${direction}`);
        const shape = observation.kind === 'semantic' ? readingShape(observation) : undefined;
        still = shape !== undefined && shape === previous ? still + 1 : 0;
        if (still >= SCROLL_UNTIL_STILL_PAGES) throw notFound(`before the screen stopped moving ${direction}, after ${String(screens)} screens`);
        if (still >= SCROLL_UNTIL_WRONG_LIST_PAGES && within !== undefined) {
          within = undefined;
          still = 0;
        }
        previous = shape;
        const turned = await this.page(direction, within);
        paged = turned.paged;
        within = turned.within;
        // A settled look: a browser scrolls on a later frame than the wheel
        // event, and a raw read right after it sees the page as it was.
        observation = await this.feed.look('held-still');
      }
    });
  }

  /**
   * One page of a scroll to a text: on the re-found list, else on the
   * viewport, which also takes over for good once the list cannot be
   * re-found. What was paged goes into the record, and the list to page next.
   */
  private async page(
    direction: ScrollDirection,
    list: ExecutorTarget | undefined,
  ): Promise<{ paged: Pick<Extract<RecordableAction, { name: 'scrollUntil' }>, 'node' | 'spans'>; within: ExecutorTarget | undefined }> {
    const resolved = list === undefined ? undefined : this.scrollTargetOrLost(list);
    if (resolved === undefined) {
      await this.session.swipe(direction, SCROLL_MOMENTUM, this.accounting.actionOperation());
      return { paged: {}, within: undefined };
    }
    const { node, observation } = resolved;
    await this.session.perform(node.ref, { kind: 'swipe', direction, momentum: SCROLL_MOMENTUM }, this.accounting.actionOperation());
    return { paged: { node, ...(node.rect === undefined ? {} : { spans: viewportShare(node.rect, observation.viewport) }) }, within: list };
  }

  /** The list a scroll to a text pages, or undefined once neither the newest screen nor its old place has it. */
  private scrollTargetOrLost(list: ExecutorTarget): Resolved | undefined {
    try {
      return resolveScrollTarget(this.feed, list);
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === 'LOCATOR_NOT_FOUND') return undefined;
      throw cause;
    }
  }

  private async navigate(url: string): Promise<void> {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TestError('INVALID_ARGUMENT', 'navigate requires a URL');
    }
    const resolved = resolveNavigationUrl(url, this.runtime.app.base).url;
    // The raw argument is recorded, not the resolved URL: replay re-resolves
    // through the same base and scheme rule this call just passed.
    await this.runAction('navigate', async () => {
      await this.session.app.open(resolved, this.accounting.operation());
      return { name: 'navigate', url };
    });
  }

  /**
   * Fills one declared secret. The name must come from the step's own params
   * — an executor can never fill a secret the test did not hand it — and
   * the fill itself runs the full secret authorization policy: configured
   * secret, an enabled editable sink, and a password field for a password.
   * There is no origin check. Pixel evidence is tainted from here on.
   */
  private async typeSecret(target: ExecutorTarget, name: string): Promise<void> {
    const secret = this.options.secrets.get(name);
    if (secret === undefined) {
      throw new AgentError(
        'POLICY_DENIED',
        `secret "${name}" was not declared in this step's params; only declared secrets can be filled`,
      );
    }
    await this.commitTargeted('typeSecret', target, async (node) => {
      const plaintext = await authorizeSecretFill(this.policyHost(), this.runtime, secret, node);
      // Before the engine call: a fill that types the value and then fails has still put it on screen.
      this.runtime.exposure.raise('filled');
      await this.session.perform(
        node.ref,
        { kind: 'fill', value: plaintext, sensitive: true },
        this.accounting.actionOperation(),
      );
      // Recorded by stable name only; replay re-runs the full authorization.
      return { name: 'typeSecret', node, secret: name };
    });
  }

  /**
   * Runs one grammar action against the action budget, recorded as an engine
   * event. The body performs the engine call and returns the committed
   * action's recordable descriptor — one value carries both concerns: the
   * event's `detail` prose derives from it in a pure hook, and the dispatcher
   * writes it to the trace cache after the phase settles.
   */
  private runAction(name: GrammarActionName, body: () => Promise<RecordableAction>): Promise<void> {
    return this.queue.run(() => this.runActionNow(name, body));
  }

  private async runActionNow(name: GrammarActionName, body: () => Promise<RecordableAction>): Promise<void> {
    this.accounting.reserveAction();
    const redact = this.runtime.redact;
    let action: RecordableAction;
    try {
      action = await instrumentPhase(
        this.runtime,
        { api: this.accounting.api, kind: 'engine', phase: 'agent.action', name },
        body,
        (committed) => ({ detail: describeAction(committed, redact).summary }),
      );
    } catch (cause) {
      this.accounting.checkpoint(cause);
      throw cause;
    }
    this.armAfter(action.name);
    const trace = this.options.trace();
    if (trace === undefined) return;
    // A typed value the step read off the screen (its tree, or a screenshot
    // it was shown) or reckoned from the date is this run's data, not the
    // flow's: it is recorded as a gap so replay hands over before it rather
    // than typing a value the app may not issue again. A value a replay
    // types is the recording's own data and stays: an app that kept the last
    // run's value shows it on the first screen, and no model chose it.
    if (!this.accounting.replayingTrace && (action.name === 'type' || action.name === 'typeText')) {
      const derived = derivedReason(action.value, this.options.instruction, this.options.params, {
        shown: this.feed.shownText(),
        pixels: this.feed.pixelsShown,
      });
      if (derived !== undefined) {
        trace.recordDerivedGap(derived);
        return;
      }
    }
    trace.record(action);
  }

  /**
   * Arms the change wait the action's settle policy asks for, so the next
   * settled observation reads the screen after the effect rather than
   * before. Scrolling to text already settled its final page unless the
   * engine then scrolled that node into view: waiting for another change
   * would wait against the destination screen. An action whose effect the
   * tree cannot show arms nothing.
   */
  private armAfter(name: RecordedAction['name']): void {
    if (name === 'scrollUntil' && !this.verbs.has('scrollTo')) return;
    const { changeWaitMs } = SETTLE_AFTER[name];
    if (changeWaitMs !== undefined) this.feed.armChange(changeWaitMs);
  }

  /**
   * One action against a resolved node. A node the engine reports stale is
   * re-found by its descriptor against a fresh capture and the action retried
   * (`MAX_STALE_RELOCATIONS` times): a list that remounts its rows between
   * the observation and the action keeps the control on screen under a dead
   * handle, and the control, not the handle, is what the model asked for. A
   * descriptor that matches nothing or several nodes fails the action instead.
   */
  private commitTargeted(
    name: GrammarActionName,
    target: ExecutorTarget,
    perform: (node: SemanticNode) => Promise<RecordableAction>,
  ): Promise<void> {
    // Resolved inside the body, so it reads the screen the earlier actions of the turn left.
    return this.runAction(name, () => this.targeted(this.feed.resolve(target), perform));
  }

  /**
   * The body of one targeted action past its resolution: the relocation
   * loop and the placement the trace records. `perform` gets the node with
   * the observation it was found in.
   */
  private async targeted(
    resolved: Resolved,
    perform: (node: SemanticNode, observation: SemanticAgentObservation) => Promise<RecordableAction>,
  ): Promise<RecordableAction> {
    let { node, observation } = resolved;
    for (let relocations = 0; ; relocations += 1) {
      const placement = this.placementOf({ node, observation });
      // The step's frame shows the screen after its last action: that action's node is where the cursor goes.
      if (node.rect !== undefined) this.runtime.steps.amendTarget({ box: { x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height } });
      try {
        return { ...(await perform(node, observation)), ...placement };
      } catch (cause) {
        if (asEngineError(cause)?.code !== 'NODE_STALE') throw cause;
        const relocated = relocations < MAX_STALE_RELOCATIONS ? await this.feed.relocate(node) : undefined;
        if (relocated === undefined) {
          throw new AgentError('LOCATOR_NOT_FOUND', 'the target node left the screen before the action reached it', {
            cause,
          });
        }
        node = relocated.node;
        observation = relocated.observation;
      }
    }
  }

  /**
   * Where a node sat when it was acted on, for the trace: the container it
   * sits in (that is what tells this row's "Delete" from the next row's when
   * the flow replays) and, when the description still matches several
   * controls, its position among them, so a replay that finds the same
   * number picks the same one.
   */
  private placementOf({ node, observation }: Resolved): Placement {
    const redact = this.runtime.redact;
    const within = containerKey(node.ref.id, observation.nodes, observation.parents, redact);
    const position = describePosition(node, within, observation.nodes, { redact });
    return {
      ...(within === undefined ? {} : { within }),
      ...(position === undefined ? {} : { position }),
    };
  }

  /** The seam a policy records its decisions through, onto this step's events. */
  private policyHost() {
    return { recordPolicy: (policy: string, decision: 'allowed' | 'denied', code?: string) => recordPolicyEvent(this.runtime.steps, policy, decision, code) };
  }

}

/** Whether a box lies at least partly inside the viewport; a node without a box counts as shown. */
function isInViewport(rect: SemanticNode['rect'], viewport: { readonly width: number; readonly height: number }): boolean {
  if (rect === undefined) return true;
  return rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

