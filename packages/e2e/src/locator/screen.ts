/** Public Screen and Locator surfaces bound to one attempt. */

import nodePath from 'node:path';
import type { LocatorExpression, SemanticNode } from '../driver/index.ts';
import { locatorBrand, secretBrand } from '../internal/brands.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { normalizeText } from '../internal/text.ts';
import type {
  ActionOptions,
  Locator,
  Role,
  RoleOptions,
  Screen,
  Secret,
  SelectOption,
  SwipeOptions,
  TextMatch,
  TextMatchOptions,
} from '../types.ts';
import type { StepRecorder } from '../run/steps.ts';
import { isNodeVisible, type LocatorEngine } from './engine.ts';
import {
  describeExpression,
  filterExpression,
  indexExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from './expression.ts';
import { Deadline, POLL_INTERVAL_MS, pollCondition, sleep } from '../internal/time.ts';

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

/** Creates a screen scope whose queries are wrapped inside one iframe. */
export function createFrameScreen(context: ScreenContext, frameSelector: string): Screen {
  return new ScreenImpl(context, undefined, frameSelector);
}

/** Creates a public locator from a raw expression (web.locator). */
export function createLocator(context: ScreenContext, expression: LocatorExpression): Locator {
  return new LocatorImpl(context, expression);
}

class ScreenImpl implements Screen {
  constructor(
    protected readonly context: ScreenContext,
    protected readonly scope: LocatorExpression | undefined,
    /** When set, every query is wrapped inside this iframe selector. */
    protected readonly frameSelector: string | undefined = undefined,
  ) {}

  private build(expression: LocatorExpression): LocatorExpression {
    if (this.frameSelector === undefined) return expression;
    return { kind: 'frame', selector: this.frameSelector, source: expression };
  }

  getByRole(role: Role, options?: RoleOptions): Locator {
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

  getByTestId(id: string): Locator {
    return new LocatorImpl(this.context, this.build(testIdQuery(id, this.scope)));
  }

  async swipe(options: SwipeOptions): Promise<void> {
    await this.context.steps.run('screen', 'screen.swipe', options.direction, async () => {
      const { engine } = this.context;
      await engine.session.screen.swipe(options.direction, options.momentum, engine.operation());
    });
  }

  async scrollUntilVisible(
    target: Locator,
    options?: { direction?: 'up' | 'down' | 'left' | 'right'; timeout?: number },
  ): Promise<void> {
    const internals = locatorInternals(target);
    if (internals === undefined) {
      throw new TestError('INVALID_LOCATOR', 'scrollUntilVisible requires an e2e locator');
    }
    const direction = options?.direction ?? 'down';
    await this.context.steps.run(
      'screen',
      'screen.scrollUntilVisible',
      describeExpression(internals.expression),
      async () => {
        const { engine } = this.context;
        const deadline = engine.deadline(options?.timeout ?? 30_000);
        for (;;) {
          const { node } = await engine.tryRead(internals.expression, deadline);
          if (isNodeVisible(node)) return;
          if (deadline.expired()) {
            throw new TestError(
              'LOCATOR_NOT_FOUND',
              `target did not become visible while scrolling: ${describeExpression(internals.expression)}`,
            );
          }
          await engine.session.screen.swipe(direction, 'slow', engine.operation());
          await sleep(POLL_INTERVAL_MS, engine.signal);
        }
      },
    );
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

  tap(options?: ActionOptions): Promise<void> {
    return this.action('locator.tap', () =>
      this.context.engine.perform(this.expression, { kind: 'tap' }, options?.timeout),
    );
  }

  click(options?: ActionOptions): Promise<void> {
    return this.action('locator.click', () =>
      this.context.engine.perform(this.expression, { kind: 'tap' }, options?.timeout),
    );
  }

  doubleTap(options?: ActionOptions): Promise<void> {
    return this.action('locator.doubleTap', () =>
      this.context.engine.perform(this.expression, { kind: 'doubleTap' }, options?.timeout),
    );
  }

  longPress(options?: ActionOptions & { durationMs?: number }): Promise<void> {
    const durationMs = validateLongPress(options?.durationMs);
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
    const internals = locatorInternals(target);
    if (internals === undefined) {
      throw new TestError('INVALID_LOCATOR', 'dragTo requires an e2e locator target');
    }
    return this.action('locator.dragTo', async () => {
      const { engine } = this.context;
      const deadline = engine.deadline(options?.timeout);
      const targetRef = await engine.resolveExactlyOne(internals.expression, deadline);
      await engine.perform(
        this.expression,
        { kind: 'dragTo', target: targetRef },
        deadline.remaining(),
      );
    });
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
    return node.attributes?.[name] ?? null;
  }

  async isVisible(): Promise<boolean> {
    return isNodeVisible(await this.readOptional());
  }

  async isEnabled(): Promise<boolean> {
    const node = await this.readGuarded(false);
    return node.states?.disabled !== true;
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
    const refs = await this.context.engine.resolveAll(this.expression);
    return refs.length;
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
    });
  }

  filter(options: { hasText?: TextMatch; has?: Locator }): Locator {
    let hasExpression: LocatorExpression | undefined;
    if (options.has !== undefined) {
      const internals = locatorInternals(options.has);
      if (internals === undefined) {
        throw new TestError('INVALID_LOCATOR', 'filter({ has }) requires an e2e locator');
      }
      hasExpression = internals.expression;
    }
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

  private async readOptional(): Promise<SemanticNode | null> {
    const deadline = new Deadline(0);
    const { node } = await this.context.engine.tryRead(this.expression, deadline);
    return node;
  }
}

/** Validates the shared long-press duration bound (spec 02-test-api.md). */
export function validateLongPress(durationMs: number | undefined): number {
  const value = durationMs ?? 500;
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `longPress durationMs must be an integer from 100 through 10000, got ${String(durationMs)}`,
    );
  }
  return value;
}
