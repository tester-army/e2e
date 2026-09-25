/**
 * `expect(locator)` through the real runner against the scripted engine:
 * every matcher and its negation pass on the reference screen, every failure
 * names the observed state, a matcher honors its timeout, and an ambiguous
 * locator fails at once.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { failed, passed, scriptedSuite, step } from '../helpers/scripted-suite.ts';

const MATCHERS = `import { test, expect } from 'e2e';

test('every matcher passes on the scripted screen', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(screen.getByText('Hidden content')).toBeHidden();
  await expect(screen.getByText('Hidden content')).toBeAttached();
  await expect(screen.getByText('Never rendered')).toBeHidden();
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
  await expect(screen.getByRole('switch', { name: 'Dark mode' })).toBeChecked();
  await expect(screen.getByRole('tab', { name: 'All' })).toBeSelected();
  await screen.getByRole('button', { name: 'Menu' }).tap();
  await expect(screen.getByRole('button', { name: 'Menu' })).toBeExpanded();
  await screen.getByLabel('Focus target').focus();
  await expect(screen.getByLabel('Focus target')).toBeFocused();
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText(/^Dash/);
  await expect(screen.getByTestId('card')).toContainText('body');
  await expect(screen.getByLabel('Search')).toHaveValue('hello-value');
  await expect(screen.getByLabel('Email')).toHaveValue('');
  await expect(screen.getByLabel('Notes')).toHaveValue('line1\\n\\nline2  ');
  await expect(screen.getByLabel('Notes')).toHaveValue(/^line1\\n\\nline2 {2}$/);
  await expect(screen.getByTestId('card')).toHaveAttribute('data-state');
  await expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'open');
  await expect(screen.getByTestId('card')).toHaveAttribute('class', /active/);
  await expect(screen.getByRole('list', { name: 'Todos' })).toHaveAccessibleName('Todos');
  await expect(screen.getByTestId('todo')).toHaveCount(3);
  await expect(screen.getByTestId('todo')).toHaveText(['Write spec', /^Ship/, 'Release']);
  await expect(screen.getByTestId('todo')).toContainText(['spec', 'runner', 'Release']);
  await expect(screen.getByTestId('missing')).toHaveText([]);
  await expect(screen.getByTestId('missing')).toHaveCount(0);
});

test('every negated matcher passes on the scripted screen', async ({ app, screen }) => {
  await app.open('/');
  // Half a second: a negation holds for the smaller of the grace window and the
  // budget, and the first observation must land inside the budget on a loaded CI box.
  const soon = { timeout: 500 };
  await expect(screen.getByText('Hidden content')).not.toBeVisible(soon);
  await expect(screen.getByRole('heading', { name: 'Dashboard' })).not.toBeHidden(soon);
  await expect(screen.getByText('Never rendered')).not.toBeAttached(soon);
  await expect(screen.getByRole('button', { name: 'Disabled action' })).not.toBeEnabled(soon);
  await expect(screen.getByRole('button', { name: 'Submit' })).not.toBeDisabled(soon);
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).not.toBeChecked(soon);
  await expect(screen.getByRole('tab', { name: 'Open' })).not.toBeSelected(soon);
  await expect(screen.getByRole('button', { name: 'Menu' })).not.toBeExpanded(soon);
  await expect(screen.getByLabel('Email')).not.toBeFocused(soon);
  await expect(screen.getByRole('heading', { level: 1 })).not.toHaveText('Recent', soon);
  await expect(screen.getByTestId('card')).not.toContainText('footer', soon);
  await expect(screen.getByLabel('Notes')).not.toHaveValue('line1 line2', soon);
  await expect(screen.getByTestId('card')).not.toHaveAttribute('hidden', soon);
  await expect(screen.getByTestId('card')).not.toHaveAttribute('class', 'card inactive', soon);
  await expect(screen.getByRole('list', { name: 'Todos' })).not.toHaveAccessibleName('Done', soon);
  // The third todo arrives on the scene's clock; wait for it so the negation is about the settled count.
  await expect(screen.getByTestId('todo')).toHaveCount(3);
  await expect(screen.getByTestId('todo')).not.toHaveCount(2, soon);
  await expect(screen.getByTestId('todo')).not.toHaveText(['Write spec', 'Ship runner'], soon);
});

const fast = { timeout: 50 };

test('toBeVisible fails on a hidden node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Hidden content')).toBeVisible(fast);
});

test('toBeHidden fails on a visible node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeHidden(fast);
});

test('toBeAttached fails on a missing node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Never rendered')).toBeAttached(fast);
});

test('toBeEnabled fails on a disabled node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Disabled action' })).toBeEnabled(fast);
});

test('toBeChecked fails on an unchecked node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).toBeChecked(fast);
});

test('toBeExpanded fails on a collapsed node', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Menu' })).toBeExpanded(fast);
});

test('toHaveText fails on other text', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Recent', fast);
});

test('toContainText fails on absent text', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByTestId('card')).toContainText('footer', fast);
});

test('toHaveValue fails on a node without a value', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveValue('Dashboard', fast);
});

test('toHaveValue never normalizes the value', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Notes')).toHaveValue('line1 line2', fast);
});

test('toHaveValue on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Password')).toHaveValue('');
});

test('a negated toHaveValue on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Password')).not.toHaveValue('');
});

test('toHaveText on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Password')).toHaveText('');
});

test('a negated toHaveText on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByLabel('Password')).not.toHaveText('');
});

test('the list form of toHaveText over a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('textbox')).toHaveText(['', '', '', '']);
});

test('toHaveAttribute fails on an absent attribute', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByTestId('card')).toHaveAttribute('hidden', fast);
});

test('toHaveAttribute fails on another value', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'closed', fast);
});

test('toHaveAccessibleName fails on another name', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('list', { name: 'Todos' })).toHaveAccessibleName('Done', fast);
});

test('toHaveCount fails on another count', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByTestId('todo')).toHaveCount(2, fast);
});

test('the list form of toHaveText fails on a shorter list', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByTestId('todo')).toHaveText(['Write spec', 'Ship runner'], fast);
});

test('a negated matcher fails while the condition holds', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Submit' })).not.toBeVisible(fast);
});

test('a matcher honors its timeout', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Never rendered')).toBeVisible({ timeout: 250 });
});

test('an ambiguous locator fails an assertion at once', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Duplicated')).toBeVisible({ timeout: 3000 });
});
`;

/** Every failing matcher test in the fixture, with the fragments its error message must carry. */
const FAILURES: [string, ...string[]][] = [
  ['toBeVisible fails on a hidden node', 'expect.toBeVisible failed', 'expected: visible', 'observed: states: hidden (match count 1)'],
  ['toBeHidden fails on a visible node', 'expected: hidden or absent', 'observed: visible (match count 1)'],
  ['toBeAttached fails on a missing node', 'expected: attached', 'observed: no node (match count 0)'],
  ['toBeEnabled fails on a disabled node', 'expected: enabled', 'observed: states: disabled'],
  ['toBeChecked fails on an unchecked node', 'expected: checked', 'observed: default states'],
  ['toBeExpanded fails on a collapsed node', 'expected: expanded', 'observed: default states'],
  ['toHaveText fails on other text', 'expected: text "Recent"', 'observed: text "Dashboard"'],
  ['toContainText fails on absent text', 'expected: text containing "footer"', 'observed: text "Card body"'],
  ['toHaveValue fails on a node without a value', 'expected: value "Dashboard"', 'observed: no value (not a form control)'],
  ['toHaveValue never normalizes the value', 'observed: value "line1\\n\\nline2  "'],
  ['toHaveAttribute fails on an absent attribute', 'expected: attribute "hidden"', 'observed: attribute "hidden" absent'],
  ['toHaveAttribute fails on another value', 'expected: attribute "data-state" "closed"', 'observed: attribute "data-state" "open"'],
  ['toHaveAccessibleName fails on another name', 'expected: accessible name "Done"', 'observed: name "Todos"'],
  ['toHaveCount fails on another count', 'expected: count 2', 'observed: count 3 (match count 3)'],
  ['the list form of toHaveText fails on a shorter list', 'expected: text ["Write spec", "Ship runner"]', 'observed: text ["Write spec", "Ship runner", "Release"] (match count 3)'],
  ['a negated matcher fails while the condition holds', 'expect.not.toBeVisible failed', 'expected: not visible', 'observed: default states (match count 1)'],
];

/** The value and text matchers a secure field refuses, negated and in list form too. */
const SECURE_DENIALS = [
  'toHaveValue on a secure field is denied',
  'a negated toHaveValue on a secure field is denied',
  'toHaveText on a secure field is denied',
  'a negated toHaveText on a secure field is denied',
  'the list form of toHaveText over a secure field is denied',
];

const TITLES = [
  'every matcher passes on the scripted screen',
  'every negated matcher passes on the scripted screen',
  ...FAILURES.map(([title]) => title),
  'a matcher honors its timeout',
  'an ambiguous locator fails an assertion at once',
  ...SECURE_DENIALS,
];

describe('scripted engine: expect(locator) matchers', () => {
  const run = scriptedSuite('matchers.e2e.ts', MATCHERS);

  it('produces a valid report with one result per test in the file', () => {
    assertValidReport(run.outcome.report);
    expect(run.outcome.results.map((result) => result.test.title).toSorted()).toEqual(TITLES.toSorted());
  });

  it('passes every matcher and its negation', () => {
    const attempt = passed(run.outcome, 'every matcher passes on the scripted screen');
    const apis = new Set(attempt.steps.map((entry) => entry.api));
    for (const matcher of [
      'toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeSelected',
      'toBeExpanded', 'toBeFocused', 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute',
      'toHaveAccessibleName', 'toHaveCount',
    ]) {
      expect(apis, matcher).toContain(`expect.${matcher}`);
    }
    expect(attempt.steps.every((entry) => entry.status === 'passed')).toBe(true);
    const negated = passed(run.outcome, 'every negated matcher passes on the scripted screen');
    expect(negated.steps.filter((entry) => entry.api.startsWith('expect.not.'))).toHaveLength(17);
    expect(step(negated, 'expect.not.toBeVisible')).toMatchObject({ kind: 'assertion', label: 'getByText("Hidden content")' });
  });

  it('names the observed state in every failure', () => {
    for (const [title, ...fragments] of FAILURES) {
      const attempt = failed(run.outcome, title, 'ASSERTION_FAILED', ...fragments);
      expect(attempt.error?.details, title).toMatchObject({ locator: expect.any(String), expected: expect.any(String) });
    }
  });

  it('refuses to judge a secure field with POLICY_DENIED, negated and in list form too', () => {
    for (const title of SECURE_DENIALS) {
      const attempt = failed(run.outcome, title, 'POLICY_DENIED', 'reading values from a secure field is denied');
      expect(attempt.error?.category, title).toBe('configuration');
      expect(JSON.stringify(attempt), title).not.toContain('hunter2');
    }
  });

  it('honors an explicit timeout and fails an ambiguous locator at once', () => {
    const timed = failed(run.outcome, 'a matcher honors its timeout', 'ASSERTION_FAILED', 'observed: no node (match count 0)');
    const timedStep = step(timed, 'expect.toBeVisible');
    expect(timedStep.status).toBe('failed');
    expect(timedStep.durationMs).toBeGreaterThanOrEqual(250);
    const ambiguous = failed(run.outcome, 'an ambiguous locator fails an assertion at once', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    // At once: well inside the 3000 ms the test allowed the matcher.
    expect(step(ambiguous, 'expect.toBeVisible').durationMs).toBeLessThan(3_000);
    expect(ambiguous.error?.details).toMatchObject({ matches: 2, locator: 'getByText("Duplicated")' });
  });
});
