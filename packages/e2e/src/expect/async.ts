/** Runner-owned polling locator assertions. */

import type { SemanticNode } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import {
  normalizeText,
  compareText,
  matchesText,
  toTextPattern,
  describePattern,
  type TextComparison,
} from '../internal/text.ts';
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
  /**
   * Whether the one matched node can answer the predicate at all. A node it
   * rejects keeps the poll waiting, negated or not: `not.toHaveValue` on a
   * heading is not a pass.
   */
  readonly evaluableNode?: (node: SemanticNode) => boolean;
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

/**
 * One text matcher: the node field it reads and how `compareText` reads the
 * two strings. `normalize: false` compares the raw field, as a form control's
 * value is, and the failure message prints it raw.
 */
interface TextMatcherDef extends TextComparison {
  readonly field: 'text' | 'value' | 'name';
  readonly describeExpected: (pattern: string) => string;
}

const TEXT_MATCHERS = {
  toHaveText: {
    field: 'text',
    mode: 'equals',
    normalize: true,
    describeExpected: (pattern) => `text ${pattern}`,
  },
  toContainText: {
    field: 'text',
    mode: 'contains',
    normalize: true,
    describeExpected: (pattern) => `text containing ${pattern}`,
  },
  toHaveValue: {
    field: 'value',
    mode: 'equals',
    normalize: false,
    describeExpected: (pattern) => `value ${pattern}`,
  },
  toHaveAccessibleName: {
    field: 'name',
    mode: 'equals',
    normalize: true,
    describeExpected: (pattern) => `accessible name ${pattern}`,
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
   * means anything, and may refuse a node that lacks what they read;
   * visibility matchers also accept zero matches.
   */
  private conditionEvaluable(spec: MatcherSpec, sample: Sample): boolean {
    if (spec.wholeSet !== undefined) return true;
    if (sample.node === null) return spec.evaluableWithoutNode === true;
    return spec.evaluableNode?.(sample.node) ?? true;
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
        evaluableNode: (node) => readField(def, node) !== undefined,
        predicate: (sample) => {
          const actual = sample.node === null ? undefined : readField(def, sample.node);
          return actual !== undefined && compareText(actual, pattern, def);
        },
        describeExpected: def.describeExpected(describePattern(pattern)),
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const actual = readField(def, sample.node);
          if (actual === undefined) return `no ${def.field} (not a form control)`;
          return `${def.field} ${printField(def, actual)}`;
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
    const printed = (node: SemanticNode): string => {
      const actual = readField(def, node);
      return actual === undefined ? `no ${def.field}` : printField(def, actual);
    };
    return this.poll(
      {
        name,
        wholeSet: 'read',
        predicate: (sample) =>
          sample.nodes.length === patterns.length &&
          patterns.every((pattern, index) => {
            const actual = readField(def, sample.nodes[index]!);
            return actual !== undefined && compareText(actual, pattern, def);
          }),
        describeExpected: def.describeExpected(`[${patterns.map(describePattern).join(', ')}]`),
        observed: (sample) => `${def.field} [${sample.nodes.map(printed).join(', ')}]`,
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
 * The node's field as the matcher reads it. Text and name read as the empty
 * string when absent, since a node without text has none; a node without a
 * value is not a form control and cannot answer `toHaveValue` at all.
 */
function readField(def: TextMatcherDef, node: SemanticNode): string | undefined {
  return node[def.field] ?? (def.field === 'value' ? undefined : '');
}

/** The field as the failure message prints it: normalized when the comparison was, so the message shows what got compared. */
function printField(def: TextMatcherDef, actual: string): string {
  return JSON.stringify(def.normalize ? normalizeText(actual) : actual);
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
