/** Public Screen and Locator surfaces bound to one attempt. */

import nodePath from 'node:path';
import type { LocatorExpression, SemanticNode } from '../engine/surface.ts';
import { locatorBrand, secretBrand } from '../internal/brands.ts';
import { asEngineError, ConfigurationError, TestError } from '../internal/errors.ts';
import { requireFinitePoint } from '../internal/geometry.ts';
import { rejectUnknownOptions } from '../internal/options.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { normalizeText } from '../internal/text.ts';
import type {
  ActionOptions,
  LongPressOptions,
  Locator,
  Momentum,
  Point,
  PressSequentiallyOptions,
  Role,
  RoleAlias,
  RoleOptions,
  Screen,
  ScrollDirection,
  Secret,
  SelectOption,
  SwipeOptions,
  SwipePathOptions,
  TapOptions,
  TextMatch,
  TextMatchOptions,
} from '../types.ts';
import type { StepRecorder } from '../run/steps.ts';
import { attributeOf, isNodeVisible, type LocatorEngine } from './engine.ts';
import {
  describeExpression,
  filterExpression,
  indexExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from './expression.ts';
import { type Deadline, POLL_INTERVAL_MS, pollCondition, sleep } from '../internal/time.ts';

export interface SecretResolver {
  /**
   * Resolves an opaque Secret to its plaintext for a closed input sink, at
   * fill time — a provider-backed credential may compute it fresh per fill.
   */
  resolve(secret: Secret): Promise<string>;
}

export interface ScreenContext {
  readonly engine: LocatorEngine;
  readonly steps: StepRecorder;
  readonly secrets: SecretResolver;
  /** Base directory for resolving relative file paths, e.g. uploads. */
  readonly projectRoot?: string;
}

export function isSecret(value: unknown): value is Secret {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[secretBrand] === true
  );
}

/** Internal accessor used by expect() to reach a locator's expression/engine. */
export interface LocatorInternals {
  readonly expression: LocatorExpression;
  readonly context: ScreenContext;
}

/**
 * Internals hang off the locator object itself under a global symbol so that
 * an expect() imported in an isolated test-module realm can still reach them.
 */
const internalsSlot = realmSlot<LocatorInternals>('e2e.locatorInternals.v1');

export function locatorInternals(locator: unknown): LocatorInternals | undefined {
  if (typeof locator !== 'object' || locator === null) return undefined;
  if ((locator as Record<PropertyKey, unknown>)[locatorBrand] !== true) return undefined;
  return internalsSlot.get(locator);
}

/** Creates the screen fixture for one attempt. */
export function createScreen(context: ScreenContext): Screen {
  return new ScreenImpl(context, undefined);
}

/**
 * Creates a screen scope whose every query is wrapped by `wrap` - a
 * contributed fixture scoping queries into a nested document, for example.
 */
export function createScopedScreen(
  context: ScreenContext,
  wrap: (expression: LocatorExpression) => LocatorExpression,
): Screen {
  return new ScreenImpl(context, undefined, wrap);
}

/** Creates a public locator from a raw expression (a contributed fixture's platform selector). */
export function createLocator(context: ScreenContext, expression: LocatorExpression): Locator {
  return new LocatorImpl(context, expression);
}

/**
 * Whether a swipe failed because the operation budget it was given ran out:
 * the engine's `OPERATION_TIMEOUT` as a viewport swipe raises it, or wrapped
 * as the `ACTION_FAILED` the locator engine translates it into.
 */
function timedOut(cause: unknown): boolean {
  const engineError = asEngineError(cause) ?? asEngineError(cause instanceof Error ? cause.cause : undefined);
  return engineError?.code === 'OPERATION_TIMEOUT';
}

class ScreenImpl implements Screen {
  constructor(
    protected readonly context: ScreenContext,
    protected readonly scope: LocatorExpression | undefined,
    /** When set, every query expression is passed through it before use. */
    protected readonly wrap: ((expression: LocatorExpression) => LocatorExpression) | undefined = undefined,
  ) {}

  private build(expression: LocatorExpression): LocatorExpression {
    return this.wrap === undefined ? expression : this.wrap(expression);
  }

  getByRole(role: Role | RoleAlias, options?: RoleOptions): Locator {
    return new LocatorImpl(this.context, this.build(roleQuery(role, options, this.scope)));
  }

  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator {
    return new LocatorImpl(this.context, this.build(textQuery('label', text, options, this.scope)));
  }

  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator {
    return new LocatorImpl(
      this.context,
      this.build(textQuery('placeholder', text, options, this.scope)),
    );
  }

  getByText(text: TextMatch, options?: TextMatchOptions): Locator {
    return new LocatorImpl(this.context, this.build(textQuery('text', text, options, this.scope)));
  }

  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator {
    return new LocatorImpl(
      this.context,
      this.build(textQuery('displayValue', value, options, this.scope)),
    );
  }

  getByTestId(id: string, options?: { visible?: boolean }): Locator {
    return new LocatorImpl(this.context, this.build(testIdQuery(id, options, this.scope)));
  }

  async tapAt(point: Point, options?: ActionOptions): Promise<void> {
    rejectUnknownOptions('tapAt', options, ['timeout']);
    const at = requirePoint(point, 'tapAt');
    await this.context.steps.run('screen', 'screen.tapAt', describePoint(at), () =>
      this.context.engine.performAt(at, { kind: 'tap' }, options?.timeout),
    );
  }

  async swipe(options: SwipeOptions | SwipePathOptions): Promise<void> {
    if (isSwipePath(options)) {
      rejectUnknownOptions('swipe', options, ['from', 'to']);
      const from = requirePoint(options.from, 'swipe from');
      const to = requirePoint(options.to, 'swipe to');
      await this.context.steps.run(
        'screen',
        'screen.swipe',
        `${describePoint(from)} → ${describePoint(to)}`,
        () => this.context.engine.performAt(from, { kind: 'swipeTo', target: to }),
      );
      return;
    }
    rejectUnknownOptions('swipe', options, ['direction', 'momentum']);
    await this.context.steps.run('screen', 'screen.swipe', options.direction, async () => {
      const { engine } = this.context;
      await engine.session.swipe(options.direction, options.momentum, engine.operation());
    });
  }

  async scrollUntilVisible(
    target: Locator,
    options?: { direction?: ScrollDirection; momentum?: Momentum; timeout?: number },
  ): Promise<void> {
    const internals = this.ownLocator(target, 'scrollUntilVisible');
    rejectUnknownOptions('scrollUntilVisible', options, ['direction', 'momentum', 'timeout']);
    const direction = options?.direction ?? 'down';
    const momentum = options?.momentum ?? 'slow';
    const { engine } = this.context;
    // On `screen` the viewport scrolls; on a locator the node itself does, so
    // a scroll container pages without the pointer having to hover it first.
    // Every swipe is bounded by the scroll's own deadline, not the action timeout.
    const scope = this.scope;
    const swipeStep = (deadline: Deadline) =>
      scope === undefined
        ? engine.session.swipe(direction, momentum, engine.operationWithin(deadline))
        : engine.performUntil(scope, { kind: 'swipe', direction, momentum }, deadline);
    const label = describeExpression(internals.expression);
    await this.context.steps.run('screen', 'screen.scrollUntilVisible', label, async () => {
      const deadline = engine.deadline(options?.timeout ?? 30_000);
      const notVisible = (cause?: unknown) =>
        new TestError(
          'LOCATOR_NOT_FOUND',
          `target did not become visible while scrolling: ${label}`,
          cause === undefined ? undefined : { cause },
        );
      for (;;) {
        const { node } = await engine.tryRead(internals.expression, deadline);
        if (isNodeVisible(node)) return;
        if (deadline.expired()) throw notVisible();
        try {
          await swipeStep(deadline);
        } catch (cause) {
          // A swipe cut by the scroll's deadline is the scroll timing out. The
          // engine's timer can wake a millisecond before this clock reads the
          // deadline, so a swipe that ran out of its budget within a poll
          // interval of the deadline is the deadline too, whichever timer fired first.
          if (deadline.expired() || (timedOut(cause) && deadline.remaining() < POLL_INTERVAL_MS)) {
            throw notVisible(cause);
          }
          throw cause;
        }
        await sleep(Math.min(POLL_INTERVAL_MS, deadline.remaining()), engine.signal);
      }
    });
  }

  /**
   * The internals of a locator this screen may resolve: an e2e locator made
   * by this attempt's screen for the same target. One made elsewhere would be
   * evaluated through this target's engine, so it is refused before any step.
   */
  protected ownLocator(candidate: unknown, api: string): LocatorInternals {
    const internals = locatorInternals(candidate);
    if (internals === undefined) {
      throw new TestError('INVALID_LOCATOR', `${api} requires an e2e locator`);
    }
    if (internals.context !== this.context) {
      throw new TestError(
        'INVALID_LOCATOR',
        `${api} requires a locator made by this screen; the one given belongs to another target's screen or another attempt`,
      );
    }
    return internals;
  }
}

class LocatorImpl extends ScreenImpl implements Locator {
  readonly [locatorBrand] = true;

  constructor(
    context: ScreenContext,
    private readonly expression: LocatorExpression,
  ) {
    super(context, expression);
    internalsSlot.set(this, { expression, context });
  }

  private get label(): string {
    return describeExpression(this.expression);
  }

  private action(api: string, body: () => Promise<void>): Promise<void> {
    return this.context.steps.run('locator', api, this.label, body);
  }

  tap(options?: TapOptions): Promise<void> {
    return this.tapWith('tap', options);
  }

  click(options?: TapOptions): Promise<void> {
    return this.tapWith('click', options);
  }

  /**
   * One tap of the node: the platform's own, or, with a position, the pointer
   * dispatched at that offset of the node's box.
   */
  private tapWith(api: 'tap' | 'click', options: TapOptions | undefined): Promise<void> {
    rejectUnknownOptions(api, options, ['timeout', 'position']);
    if (options?.position === undefined) {
      return this.action(`locator.${api}`, () =>
        this.context.engine.perform(this.expression, { kind: 'tap' }, options?.timeout),
      );
    }
    const position = requirePoint(options.position, `${api} position`);
    return this.context.steps.run(
      'locator',
      `locator.${api}`,
      `${this.label} at ${describePoint(position)}`,
      () => this.context.engine.performWithin(this.expression, position, { kind: 'tap' }, options.timeout),
    );
  }

  doubleTap(options?: ActionOptions): Promise<void> {
    return this.action('locator.doubleTap', () =>
      this.context.engine.perform(this.expression, { kind: 'doubleTap' }, options?.timeout),
    );
  }

  secondaryTap(options?: ActionOptions): Promise<void> {
    return this.action('locator.secondaryTap', () =>
      this.context.engine.perform(this.expression, { kind: 'secondaryTap' }, options?.timeout),
    );
  }

  longPress(options?: LongPressOptions): Promise<void> {
    rejectUnknownOptions('longPress', options, ['timeout', 'duration']);
    const durationMs = validateLongPress(options?.duration);
    return this.action('locator.longPress', () =>
      this.context.engine.perform(this.expression, { kind: 'longPress', durationMs }, options?.timeout),
    );
  }

  fill(value: string | Secret, options?: ActionOptions): Promise<void> {
    const sensitive = isSecret(value);
    // Resolved inside the recorded step, so a failing provider fails the fill.
    return this.action('locator.fill', async () =>
      this.context.engine.perform(
        this.expression,
        {
          kind: 'fill',
          value: sensitive ? await this.context.secrets.resolve(value) : value,
          sensitive,
        },
        options?.timeout,
      ),
    );
  }

  pressSequentially(text: string, options?: PressSequentiallyOptions): Promise<void> {
    if (isSecret(text)) {
      throw new TestError(
        'INVALID_ARGUMENT',
        'pressSequentially takes a plain string; a Secret goes through fill, which never types it as keystrokes',
      );
    }
    if (typeof text !== 'string') {
      throw new TestError('INVALID_ARGUMENT', 'pressSequentially requires a string');
    }
    rejectUnknownOptions('pressSequentially', options, ['timeout', 'delay']);
    const delay = validateDelay(options?.delay);
    const chunks = text.length === 0 ? [] : delay === undefined ? [text] : [...text];
    return this.action('locator.pressSequentially', () =>
      this.context.engine.pressSequentially(this.expression, chunks, delay ?? 0, options?.timeout),
    );
  }

  clear(options?: ActionOptions): Promise<void> {
    return this.action('locator.clear', () =>
      this.context.engine.perform(this.expression, { kind: 'clear' }, options?.timeout),
    );
  }

  press(key: string, options?: ActionOptions): Promise<void> {
    return this.action('locator.press', () =>
      this.context.engine.perform(this.expression, { kind: 'press', key }, options?.timeout),
    );
  }

  check(options?: ActionOptions): Promise<void> {
    return this.action('locator.check', () =>
      this.context.engine.perform(this.expression, { kind: 'check' }, options?.timeout),
    );
  }

  uncheck(options?: ActionOptions): Promise<void> {
    return this.action('locator.uncheck', () =>
      this.context.engine.perform(this.expression, { kind: 'uncheck' }, options?.timeout),
    );
  }

  selectOption(value: SelectOption, options?: ActionOptions): Promise<void> {
    return this.action('locator.selectOption', () =>
      this.context.engine.perform(this.expression, { kind: 'selectOption', value }, options?.timeout),
    );
  }

  focus(options?: ActionOptions): Promise<void> {
    return this.action('locator.focus', () =>
      this.context.engine.perform(this.expression, { kind: 'focus' }, options?.timeout),
    );
  }

  hover(options?: ActionOptions): Promise<void> {
    return this.action('locator.hover', () =>
      this.context.engine.perform(this.expression, { kind: 'hover' }, options?.timeout),
    );
  }

  setInputFiles(paths: string | readonly string[], options?: ActionOptions): Promise<void> {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    if (list.length === 0 || list.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      throw new TestError('INVALID_ARGUMENT', 'setInputFiles requires one or more non-empty paths');
    }
    const base = this.context.projectRoot;
    const resolved = list.map((entry) => (base === undefined ? entry : nodePath.resolve(base, entry)));
    return this.action('locator.setInputFiles', () =>
      this.context.engine.perform(
        this.expression,
        { kind: 'setInputFiles', paths: resolved },
        options?.timeout,
      ),
    );
  }

  dragTo(target: Locator, options?: ActionOptions): Promise<void> {
    const internals = this.ownLocator(target, 'dragTo');
    // The drop target resolves inside the retry, so a superseded target ref
    // is re-resolved along with the source instead of looping until timeout.
    return this.action('locator.dragTo', () =>
      this.context.engine.perform(
        this.expression,
        async (deadline) => ({
          kind: 'dragTo',
          target: await this.context.engine.resolveExactlyOne(internals.expression, deadline),
        }),
        options?.timeout,
      ),
    );
  }

  scrollIntoView(options?: ActionOptions): Promise<void> {
    return this.action('locator.scrollIntoView', () =>
      this.context.engine.perform(this.expression, { kind: 'scrollIntoView' }, options?.timeout),
    );
  }

  override swipe(options: SwipeOptions & ActionOptions): Promise<void> {
    return this.action('locator.swipe', () =>
      this.context.engine.perform(
        this.expression,
        { kind: 'swipe', direction: options.direction, ...(options.momentum !== undefined ? { momentum: options.momentum } : {}) },
        options.timeout,
      ),
    );
  }

  async textContent(): Promise<string | null> {
    const node = await this.readGuarded();
    if (node.text === undefined) return null;
    return normalizeText(node.text);
  }

  async inputValue(): Promise<string> {
    const node = await this.readGuarded();
    return node.value ?? '';
  }

  async getAttribute(name: string): Promise<string | null> {
    const node = await this.readGuarded();
    return attributeOf(node, name);
  }

  async isVisible(): Promise<boolean> {
    return isNodeVisible(await this.context.engine.readNow(this.expression));
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  async isEnabled(): Promise<boolean> {
    const node = await this.readGuarded(false);
    return node.states?.disabled !== true;
  }

  async isDisabled(): Promise<boolean> {
    return !(await this.isEnabled());
  }

  async isChecked(): Promise<boolean> {
    const node = await this.readGuarded(false);
    return node.states?.checked === true;
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const node = await this.readGuarded(false);
    return node.rect ?? null;
  }

  async count(): Promise<number> {
    const refs = await this.context.engine.resolveNow(this.expression);
    return refs.length;
  }

  async all(): Promise<Locator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_, index) => this.nth(index));
  }

  async allTextContents(): Promise<string[]> {
    const nodes = await this.context.engine.readAllNow(this.expression);
    if (nodes.some((node) => node.states?.secure === true)) {
      throw new ConfigurationError(
        'POLICY_DENIED',
        `reading values from a secure field is denied: ${this.label}`,
      );
    }
    return nodes.map((node) => normalizeText(node.text ?? ''));
  }

  async waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void> {
    const state = options?.state ?? 'visible';
    await this.context.steps.run('locator', 'locator.waitFor', `${this.label} → ${state}`, async () => {
      const { engine } = this.context;
      const deadline = engine.deadline(options?.timeout);
      await pollCondition({
        deadline,
        signal: engine.signal,
        negated: false,
        evaluate: async () => {
          const { node } = await engine.tryRead(this.expression, deadline);
          const visible = isNodeVisible(node);
          return state === 'visible' ? visible : !visible;
        },
        onTimeout: () =>
          new TestError('LOCATOR_NOT_FOUND', `locator did not become ${state}: ${this.label}`),
      });
    }, { verifies: true });
  }

  filter(options: { hasText?: TextMatch; has?: Locator }): Locator {
    const hasExpression =
      options.has === undefined ? undefined : this.ownLocator(options.has, 'filter({ has })').expression;
    return new LocatorImpl(
      this.context,
      filterExpression(this.expression, {
        ...(options.hasText !== undefined ? { hasText: options.hasText } : {}),
        ...(hasExpression !== undefined ? { has: hasExpression } : {}),
      }),
    );
  }

  first(): Locator {
    return new LocatorImpl(this.context, indexExpression(this.expression, 'first'));
  }

  last(): Locator {
    return new LocatorImpl(this.context, indexExpression(this.expression, 'last'));
  }

  nth(index: number): Locator {
    return new LocatorImpl(this.context, indexExpression(this.expression, index));
  }

  private async readGuarded(guardSecure = true): Promise<SemanticNode> {
    const node = await this.context.engine.read(this.expression);
    if (guardSecure && node.states?.secure === true) {
      throw new ConfigurationError(
        'POLICY_DENIED',
        `reading values from a secure field is denied: ${this.label}`,
      );
    }
    return node;
  }
}

/** Whether swipe options name a path (`from`, `to`) rather than a direction. */
function isSwipePath(options: SwipeOptions | SwipePathOptions): options is SwipePathOptions {
  return typeof options === 'object' && options !== null && ('from' in options || 'to' in options);
}

/** Validates a point a test names: finite, and never off the plane. */
function requirePoint(point: Point | undefined, what: string): Point {
  const at = requireFinitePoint(point, what);
  if (at.x < 0 || at.y < 0) {
    throw new TestError('INVALID_ARGUMENT', `${what} requires a point { x, y } of non-negative numbers`);
  }
  return at;
}

/** A point as the report shows it. */
function describePoint(point: Point): string {
  return `(${point.x}, ${point.y})`;
}

/** Validates the pause between typed characters: a finite, non-negative number of milliseconds. */
function validateDelay(delay: number | undefined): number | undefined {
  if (delay === undefined) return undefined;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    throw new TestError('INVALID_ARGUMENT', 'pressSequentially delay must be a non-negative number of milliseconds');
  }
  return delay;
}

/** Validates the shared long-press duration bound. */
function validateLongPress(durationMs: number | undefined): number {
  const value = durationMs ?? 500;
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `longPress duration must be an integer from 100 through 10000, got ${String(durationMs)}`,
    );
  }
  return value;
}
