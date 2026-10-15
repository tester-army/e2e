/** Runner-owned polling locator assertions. */

import type { SemanticNode } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import { rejectUnknownOptions } from '../internal/options.ts';
import {
  isTextMatch,
  normalizeText,
  compareText,
  toTextPattern,
  describePattern,
  withIgnoreCase,
  type TextComparison,
  type TextPattern,
} from '../internal/text.ts';
import { isValueControl } from '../internal/roles.ts';
import { Deadline, pollCondition } from '../internal/time.ts';
import { SampleHistory } from './samples.ts';
import { attributeOf, denySecureRead, isNodeVisible } from '../locator/engine.ts';
import { describeExpression } from '../locator/expression.ts';
import type { LocatorInternals } from '../locator/screen.ts';
import type { AsyncExpectation, ScreenshotOptions, TextMatch, TextMatcherOptions } from '../types.ts';
import { expectScreenshot } from './screenshot.ts';

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
  /**
   * The predicate is meaningful even when zero nodes match, so a locator
   * under a frame that is not in the document samples as zero matches
   * instead of waiting for the frame.
   */
  readonly evaluableWithoutNode?: boolean;
  /**
   * Whether the one matched node can answer the predicate at all. A node it
   * rejects keeps the poll waiting, negated or not: `not.toHaveValue` on a
   * heading is not a pass.
   */
  readonly evaluableNode?: (node: SemanticNode) => boolean;
  /**
   * The matcher reads what an engine withholds on a secure field, its value,
   * text, or attributes; a name is never withheld. A secure node in the sample
   * is denied like the locator getters, negated or not, before the predicate
   * or the failure message reads it: withheld is redacted, not empty or absent.
   */
  readonly readsWithheld?: boolean;
  readonly predicate: (sample: Sample) => boolean;
  readonly describeExpected: string;
  readonly observed: (sample: Sample) => string;
}

type StateKey = 'disabled' | 'checked' | 'selected' | 'expanded' | 'focused';

interface StateMatcherDef {
  readonly key: StateKey;
  readonly expected: boolean;
  readonly describeExpected: string;
  /** Playwright's boolean option that flips the matcher, `{ checked: false }`, and what it then expects. */
  readonly flag?: { readonly option: string; readonly describeExpected: string };
}

const STATE_MATCHERS = {
  toBeEnabled: {
    key: 'disabled',
    expected: false,
    describeExpected: 'enabled',
    flag: { option: 'enabled', describeExpected: 'disabled' },
  },
  toBeDisabled: { key: 'disabled', expected: true, describeExpected: 'disabled' },
  toBeChecked: {
    key: 'checked',
    expected: true,
    describeExpected: 'checked',
    flag: { option: 'checked', describeExpected: 'unchecked' },
  },
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
  /** Whether the matcher takes Playwright's `ignoreCase`. */
  readonly takesIgnoreCase: boolean;
}

const TEXT_MATCHERS = {
  toHaveText: {
    field: 'text',
    mode: 'equals',
    normalize: true,
    describeExpected: (pattern) => `text ${pattern}`,
    takesIgnoreCase: true,
  },
  toContainText: {
    field: 'text',
    mode: 'contains',
    normalize: true,
    describeExpected: (pattern) => `text containing ${pattern}`,
    takesIgnoreCase: true,
  },
  toHaveValue: {
    field: 'value',
    mode: 'equals',
    normalize: false,
    describeExpected: (pattern) => `value ${pattern}`,
    takesIgnoreCase: false,
  },
  toHaveAccessibleName: {
    field: 'name',
    mode: 'equals',
    normalize: true,
    describeExpected: (pattern) => `accessible name ${pattern}`,
    takesIgnoreCase: true,
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

  /** The matcher's name as its step and its errors print it: `expect.not.toBeChecked`. */
  private api(name: string): string {
    return `expect.${this.negated ? 'not.' : ''}${name}`;
  }

  /**
   * Refuses an option `name` does not take before anything is read: a
   * JavaScript caller's Playwright option must fail, not run as if absent.
   * Returns the boolean `flag` option, `undefined` when absent.
   */
  private readOptions(name: string, options: object | undefined, flag?: string): boolean | undefined {
    const api = this.api(name);
    rejectUnknownOptions(api, options, flag === undefined ? ['timeout'] : [flag, 'timeout']);
    if (flag === undefined || options === undefined) return undefined;
    const value: unknown = Reflect.get(options, flag);
    if (value === undefined || typeof value === 'boolean') return value;
    throw new TestError('INVALID_ARGUMENT', `${api} option ${flag} must be a boolean`);
  }

  private async poll(spec: MatcherSpec, timeout: number | undefined): Promise<void> {
    const { engine } = this.internals.context;
    const api = this.api(spec.name);
    await this.internals.context.steps.run('assertion', api, this.label, async () => {
      const deadline = engine.deadline(timeout ?? engine.assertionTimeout);
      let lastSample: Sample = { count: 0, node: null, nodes: [] };
      const samples = new SampleHistory('expect', (text) => engine.redact(text));
      await samples.record(engine, () =>
        pollCondition({
          deadline,
          signal: engine.signal,
          negated: this.negated,
          evaluate: async () => {
            const sample = await this.sample(spec, deadline);
            lastSample = sample;
            if (spec.readsWithheld === true) {
              denySecureRead(sample.node === null ? sample.nodes : [sample.node], this.label);
            }
            samples.add(`${spec.observed(sample)} (${sample.count} ${sample.count === 1 ? 'match' : 'matches'})`);
            if (!this.conditionEvaluable(spec, sample)) return undefined;
            return spec.predicate(sample);
          },
          onTimeout: (cause) => {
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
                ...(cause === undefined ? {} : { cause }),
              },
            );
          },
        }),
      );
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
    const missingFrame = spec.evaluableWithoutNode === true ? 'empty' : 'wait';
    const { node, count } = await engine.tryRead(this.internals.expression, deadline, missingFrame);
    return { count, node, nodes: [] };
  }

  /** A state matcher; its Playwright flag set to `false` expects the opposite state. */
  private stateMatcher(name: keyof typeof STATE_MATCHERS, options: { timeout?: number } | undefined): Promise<void> {
    const def: StateMatcherDef = STATE_MATCHERS[name];
    const holds = this.readOptions(name, options, def.flag?.option) ?? true;
    const expected = holds ? def.expected : !def.expected;
    return this.poll(
      {
        name,
        predicate: (sample) =>
          sample.node !== null && (sample.node.states?.[def.key] === true) === expected,
        describeExpected: holds || def.flag === undefined ? def.describeExpected : def.flag.describeExpected,
        observed: observedState,
      },
      options?.timeout,
    );
  }

  /** `toBeVisible` and `toBeHidden`: not visible means hidden or absent. */
  private visibilityMatcher(
    name: 'toBeVisible' | 'toBeHidden',
    visible: boolean,
    timeout: number | undefined,
  ): Promise<void> {
    return this.poll(
      {
        name,
        evaluableWithoutNode: true,
        predicate: (sample) => isNodeVisible(sample.node) === visible,
        describeExpected: visible ? 'visible' : 'hidden or absent',
        observed: visible ? observedState : (sample) => (isNodeVisible(sample.node) ? 'visible' : 'hidden'),
      },
      timeout,
    );
  }

  private textMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: TextMatch | readonly TextMatch[],
    options: TextMatcherOptions | undefined,
  ): Promise<void> {
    const def: TextMatcherDef = TEXT_MATCHERS[name];
    const ignoreCase = this.readOptions(name, options, def.takesIgnoreCase ? 'ignoreCase' : undefined);
    const comparison: TextComparison = { mode: def.mode, normalize: def.normalize, ignoreCase };
    if (isTextMatchList(expected)) return this.textListMatcher(name, expected, comparison, options?.timeout);
    const pattern = withIgnoreCase(toTextPattern(expected, { exact: true }), ignoreCase);
    return this.poll(
      {
        name,
        readsWithheld: def.field !== 'name',
        evaluableNode: (node) => readField(def, node) !== undefined,
        predicate: (sample) => {
          const actual = sample.node === null ? undefined : readField(def, sample.node);
          return actual !== undefined && compareText(actual, pattern, comparison);
        },
        describeExpected: def.describeExpected(describeText(pattern, ignoreCase)),
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const actual = readField(def, sample.node);
          if (actual === undefined) return `no ${def.field} (not a form control)`;
          return `${def.field} ${printField(def, actual)}`;
        },
      },
      options?.timeout,
    );
  }

  /**
   * The list form. `toHaveText` needs exactly as many matches as entries,
   * each match satisfying the entry at its position; `toContainText` needs
   * each entry contained by a distinct match, in order, as Playwright's does.
   */
  private textListMatcher(
    name: keyof typeof TEXT_MATCHERS,
    expected: readonly TextMatch[],
    comparison: TextComparison,
    timeout: number | undefined,
  ): Promise<void> {
    const def = TEXT_MATCHERS[name];
    const patterns = expected.map((entry) =>
      withIgnoreCase(toTextPattern(entry, { exact: true }), comparison.ignoreCase),
    );
    const printed = (node: SemanticNode): string => {
      const actual = readField(def, node);
      return actual === undefined ? `no ${def.field}` : printField(def, actual);
    };
    const satisfies = (node: SemanticNode, pattern: TextPattern): boolean => {
      const actual = readField(def, node);
      return actual !== undefined && compareText(actual, pattern, comparison);
    };
    const matchesList = def.mode === 'contains' ? matchesSubsequence : matchesPositionally;
    return this.poll(
      {
        name,
        readsWithheld: def.field !== 'name',
        wholeSet: 'read',
        predicate: (sample) => matchesList(sample.nodes, patterns, satisfies),
        describeExpected: def.describeExpected(
          `[${patterns.map((pattern) => describeText(pattern, comparison.ignoreCase)).join(', ')}]`,
        ),
        observed: (sample) => `${def.field} [${sample.nodes.map(printed).join(', ')}]`,
      },
      timeout,
    );
  }

  toBeVisible(options?: { visible?: boolean; timeout?: number }): Promise<void> {
    const visible = this.readOptions('toBeVisible', options, 'visible') ?? true;
    return this.visibilityMatcher('toBeVisible', visible, options?.timeout);
  }

  toBeHidden(options?: { timeout?: number }): Promise<void> {
    this.readOptions('toBeHidden', options);
    return this.visibilityMatcher('toBeHidden', false, options?.timeout);
  }

  toBeAttached(options?: { attached?: boolean; timeout?: number }): Promise<void> {
    const attached = this.readOptions('toBeAttached', options, 'attached') ?? true;
    return this.poll(
      {
        name: 'toBeAttached',
        evaluableWithoutNode: true,
        predicate: (sample) => (sample.node !== null) === attached,
        describeExpected: attached ? 'attached' : 'detached',
        observed: (sample) => (sample.node === null ? 'no node' : 'attached'),
      },
      options?.timeout,
    );
  }

  toBeEnabled(options?: { enabled?: boolean; timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeEnabled', options);
  }

  toBeDisabled(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeDisabled', options);
  }

  toBeChecked(options?: { checked?: boolean; timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeChecked', options);
  }

  toBeSelected(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeSelected', options);
  }

  toBeExpanded(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeExpanded', options);
  }

  toBeFocused(options?: { timeout?: number }): Promise<void> {
    return this.stateMatcher('toBeFocused', options);
  }

  toHaveText(expected: TextMatch | readonly TextMatch[], options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toHaveText', expected, options);
  }

  toContainText(expected: TextMatch | readonly TextMatch[], options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toContainText', expected, options);
  }

  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    return this.textMatcher('toHaveValue', expected, options);
  }

  toHaveAttribute(
    name: string,
    valueOrOptions?: TextMatch | { timeout?: number },
    options?: TextMatcherOptions,
  ): Promise<void> {
    const hasValue = isTextMatch(valueOrOptions);
    // Presence reads the third argument too when the value is `undefined`, as Playwright does.
    const bag = hasValue ? options : valueOrOptions === undefined ? options : valueOrOptions;
    const ignoreCase = this.readOptions('toHaveAttribute', bag, hasValue ? 'ignoreCase' : undefined);
    const pattern = hasValue ? withIgnoreCase(toTextPattern(valueOrOptions, { exact: true }), ignoreCase) : undefined;
    const comparison: TextComparison = { mode: 'equals', normalize: true, ignoreCase };
    return this.poll(
      {
        name: 'toHaveAttribute',
        readsWithheld: true,
        predicate: (sample) => {
          if (sample.node === null) return false;
          const attribute = attributeOf(sample.node, name);
          return attribute !== null && (pattern === undefined || compareText(attribute, pattern, comparison));
        },
        describeExpected:
          pattern === undefined
            ? `attribute "${name}"`
            : `attribute "${name}" ${describeText(pattern, ignoreCase)}`,
        observed: (sample) => {
          if (sample.node === null) return 'no node';
          const attribute = attributeOf(sample.node, name);
          return attribute === null
            ? `attribute "${name}" absent`
            : `attribute "${name}" ${JSON.stringify(attribute)}`;
        },
      },
      bag?.timeout,
    );
  }

  toHaveAccessibleName(expected: TextMatch, options?: TextMatcherOptions): Promise<void> {
    return this.textMatcher('toHaveAccessibleName', expected, options);
  }

  toHaveScreenshot(nameOrOptions?: string | ScreenshotOptions, options?: ScreenshotOptions): Promise<void> {
    return expectScreenshot(this.internals.context, this.internals.expression, this.negated, nameOrOptions, options);
  }

  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void> {
    this.readOptions('toHaveCount', options);
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

type NodeSatisfies = (node: SemanticNode, pattern: TextPattern) => boolean;

/** Whether there are exactly as many nodes as patterns, each satisfying the pattern at its position. */
function matchesPositionally(
  nodes: readonly SemanticNode[],
  patterns: readonly TextPattern[],
  satisfies: NodeSatisfies,
): boolean {
  return nodes.length === patterns.length && patterns.every((pattern, index) => satisfies(nodes[index]!, pattern));
}

/**
 * Whether every pattern is satisfied by a distinct node, in order. Greedy:
 * each pattern takes the first node after the previous pattern's that
 * satisfies it, which finds a subsequence whenever one exists.
 */
function matchesSubsequence(
  nodes: readonly SemanticNode[],
  patterns: readonly TextPattern[],
  satisfies: NodeSatisfies,
): boolean {
  let next = 0;
  for (const node of nodes) {
    if (next === patterns.length) break;
    if (satisfies(node, patterns[next]!)) next += 1;
  }
  return next === patterns.length;
}

/**
 * The node's field as the matcher reads it. Text and name read as the empty
 * string when absent, since a node without text has none. A value reads as
 * the empty string only on a control whose role carries one, because a
 * device engine omits an empty value; any other node is not a form control
 * and cannot answer `toHaveValue` at all.
 */
function readField(def: TextMatcherDef, node: SemanticNode): string | undefined {
  const raw = node[def.field];
  if (raw !== undefined) return raw;
  if (def.field !== 'value') return '';
  return isValueControl(node) ? '' : undefined;
}

/** A pattern as a failure message prints it, marking a string compared ignoring case. */
function describeText(pattern: TextPattern, ignoreCase: boolean | undefined): string {
  const described = describePattern(pattern);
  return pattern.kind === 'string' && ignoreCase === true ? `${described} (ignoring case)` : described;
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
