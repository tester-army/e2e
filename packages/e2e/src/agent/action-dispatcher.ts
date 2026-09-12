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

import type { SemanticNode, ViewportPoint } from '../engine/surface.ts';
import { invalidKeyMessage } from '../internal/keys.ts';
import { parseKey } from '../engine/contract.ts';
import { asEngineError, TestError } from '../internal/errors.ts';
import { clampToViewport } from '../internal/geometry.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import type { JsonValue, Momentum, ScrollDirection, Secret } from '../types.ts';
import { containerKey, describeAction, type RecordableAction } from './actions.ts';
import { describePosition } from '../cache/relocate.ts';
import { isDerivedValue } from './derived.ts';
import { AgentError } from './error.ts';
import type { ExecutorActions, ExecutorTarget, PointTapResult } from './executor.ts';
import type { AgentContext } from './invocation.ts';
import type { ObservationFeed } from './observation-feed.ts';
import type { OperationQueue } from './operation-queue.ts';
import { instrumentPhase, recordPolicyEvent } from './phases.ts';
import { describePointTap, hitTest } from './point-tap.ts';
import { authorizeSecretFill } from './secrets.ts';
import type { StepAccounting } from './step-accounting.ts';
import type { StepTraceSession } from './step-cache.ts';

/**
 * How many times a targeted action re-finds its node after the engine reports
 * it stale. One relocation covers a re-render between the observation and the
 * action; the second covers a render tick landing between the fresh look and
 * the action itself. A control that keeps vanishing faster than that is
 * reported to the model as gone.
 */
const MAX_STALE_RELOCATIONS = 2;

/**
 * The change wait after a scroll or a mutating project tool. A scroll moves
 * nothing the tree records and a tool usually changes state the screen shows
 * only after a reload, so most of these change no shape at all and a long
 * wait is pure cost; a windowed list rendering its next rows, or a tool the
 * page reacts to, does so within a few hundred milliseconds.
 */
const BRIEF_CHANGE_WAIT_MS = 500;

/**
 * How far one grammar scroll moves. The engine's default flick is half the
 * scrolled box; a deliberate scroll of three quarters keeps every row on
 * screen at least once while covering a long feed in fewer actions.
 */
const SCROLL_MOMENTUM: Momentum = 'slow';

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
      tap: (target) => this.tap(target),
      type: (target, value) => this.type(target, value),
      typeSecret: (target, name) => this.typeSecret(target, name),
      press: (target, key) => this.press(target, key),
      select: (target, value) => this.select(target, value),
      scroll: (direction, target) => this.scroll(direction, target),
      navigate: (url) => this.navigate(url),
      tapAt: (point) => this.tapAt(point),
    };
  }

  /** The tap verb: one committed tap on a resolved node. */
  tap(target: ExecutorTarget): Promise<void> {
    return this.runAction('tap', this.targeted(target, (node) => this.performTap(node)));
  }

  /**
   * Taps one viewport point, routed onto the tree in queue order against the
   * newest observation, like a targeted action's resolution. A listed,
   * enabled control containing the point is tapped by its id, so policy,
   * stale relocation, and the trace descriptor see an ordinary tap; a point
   * on nothing listed goes to the engine as a bare point when it takes one.
   * The point is clamped to the viewport first, so one placed off the edge
   * lands on the edge rather than failing the engine.
   */
  tapAt(point: ViewportPoint): Promise<PointTapResult> {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point.y)) {
      throw new TestError('INVALID_ARGUMENT', 'tapAt requires a point { x, y } of finite numbers');
    }
    return this.queue.run(async () => {
      const observation = this.feed.requireLatest();
      const clamped = clampToViewport(point, observation.viewport);
      const hit = hitTest(observation, clamped);
      // An engine without node taps gets the bare point even under a listed control.
      const control = this.verbs.has('tap') ? hit.control : undefined;
      const summary = describePointTap({ point: clamped, control, under: hit.under, observation });
      if (control !== undefined) {
        const target = { id: control.ref.id };
        await this.runActionNow('tap', this.targeted(target, (node) => this.performTap(node)));
        return { point: clamped, target, summary };
      }
      if (!this.verbs.has('tapAt')) {
        throw new TestError(
          'UNSUPPORTED_CAPABILITY',
          `the point (${String(clamped.x)}, ${String(clamped.y)}) is on nothing the screen lists and this engine taps listed nodes only; tap a node by id instead`,
        );
      }
      // The node whose box contained the point is the trace's handle on it;
      // the tree's root is the page itself and follows no layout shift.
      const under = hit.under === undefined || hit.under.ref.id === observation.tree.ref.id ? undefined : hit.under;
      await this.runActionNow('tapAt', async () => {
        await this.session.tapAt(clamped, this.accounting.actionOperation());
        return {
          name: 'tapAt',
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
        { api: this.accounting.api, kind: 'engine', phase: 'agent.action', name: `tool:${call.name}` },
        body,
      );
      // A tool the page reacts to at once is read after the reaction; one
      // whose effect shows only after a reload costs the brief wait, not two seconds.
      if (call.mutates) this.feed.armChange(BRIEF_CHANGE_WAIT_MS);
      return value;
    };
    return call.mutates ? this.queue.run(run) : run();
  }

  private get session() {
    return this.runtime.engine.session;
  }

  private get verbs() {
    return this.runtime.target.verbs;
  }

  private async performTap(node: SemanticNode): Promise<RecordableAction> {
    await this.session.perform(node.ref, { kind: 'tap' }, this.accounting.actionOperation());
    return { name: 'tap', node };
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
    if (typeof key !== 'string' || key.trim() === '' || key.length > 64) {
      throw new TestError('INVALID_ARGUMENT', 'press key must be a short non-empty string');
    }
    if (parseKey(key) === undefined) throw new TestError('INVALID_ARGUMENT', invalidKeyMessage(key));
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
    if (target === undefined) {
      await this.runAction('scroll', async () => {
        await this.session.swipe(direction, SCROLL_MOMENTUM, this.accounting.actionOperation());
        return { name: 'scroll', direction };
      });
      return;
    }
    await this.commitTargeted('scroll', target, async (node) => {
      await this.session.perform(
        node.ref,
        { kind: 'swipe', direction, momentum: SCROLL_MOMENTUM },
        this.accounting.actionOperation(),
      );
      return { name: 'scroll', direction, node };
    });
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
   * secret, origin allowlists, an editable sink, and a password field for a password.
   * Pixel evidence is tainted from here on.
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
      const plaintext = await authorizeSecretFill(
        {
          location: async () =>
            this.feed.latest?.location ?? (await this.session.location(this.accounting.actionOperation())),
          recordPolicy: (policy, decision, code) => recordPolicyEvent(this.runtime.steps, policy, decision, code),
        },
        this.runtime,
        secret,
        node,
      );
      await this.session.perform(
        node.ref,
        { kind: 'fill', value: plaintext, sensitive: true },
        this.accounting.actionOperation(),
      );
      this.runtime.taint.value = true;
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
  private runAction(name: string, body: () => Promise<RecordableAction>): Promise<void> {
    return this.queue.run(() => this.runActionNow(name, body));
  }

  private async runActionNow(name: string, body: () => Promise<RecordableAction>): Promise<void> {
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
    // The effect may still be arriving: the next settled observation waits for
    // the screen to leave the shape this action was resolved against. A secret
    // fill leaves no visible trace and arms nothing; a scroll waits briefly for
    // rows a windowed or lazy list renders.
    if (name !== 'typeSecret') this.feed.armChange(name === 'scroll' ? BRIEF_CHANGE_WAIT_MS : undefined);
    const trace = this.options.trace();
    if (trace === undefined) return;
    // A typed value the step derived at run time is this run's data, not the
    // flow's: it is recorded as a gap so replay hands over before it rather
    // than typing a value the app may not issue again.
    if (action.name === 'type' && isDerivedValue(action.value, this.options.instruction, this.options.params)) {
      trace.recordGap('type (run-time value)');
      return;
    }
    trace.record(action);
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
    name: string,
    target: ExecutorTarget,
    perform: (node: SemanticNode) => Promise<RecordableAction>,
  ): Promise<void> {
    return this.runAction(name, this.targeted(target, perform));
  }

  /** The body of one targeted action: resolution, the relocation loop, and the placement the trace records. */
  private targeted(
    target: ExecutorTarget,
    perform: (node: SemanticNode) => Promise<RecordableAction>,
  ): () => Promise<RecordableAction> {
    return async () => {
      let { node, observation } = this.feed.resolve(target);
      const redact = this.runtime.redact;
      for (let relocations = 0; ; relocations += 1) {
        // The container the node sits in is captured with it: that is what
        // tells this row's "Delete" from the next row's when the flow replays.
        const within = containerKey(node.ref.id, observation.nodes, observation.parents, redact);
        // When the description still matches several controls, the position among
        // them is recorded too; a replay that finds the same number picks the same one.
        const position = describePosition(node, within, observation.nodes, { redact });
        try {
          const action = await perform(node);
          return {
            ...action,
            ...(within === undefined ? {} : { within }),
            ...(position === undefined ? {} : { position }),
          };
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
    };
  }
}
