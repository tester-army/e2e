/** Runner-owned polling locator and web assertions (spec 03-assertions.md). */

import type { SemanticNode } from '../driver/index.js';
import { TestError } from '../internal/errors.js';
import { normalizeText, containsText, matchesText, toTextPattern, describePattern } from '../internal/text.js';
import { urlMatches, type NormalizedBaseUrl } from '../internal/urls.js';
import { Deadline, pollCondition } from '../internal/time.js';
import { isNodeVisible } from '../locator/engine.js';
import { describeExpression } from '../locator/expression.js';
import type { LocatorInternals } from '../locator/screen.js';
import type { AsyncExpectation, TextMatch, WebExpectation } from '../types.js';

interface Sample {
  readonly count: number;
  readonly node: SemanticNode | null;
}

interface MatcherSpec {
  readonly name: string;
  /** Evaluates the whole sample instead of requiring one node. */
  readonly wholeSet?: boolean;
  /** The predicate is meaningful even when zero nodes match. */
  readonly evaluableWithoutNode?: boolean;
  readonly predicate: (sample: Sample) => boolean;
  readonly describeExpected: string;
  readonly observed: (sample: Sample) => string;
}

type StateKey = 'disabled' | 'checked' | 'selected' | 'expanded';

interface StateMatcherDef {
  readonly key: StateKey;
  readonly expected: boolean;
  readonly describeExpected: string;
}

const STATE_MATCHERS = {
  toBeEnabled: { key: 'disabled', expected: false, describeExpected: 'enabled' },
  toBeDisabled: { key: 'disabled', expected: true, describeExpected: 'disabled' },
  toBeChecked: { key: 'checked', expected: true, describeExpected: 'checked' },
  toBeSelected: { key: 'selected', expected: true, describeExpected: 'selected' },
  toBeExpanded: { key: 'expanded', expected: true, describeExpected: 'expanded' },
} as const satisfies Record<string, StateMatcherDef>;

interface TextMatcherDef {
  readonly field: 'text' | 'value' | 'name';
  readonly match: (actual: string, pattern: ReturnType<typeof toTextPattern>) => boolean;
  readonly describeExpected: (pattern: string) => string;
  readonly normalize: boolean;
}

const TEXT_MATCHERS = {
  toHaveText: {
    field: 'text',
    match: matchesText,
    describeExpected: (pattern) => `text ${pattern}`,
    normalize: true,
  },
  toContainText: {
    field: 'text',
    match: containsText,
    describeExpected: (pattern) => `text containing ${pattern}`,
    normalize: true,
  },
  toHaveValue: {
    field: 'value',
    match: matchesText,
    describeExpected: (pattern) => `value ${pattern}`,
    normalize: false,
  },
  toHaveAccessibleName: {
    field: 'name',
    match: matchesText,
    describeExpected: (pattern) => `accessible name ${pattern}`,
    normalize: false,
  },
} as const satisfies Record<string, TextMatcherDef>;

class AsyncExpectationImpl implements AsyncExpectation {
  constructor(
    private readonly internals: LocatorInternals,
    private readonly negated: boolean,
  ) {}

  get not(): AsyncExpectation {
    return new AsyncExpectationImpl(this.internals, !this.negated);
  }

  private get label(): string {
    return describeExpression(this.internals.expression);
  }

  private async poll(spec: MatcherSpec, timeout: number | undefined): Promise<void> {
    const { engine } = this.internals.context;
    const api = `expect.${this.negated ? 'not.' : ''}${spec.name}`;
    await this.internals.context.steps.run('assertion', api, this.label, async () => {
      const deadline = engine.deadline(timeout ?? engine.assertionTimeout);
      let lastSample: Sample = { count: 0, node: null };
      await pollCondition({
        deadline,
        signal: engine.signal,
        negated: this.negated,
        evaluate: async () => {
          const sample = await this.sample(spec, deadline);
          lastSample = sample;
          if (!this.conditionEvaluable(spec, sample)) return undefined;
          return spec.predicate(sample);
        },
        onTimeout: () =>
          new TestError(
            'ASSERTION_FAILED',
            [
              `${api} failed`,
              `locator: ${this.label}`,
              `expected: ${this.negated ? 'not ' : ''}${spec.describeExpected}`,
              `observed: ${spec.observed(lastSample)} (match count ${lastSample.count})`,
            ].join('\n'),
          ),
      });
    });
  }

  /**
   * Single-node matchers require an unambiguous node before their predicate
   * means anything; visibility matchers also accept zero matches.
   */
  private conditionEvaluable(spec: MatcherSpec, sample: Sample): boolean {
    return spec.wholeSet === true || sample.node !== null || spec.evaluableWithoutNode === true;
  }

  private async sample(spec: MatcherSpec, deadline: Deadline): Promise<Sample> {
    const { engine } = this.internals.context;
    if (spec.wholeSet === true) {
      const refs = await engine.resolveAll(this.internals.expression);
      return { count: refs.length, node: null };
    }
    const { node, count } = await engine.tryRead(this.internals.expression, deadline);
    return { count, node };
  }

  private stateMatcher(name: keyof typeof STATE_MATCHERS, timeout: number | undefined): Promise<void> {
    const def = STATE_MATCHERS[name];
    return this.poll(
      {
        name,
        predicate: (sample) =>
          sample.node !== null && (sample.node.states?.[def.key] === true) === def.expected,
        describeExpected: def.describeExpected,
        observed: observedState,
      },
      timeout,
    );
  }

  private textMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: TextMatch,
    timeout: number | undefined,
  ): Promise<void> {
    const def = TEXT_MATCHERS[name];
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name,
        predicate: (sample) => sample.node !== null && def.match(sample.node[def.field] ?? '', pattern),
        describeExpected: def.describeExpected(describePattern(pattern)),
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const raw = sample.node[def.field] ?? '';
          return `${def.field} ${JSON.stringify(def.normalize ? normalizeText(raw) : raw)}`;
        },
      },
      timeout,
    );
  }

  toBeVisible(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeVisible',
        evaluableWithoutNode: true,
        predicate: (sample) => isNodeVisible(sample.node),
        describeExpected: 'visible',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeHidden(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeHidden',
        evaluableWithoutNode: true,
        predicate: (sample) => !isNodeVisible(sample.node),
        describeExpected: 'hidden or absent',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeEnabled(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeEnabled', options?.timeout);
  }

  toBeDisabled(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeDisabled', options?.timeout);
  }

  toBeChecked(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeChecked', options?.timeout);
  }

  toBeSelected(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeSelected', options?.timeout);
  }

  toBeExpanded(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeExpanded', options?.timeout);
  }

  toHaveText(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveText', expected, options?.timeout);
  }

  toContainText(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toContainText', expected, options?.timeout);
  }

  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveValue', expected, options?.timeout);
  }

  toHaveAccessibleName(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveAccessibleName', expected, options?.timeout);
  }

  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toHaveCount',
        wholeSet: true,
        predicate: (sample) => sample.count === expected,
        describeExpected: `count ${expected}`,
        observed: (sample) => `count ${sample.count}`,
      },
      options?.timeout,
    );
  }
}

function observedState(sample: Sample): string {
  if (sample.node === null) return 'no node';
  const states = sample.node.states ?? {};
  const active = Object.entries(states)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  return active.length === 0 ? 'default states' : `states: ${active.join(', ')}`;
}

export function createAsyncExpectation(internals: LocatorInternals): AsyncExpectation {
  return new AsyncExpectationImpl(internals, false);
}

/** Internal contract the web fixture registers for expect(web). */
export interface WebExpectTarget {
  readonly base: NormalizedBaseUrl;
  readonly assertionTimeout: number;
  readonly signal: AbortSignal;
  url(): Promise<string>;
  title(): Promise<string>;
  runStep(api: string, label: string, body: () => Promise<void>): Promise<void>;
}

class WebExpectationImpl implements WebExpectation {
  constructor(
    private readonly target: WebExpectTarget,
    private readonly negated: boolean,
  ) {}

  get not(): WebExpectation {
    return new WebExpectationImpl(this.target, !this.negated);
  }

  private async poll(
    api: string,
    label: string,
    condition: () => Promise<boolean>,
    observed: () => Promise<string>,
    timeout: number | undefined,
  ): Promise<void> {
    const fullApi = `expect.${this.negated ? 'not.' : ''}${api}`;
    await this.target.runStep(fullApi, label, () =>
      pollCondition({
        deadline: new Deadline(timeout ?? this.target.assertionTimeout),
        signal: this.target.signal,
        negated: this.negated,
        evaluate: condition,
        onTimeout: async () =>
          new TestError(
            'ASSERTION_FAILED',
            `${fullApi} failed\nexpected: ${this.negated ? 'not ' : ''}${label}\nobserved: ${await observed()}`,
          ),
      }),
    );
  }

  toHaveURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void> {
    const label = typeof expected === 'string' ? expected : String(expected);
    return this.poll(
      'toHaveURL',
      `URL ${label}`,
      async () => urlMatches(await this.target.url(), expected, this.target.base),
      async () => `URL ${await this.target.url()}`,
      options?.timeout,
    );
  }

  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      'toHaveTitle',
      `title ${describePattern(pattern)}`,
      async () => matchesText(await this.target.title(), pattern),
      async () => `title ${JSON.stringify(await this.target.title())}`,
      options?.timeout,
    );
  }
}

export function createWebExpectation(target: WebExpectTarget): WebExpectation {
  return new WebExpectationImpl(target, false);
}
