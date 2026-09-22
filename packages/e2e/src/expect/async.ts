/** Runner-owned polling locator assertions. */

import type { SemanticNode } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import { normalizeText, containsText, matchesText, toTextPattern, describePattern } from '../internal/text.ts';
import { Deadline, pollCondition } from '../internal/time.ts';
import { isNodeVisible } from '../locator/engine.ts';
import { describeExpression } from '../locator/expression.ts';
import type { LocatorInternals } from '../locator/screen.ts';
import type { AsyncExpectation, TextMatch } from '../types.ts';

interface Sample {
  readonly count: number;
  readonly node: SemanticNode | null;
  /** Every current match, read; only a `wholeSet: 'read'` matcher asks for them. */
  readonly nodes: readonly SemanticNode[];
}

interface MatcherSpec {
  readonly name: string;
  /**
   * Evaluates the whole sample instead of requiring one node: `true` counts
   * the matches, `'read'` also reads each of them.
   */
  readonly wholeSet?: boolean | 'read';
  /** The predicate is meaningful even when zero nodes match. */
  readonly evaluableWithoutNode?: boolean;
  readonly predicate: (sample: Sample) => boolean;
  readonly describeExpected: string;
  readonly observed: (sample: Sample) => string;
}

type StateKey = 'disabled' | 'checked' | 'selected' | 'expanded' | 'focused';

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
  toBeFocused: { key: 'focused', expected: true, describeExpected: 'focused' },
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
      let lastSample: Sample = { count: 0, node: null, nodes: [] };
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
        onTimeout: () => {
          const expected = `${this.negated ? 'not ' : ''}${spec.describeExpected}`;
          const observed = spec.observed(lastSample);
          return new TestError(
            'ASSERTION_FAILED',
            [
              `${api} failed`,
              `locator: ${this.label}`,
              `expected: ${expected}`,
              `observed: ${observed} (match count ${lastSample.count})`,
            ].join('\n'),
            {
              // The same facts, one per field, for a reporter that lays them out.
              details: { locator: this.label, expected, observed, matches: lastSample.count },
            },
          );
        },
      });
    }, { verifies: true });
  }

  /**
   * Single-node matchers require an unambiguous node before their predicate
   * means anything; visibility matchers also accept zero matches.
   */
  private conditionEvaluable(spec: MatcherSpec, sample: Sample): boolean {
    return spec.wholeSet !== undefined || sample.node !== null || spec.evaluableWithoutNode === true;
  }

  private async sample(spec: MatcherSpec, deadline: Deadline): Promise<Sample> {
    const { engine } = this.internals.context;
    if (spec.wholeSet === 'read') {
      const nodes = await engine.readAll(this.internals.expression, deadline);
      return { count: nodes.length, node: null, nodes };
    }
    if (spec.wholeSet === true) {
      const refs = await engine.resolveAll(this.internals.expression, deadline);
      return { count: refs.length, node: null, nodes: [] };
    }
    const { node, count } = await engine.tryRead(this.internals.expression, deadline);
    return { count, node, nodes: [] };
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
    expected: TextMatch | readonly TextMatch[],
    timeout: number | undefined,
  ): Promise<void> {
    if (isTextMatchList(expected)) return this.textListMatcher(name, expected, timeout);
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

  /**
   * The list form: exactly as many matches as entries, each match's field
   * satisfying the entry at its position.
   */
  private textListMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: readonly TextMatch[],
    timeout: number | undefined,
  ): Promise<void> {
    const def = TEXT_MATCHERS[name];
    const patterns = expected.map((entry) => toTextPattern(entry, { exact: true }));
    const fieldOf = (node: SemanticNode): string => {
      const raw = node[def.field] ?? '';
      return def.normalize ? normalizeText(raw) : raw;
    };
    return this.poll(
      {
        name,
        wholeSet: 'read',
        predicate: (sample) =>
          sample.nodes.length === patterns.length &&
          patterns.every((pattern, index) => def.match(sample.nodes[index]![def.field] ?? '', pattern)),
        describeExpected: def.describeExpected(`[${patterns.map(describePattern).join(', ')}]`),
        observed: (sample) => `${def.field} [${sample.nodes.map((node) => JSON.stringify(fieldOf(node))).join(', ')}]`,
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
        observed: (sample) => (isNodeVisible(sample.node) ? 'visible' : 'hidden'),
      },
      options?.timeout,
    );
  }

  toBeAttached(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeAttached',
        evaluableWithoutNode: true,
        predicate: (sample) => sample.node !== null,
        describeExpected: 'attached',
        observed: (sample) => (sample.node === null ? 'no node' : 'attached'),
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

  toBeFocused(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeFocused', options?.timeout);
  }

  toHaveText(expected: TextMatch | readonly TextMatch[], options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveText', expected, options?.timeout);
  }

  toContainText(expected: TextMatch | readonly TextMatch[], options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toContainText', expected, options?.timeout);
  }

  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveValue', expected, options?.timeout);
  }

  toHaveAttribute(
    name: string,
    valueOrOptions?: TextMatch | { timeout?: number },
    options?: { timeout?: number },
  ): Promise<void> {
    let value: TextMatch | undefined;
    let timeout: number | undefined;
    if (typeof valueOrOptions === 'string' || valueOrOptions instanceof RegExp) {
      value = valueOrOptions;
      timeout = options?.timeout;
    } else {
      timeout = valueOrOptions?.timeout;
    }
    const pattern = value === undefined ? undefined : toTextPattern(value, { exact: true });
    return this.poll(
      {
        name: 'toHaveAttribute',
        predicate: (sample) => {
          if (sample.node === null) return false;
          const attribute = sample.node.attributes?.[name];
          return attribute !== undefined && (pattern === undefined || matchesText(attribute, pattern));
        },
        describeExpected:
          pattern === undefined
            ? `attribute "${name}"`
            : `attribute "${name}" ${describePattern(pattern)}`,
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const attribute = sample.node.attributes?.[name];
          return attribute === undefined
            ? `attribute "${name}" absent`
            : `attribute "${name}" ${JSON.stringify(attribute)}`;
        },
      },
      timeout,
    );
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

/** A list of text matches, as opposed to one string or RegExp. */
function isTextMatchList(expected: TextMatch | readonly TextMatch[]): expected is readonly TextMatch[] {
  return Array.isArray(expected);
}

/**
 * The node's active states, `hidden` naming what the platform says excludes
 * the node when it is not layout (`hidden by aria-hidden`), so a failure on
 * text a person sees explains itself.
 */
function observedState(sample: Sample): string {
  if (sample.node === null) return 'no node';
  const { states = {}, hiddenBy } = sample.node;
  const active = Object.entries(states)
    .filter(([, value]) => value === true)
    .map(([key]) => (key === 'hidden' && hiddenBy !== undefined ? `hidden by ${hiddenBy}` : key));
  return active.length === 0 ? 'default states' : `states: ${active.join(', ')}`;
}

export function createAsyncExpectation(internals: LocatorInternals): AsyncExpectation {
  return new AsyncExpectationImpl(internals, false);
}
