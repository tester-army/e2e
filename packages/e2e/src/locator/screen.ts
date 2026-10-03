/** Public Screen and Locator surfaces bound to one attempt. */

import nodePath from 'node:path';
import { describeValue } from '../config/validate.ts';
import { isKeyModifier, KEY_MODIFIERS, type KeyModifier } from '../engine/contract.ts';
import type { LocatorAction, LocatorExpression, SemanticNode } from '../engine/surface.ts';
import { locatorBrand } from '../internal/brands.ts';
import { isSecret } from '../secrets.ts';
import { asEngineError, TestError } from '../internal/errors.ts';
import { requireFinitePoint } from '../internal/geometry.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { obj } from '../internal/objects.ts';
import { isTextMatch, normalizeText } from '../internal/text.ts';
import type {
  ActionOptions,
  ClickOptions,
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
import { attributeOf, denySecureRead, isNodeVisible, locatorDetails, type LocatorEngine, type NodeInspector } from './engine.ts';
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

/** The keys of `TextMatchOptions`, what every text-family query takes. */
const TEXT_OPTION_KEYS = ['exact', 'visible'] as const;

/** The keys of `RoleOptions` beside the accessible name: the text-match keys and the states. */
const ROLE_FILTER_KEYS = [...TEXT_OPTION_KEYS, 'checked', 'disabled', 'selected', 'expanded', 'pressed', 'level'] as const;

/** The keys of `RoleOptions`: the accessible name and the filters. */
const ROLE_OPTION_KEYS = ['name', ...ROLE_FILTER_KEYS] as const;

/** The states `locator.waitFor` waits for, Playwright's four. */
const WAIT_FOR_STATES: readonly string[] = ['attached', 'detached', 'visible', 'hidden'];

/** The states absence satisfies: a frame missing from the document reads as zero matches for them. */
const ABSENCE_STATES: ReadonlySet<string> = new Set(['detached', 'hidden']);

type WaitForState = NonNullable<NonNullable<Parameters<Locator['waitFor']>[0]>['state']>;

/**
 * Whether the one match, or its absence, is in `state`: `attached` is any
 * match, `detached` none, `visible` a match that is not hidden, and `hidden`
 * a hidden match or none.
 */
function inWaitForState(node: SemanticNode | null, state: WaitForState): boolean {
  switch (state) {
    case 'attached':
      return node !== null;
    case 'detached':
      return node === null;
    case 'visible':
      return isNodeVisible(node);
    case 'hidden':
      return !isNodeVisible(node);
  }
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

  getByRole(role: Role | RoleAlias, nameOrOptions?: TextMatch | RoleOptions, maybeOptions?: Omit<RoleOptions, 'name'>): Locator {
    const named = isTextMatch(nameOrOptions);
    if (!named && maybeOptions !== undefined) {
      throw new TestError('INVALID_LOCATOR', 'getByRole takes options as its third argument only after a name: getByRole(role, name, options)');
    }
    const options = named ? maybeOptions : nameOrOptions;
    rejectUnknownOptions('getByRole', options, named ? ROLE_FILTER_KEYS : ROLE_OPTION_KEYS, 'INVALID_LOCATOR');
    const query = named ? { ...options, name: nameOrOptions } : options;
    return new LocatorImpl(this.context, this.build(roleQuery(role, query, this.scope)));
  }

  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator {
    rejectUnknownOptions('getByLabel', options, TEXT_OPTION_KEYS, 'INVALID_LOCATOR');
    return new LocatorImpl(this.context, this.build(textQuery('label', text, options, this.scope)));
  }

  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator {
    rejectUnknownOptions('getByPlaceholder', options, TEXT_OPTION_KEYS, 'INVALID_LOCATOR');
    return new LocatorImpl(
      this.context,
      this.build(textQuery('placeholder', text, options, this.scope)),
    );
  }

  getByText(text: TextMatch, options?: TextMatchOptions): Locator {
    rejectUnknownOptions('getByText', options, TEXT_OPTION_KEYS, 'INVALID_LOCATOR');
    return new LocatorImpl(this.context, this.build(textQuery('text', text, options, this.scope)));
  }

  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator {
    rejectUnknownOptions('getByDisplayValue', options, TEXT_OPTION_KEYS, 'INVALID_LOCATOR');
    return new LocatorImpl(
      this.context,
      this.build(textQuery('displayValue', value, options, this.scope)),
    );
  }

  getByTestId(id: TextMatch, options?: { visible?: boolean }): Locator {
    rejectUnknownOptions('getByTestId', options, ['visible'], 'INVALID_LOCATOR');
    return new LocatorImpl(this.context, this.build(testIdQuery(id, options, this.scope)));
  }

  async tapAt(point: Point, options?: ActionOptions): Promise<void> {
    rejectUnknownOptions('tapAt', options, ['timeout']);
    const at = requirePoint(point, 'tapAt');
    await this.context.steps.run('screen', 'screen.tapAt', describePoint(at), async () => {
      this.context.steps.amendTarget({ point: { x: at.x, y: at.y } });
      await this.context.engine.performAt(at, { kind: 'tap' }, options?.timeout);
    });
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
      const startedMs = Date.now();
      const notVisible = (cause?: unknown) =>
        new TestError('LOCATOR_NOT_FOUND', `target did not become visible while scrolling: ${label}`, {
          details: locatorDetails(internals.expression, Date.now() - startedMs),
          ...(cause === undefined ? {} : { cause }),
        });
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

  /**
   * Types `text` through `act`, then records it as the step's argument only
   * when the field it went into was read and is not secure. A secure field,
   * or one the read could not see, records `<withheld>`: plain text typed into
   * a password field is as private as a secret.
   */
  private async typedInto(text: string, act: (inspect: NodeInspector) => Promise<void>): Promise<void> {
    let shareable = false;
    const record = this.recordTarget();
    await act((node) => {
      shareable = node !== null && node.states?.secure !== true;
      record(node);
    });
    this.context.steps.amendArgument(shareable ? JSON.stringify(text) : '<withheld>');
  }

  /** Records the box of the node an action resolved to, and the point it acted at when it was positioned. */
  private recordTarget(offset?: Point): NodeInspector {
    return (node) => {
      const box = node?.rect;
      if (box === undefined) return;
      this.context.steps.amendTarget({
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        ...(offset === undefined ? {} : { point: { x: box.x + offset.x, y: box.y + offset.y } }),
      });
    };
  }

  private action(api: string, body: () => Promise<void>, argument?: string): Promise<void> {
    return this.context.steps.run('locator', api, this.label, body, argument === undefined ? {} : { argument });
  }

  /**
   * One action on the node for a verb that takes only a timeout. Any other
   * option key (Playwright's `trial`, `force`, `noWaitAfter`) throws before
   * the step starts, so nothing is resolved or dispatched.
   */
  private perform(
    verb: string,
    action: LocatorAction | ((deadline: Deadline) => Promise<LocatorAction>),
    options: ActionOptions | undefined,
  ): Promise<void> {
    rejectUnknownOptions(verb, options, ['timeout']);
    return this.action(
      `locator.${verb}`,
      () => this.context.engine.perform(this.expression, action, options?.timeout, this.recordTarget()),
      typeof action === 'function' ? undefined : actionArgument(action),
    );
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
    rejectUnknownOptions(api, options, ['timeout', 'position', 'modifiers']);
    const modifiers = requireModifiers(options?.modifiers, api);
    if (options?.position === undefined) return this.dispatchTap(api, 'tap', modifiers, options?.timeout);
    if (modifiers.modifiers !== undefined) {
      throw new TestError('INVALID_ARGUMENT', `${api}() does not take modifiers with a position yet; drop one of them`);
    }
    const position = requirePoint(options.position, `${api} position`);
    return this.context.steps.run(
      'locator',
      `locator.${api}`,
      `${this.label} at ${describePoint(position)}`,
      () => this.context.engine.performWithin(this.expression, position, { kind: 'tap' }, options.timeout, this.recordTarget(position)),
    );
  }

  doubleTap(options?: ClickOptions): Promise<void> {
    return this.clickWith('doubleTap', options);
  }

  secondaryTap(options?: ClickOptions): Promise<void> {
    return this.clickWith('secondaryTap', options);
  }

  /** A double or secondary tap, with the keys `modifiers` holds for it. */
  private clickWith(verb: 'doubleTap' | 'secondaryTap', options: ClickOptions | undefined): Promise<void> {
    rejectUnknownOptions(verb, options, ['timeout', 'modifiers']);
    return this.dispatchTap(verb, verb, requireModifiers(options?.modifiers, verb), options?.timeout);
  }

  /** One tap kind with the keys it holds, named after the node in the step label. */
  private dispatchTap(
    api: string,
    kind: 'tap' | 'doubleTap' | 'secondaryTap',
    held: { modifiers?: readonly KeyModifier[] },
    timeout: number | undefined,
  ): Promise<void> {
    const label = held.modifiers === undefined ? this.label : `${this.label} with ${held.modifiers.join('+')}`;
    return this.context.steps.run('locator', `locator.${api}`, label, () =>
      this.context.engine.perform(this.expression, { kind, ...held }, timeout, this.recordTarget()),
    );
  }

  longPress(options?: LongPressOptions): Promise<void> {
    rejectUnknownOptions('longPress', options, ['timeout', 'duration']);
    const durationMs = validateLongPress(options?.duration);
    return this.action('locator.longPress', () =>
      this.context.engine.perform(this.expression, obj({ kind: 'longPress' as const, durationMs }), options?.timeout, this.recordTarget()),
    );
  }

  fill(value: string | Secret, options?: ActionOptions): Promise<void> {
    rejectUnknownOptions('fill', options, ['timeout']);
    const sensitive = isSecret(value);
    // Resolved inside the recorded step, so a failing provider fails the fill.
    if (sensitive) {
      // A secret by its name only: the value never reaches the record.
      return this.action(
        'locator.fill',
        async () =>
          this.context.engine.perform(
            this.expression,
            { kind: 'fill', value: await this.context.secrets.resolve(value), sensitive },
            options?.timeout,
          ),
        `<secret:${value.name}>`,
      );
    }
    return this.action('locator.fill', () =>
      this.typedInto(value, (inspect) =>
        this.context.engine.perform(this.expression, { kind: 'fill', value, sensitive }, options?.timeout, inspect),
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
      this.typedInto(text, (inspect) =>
        this.context.engine.pressSequentially(this.expression, chunks, delay ?? 0, options?.timeout, inspect),
      ),
    );
  }

  clear(options?: ActionOptions): Promise<void> {
    return this.perform('clear', { kind: 'clear' }, options);
  }

  press(key: string, options?: ActionOptions): Promise<void> {
    return this.perform('press', { kind: 'press', key }, options);
  }

  check(options?: ActionOptions): Promise<void> {
    return this.perform('check', { kind: 'check' }, options);
  }

  uncheck(options?: ActionOptions): Promise<void> {
    return this.perform('uncheck', { kind: 'uncheck' }, options);
  }

  async selectOption(value: SelectOption, options?: ActionOptions): Promise<void> {
    requireSelectOption(value);
    await this.perform('selectOption', { kind: 'selectOption', value }, options);
  }

  focus(options?: ActionOptions): Promise<void> {
    return this.perform('focus', { kind: 'focus' }, options);
  }

  hover(options?: ActionOptions): Promise<void> {
    return this.perform('hover', { kind: 'hover' }, options);
  }

  setInputFiles(paths: string | readonly string[], options?: ActionOptions): Promise<void> {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    if (list.length === 0 || list.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      throw new TestError('INVALID_ARGUMENT', 'setInputFiles requires one or more non-empty paths');
    }
    const base = this.context.projectRoot;
    const resolved = list.map((entry) => (base === undefined ? entry : nodePath.resolve(base, entry)));
    return this.perform('setInputFiles', { kind: 'setInputFiles', paths: resolved }, options);
  }

  dragTo(target: Locator, options?: ActionOptions): Promise<void> {
    const internals = this.ownLocator(target, 'dragTo');
    // The drop target resolves inside the retry, so a superseded target ref
    // is re-resolved along with the source instead of looping until timeout.
    return this.perform(
      'dragTo',
      async (deadline) => ({
        kind: 'dragTo',
        target: await this.context.engine.resolveExactlyOne(internals.expression, deadline),
      }),
      options,
    );
  }

  scrollIntoView(options?: ActionOptions): Promise<void> {
    return this.perform('scrollIntoView', { kind: 'scrollIntoView' }, options);
  }

  override swipe(options: SwipeOptions & ActionOptions): Promise<void> {
    rejectUnknownOptions('swipe', options, ['direction', 'momentum', 'timeout']);
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
    denySecureRead(nodes, this.label);
    return nodes.map((node) => normalizeText(node.text ?? ''));
  }

  async waitFor(options?: { state?: WaitForState; timeout?: number }): Promise<void> {
    rejectUnknownOptions('waitFor', options, ['state', 'timeout']);
    const state = options?.state === undefined ? 'visible' : options.state;
    if (!WAIT_FOR_STATES.includes(state)) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `waitFor state must be one of ${WAIT_FOR_STATES.join(', ')}, got ${JSON.stringify(state)}`,
      );
    }
    await this.context.steps.run('locator', 'locator.waitFor', `${this.label} → ${state}`, async () => {
      const { engine } = this.context;
      const deadline = engine.deadline(options?.timeout);
      const startedMs = Date.now();
      await pollCondition({
        deadline,
        signal: engine.signal,
        negated: false,
        evaluate: async () => {
          const { node } = await engine.tryRead(this.expression, deadline, ABSENCE_STATES.has(state) ? 'empty' : 'wait');
          return inWaitForState(node, state);
        },
        onTimeout: () =>
          new TestError('LOCATOR_NOT_FOUND', `locator did not become ${state}: ${this.label}`, {
            details: locatorDetails(this.expression, Date.now() - startedMs),
          }),
      });
    }, { verifies: true });
  }

  filter(options: { hasText?: TextMatch; has?: Locator }): Locator {
    rejectUnknownOptions('filter', options, ['hasText', 'has'], 'INVALID_LOCATOR');
    const { hasText, has } = options ?? {};
    const hasExpression = has === undefined ? undefined : this.ownLocator(has, 'filter({ has })').expression;
    return new LocatorImpl(
      this.context,
      filterExpression(this.expression, {
        ...(hasText !== undefined ? { hasText } : {}),
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
    if (guardSecure) denySecureRead([node], this.label);
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

/**
 * Refuses a `selectOption` value that is not one option: a label string or an
 * object with exactly one of `label`, `value`, or a nonnegative integer
 * `index`. An engine maps the value field by field, so an array or a
 * mixed object would select an option the test did not name.
 */
function requireSelectOption(value: unknown): void {
  if (Array.isArray(value)) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'selectOption takes one option per call; an array of options is not supported',
    );
  }
  if (typeof value === 'string') return;
  if (isPlainObject(value) && Object.getOwnPropertyNames(value).length === 1) {
    const { label, value: attribute, index } = value;
    if (typeof label === 'string' || typeof attribute === 'string') return;
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) return;
  }
  throw new TestError(
    'INVALID_ARGUMENT',
    'selectOption takes a label string or exactly one of { label }, { value }, { index } with a nonnegative integer index',
  );
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

/** Validates the shared long-press duration bound; none named leaves the hold to the engine's default. */
function validateLongPress(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined) return undefined;
  if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 10_000) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `longPress duration must be an integer from 100 through 10000, got ${String(durationMs)}`,
    );
  }
  return durationMs;
}

/**
 * The `modifiers` of a click, validated: a list of distinct key modifiers,
 * spread into the action only when it names one.
 */
function requireModifiers(value: unknown, api: string): { modifiers?: readonly KeyModifier[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new TestError('INVALID_ARGUMENT', `${api}() modifiers must be an array of ${KEY_MODIFIERS.join(', ')}`);
  }
  const modifiers: KeyModifier[] = [];
  for (const modifier of value) {
    if (!isKeyModifier(modifier)) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `${api}() modifier ${describeValue(modifier)} is not one of ${KEY_MODIFIERS.join(', ')}`,
      );
    }
    if (modifiers.includes(modifier)) throw new TestError('INVALID_ARGUMENT', `${api}() names a modifier twice`);
    modifiers.push(modifier);
  }
  return modifiers.length === 0 ? {} : { modifiers };
}

/** What a locator action was given beside its node, as a step argument; undefined for one that takes nothing. */
function actionArgument(action: LocatorAction): string | undefined {
  switch (action.kind) {
    case 'press':
      return action.key;
    case 'selectOption':
      return JSON.stringify(action.value);
    case 'setInputFiles':
      return action.paths.map((file) => nodePath.basename(file)).join(', ');
    default:
      return undefined;
  }
}
