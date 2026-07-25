/** Runner-owned polling locator and web assertions (spec 03-assertions.md). */

import type { SemanticNode } from '../driver/index.js';
import { TestError } from '../internal/errors.js';
import { normalizeText, containsText, matchesText, toTextPattern, describePattern } from '../internal/text.js';
import { urlMatches, type NormalizedBaseUrl } from '../internal/urls.js';
import { Deadline, sleep } from '../internal/time.js';
import { describeExpression } from '../locator/expression.js';
import type { LocatorInternals } from '../locator/screen.js';
import type { AsyncExpectation, TextMatch, WebExpectation } from '../types.js';

const NEGATION_GRACE_MS = 1000;
const POLL_INTERVAL_MS = 100;

interface Sample {
  readonly count: number;
  readonly node: SemanticNode | null;
}

interface MatcherSpec {
  readonly name: string;
  /** Zero matches satisfy the positive condition (toBeHidden family). */
  readonly zeroMatchesPass?: boolean;
  /** Evaluates the whole sample instead of requiring one node. */
  readonly wholeSet?: boolean;
  readonly predicate: (sample: Sample) => boolean;
  readonly describeExpected: string;
  readonly observed: (sample: Sample) => string;
}

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
      let negatedTrueSince: number | undefined;

      for (;;) {
        const sample = await this.sample(spec, deadline);
        lastSample = sample;

        if (!this.negated) {
          if (spec.predicate(sample)) return;
        } else {
          const negatedCondition = this.negatedConditionEvaluable(spec, sample)
            ? !spec.predicate(sample)
            : false;
          if (negatedCondition) {
            negatedTrueSince ??= Date.now();
            if (Date.now() - negatedTrueSince >= NEGATION_GRACE_MS) return;
          } else {
            negatedTrueSince = undefined;
          }
        }

        if (deadline.expired()) {
          throw new TestError(
            'ASSERTION_FAILED',
            [
              `${api} failed`,
              `locator: ${this.label}`,
              `expected: ${this.negated ? 'not ' : ''}${spec.describeExpected}`,
              `observed: ${spec.observed(lastSample)} (match count ${lastSample.count})`,
            ].join('\n'),
          );
        }
        await sleep(POLL_INTERVAL_MS, engine.signal);
      }
    });
  }

  /**
   * Negated single-node matchers still require an unambiguous node, except
   * negated visibility which accepts zero matches.
   */
  private negatedConditionEvaluable(spec: MatcherSpec, sample: Sample): boolean {
    if (spec.wholeSet === true) return true;
    if (sample.node !== null) return true;
    return spec.zeroMatchesPass === true || spec.name === 'toBeVisible';
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

  toBeVisible(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeVisible',
        predicate: (sample) => sample.node !== null && sample.node.states?.hidden !== true,
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
        zeroMatchesPass: true,
        predicate: (sample) => sample.node === null || sample.node.states?.hidden === true,
        describeExpected: 'hidden or absent',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeEnabled(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeEnabled',
        predicate: (sample) => sample.node !== null && sample.node.states?.disabled !== true,
        describeExpected: 'enabled',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeDisabled(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeDisabled',
        predicate: (sample) => sample.node !== null && sample.node.states?.disabled === true,
        describeExpected: 'disabled',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeChecked(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeChecked',
        predicate: (sample) => sample.node !== null && sample.node.states?.checked === true,
        describeExpected: 'checked',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeSelected(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeSelected',
        predicate: (sample) => sample.node !== null && sample.node.states?.selected === true,
        describeExpected: 'selected',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toBeExpanded(options?: { timeout?: number }): Promise<void> {
    return this.poll(
      {
        name: 'toBeExpanded',
        predicate: (sample) => sample.node !== null && sample.node.states?.expanded === true,
        describeExpected: 'expanded',
        observed: observedState,
      },
      options?.timeout,
    );
  }

  toHaveText(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name: 'toHaveText',
        predicate: (sample) => sample.node !== null && matchesText(sample.node.text ?? '', pattern),
        describeExpected: `text ${describePattern(pattern)}`,
        observed: (sample) =>
          sample.node === null ? 'no node' : `text ${JSON.stringify(normalizeText(sample.node.text ?? ''))}`,
      },
      options?.timeout,
    );
  }

  toContainText(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name: 'toContainText',
        predicate: (sample) => sample.node !== null && containsText(sample.node.text ?? '', pattern),
        describeExpected: `text containing ${describePattern(pattern)}`,
        observed: (sample) =>
          sample.node === null ? 'no node' : `text ${JSON.stringify(normalizeText(sample.node.text ?? ''))}`,
      },
      options?.timeout,
    );
  }

  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name: 'toHaveValue',
        predicate: (sample) => sample.node !== null && matchesText(sample.node.value ?? '', pattern),
        describeExpected: `value ${describePattern(pattern)}`,
        observed: (sample) =>
          sample.node === null ? 'no node' : `value ${JSON.stringify(sample.node.value ?? '')}`,
      },
      options?.timeout,
    );
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

  toHaveAccessibleName(expected: TextMatch, options?: { timeout?: number }): Promise<void> {
    const pattern = toTextPattern(expected, { exact: true });
    return this.poll(
      {
        name: 'toHaveAccessibleName',
        predicate: (sample) => sample.node !== null && matchesText(sample.node.name ?? '', pattern),
        describeExpected: `accessible name ${describePattern(pattern)}`,
        observed: (sample) =>
          sample.node === null ? 'no node' : `name ${JSON.stringify(sample.node.name ?? '')}`,
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
    await this.target.runStep(fullApi, label, async () => {
      const deadline = new Deadline(timeout ?? this.target.assertionTimeout);
      let negatedTrueSince: number | undefined;
      for (;;) {
        const value = await condition();
        if (!this.negated) {
          if (value) return;
        } else if (!value) {
          negatedTrueSince ??= Date.now();
          if (Date.now() - negatedTrueSince >= NEGATION_GRACE_MS) return;
        } else {
          negatedTrueSince = undefined;
        }
        if (deadline.expired()) {
          throw new TestError(
            'ASSERTION_FAILED',
            `${fullApi} failed\nexpected: ${this.negated ? 'not ' : ''}${label}\nobserved: ${await observed()}`,
          );
        }
        await sleep(POLL_INTERVAL_MS, this.target.signal);
      }
    });
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
