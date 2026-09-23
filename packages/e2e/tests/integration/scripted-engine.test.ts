/**
 * The deterministic tier through the real runner against a scripted
 * in-memory engine: every `screen` verb, every `Locator` read and action,
 * every `expect(locator)` matcher, strictness, polling, staleness, and the
 * engine error mapping, with no browser or device behind them.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import {
  createScriptedEngine,
  SCRIPTED_APP_URL,
  SCRIPTED_ROOT_ID,
  type ScriptedEngineHandle,
  type ScriptedNode,
  type Stage,
} from '../helpers/scripted-engine.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { AttemptRecord } from '../../src/run/records.ts';

/** A config over one scripted engine, with budgets short enough for failing paths to fail fast. */
function scriptedConfig(scripted: ScriptedEngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    specVersion: '0.1',
    targets: [{ name: 'scripted', platform: 'scripted', engine: scripted.engine }],
    artifacts: [],
    actionTimeout: 300,
    assertionTimeout: 200,
    ...extra,
  } as E2EConfig;
}

/**
 * The screen every suite runs against: form controls, toggles, a list with
 * nested checkboxes, hidden twins, echoed text, and the nodes that move
 * while an attempt runs (a late arrival, a growing list, a flipping state).
 */
function scene(stage: Stage): ScriptedNode[] {
  const counter: ScriptedNode = { id: 'counter', role: 'status', name: 'Count', text: '0' };
  const lateArrival: ScriptedNode = { id: 'late', role: 'button', name: 'Late arrival', states: { hidden: true } };
  const loading: ScriptedNode = { id: 'loading', role: 'status', name: 'Loading', text: 'Loading' };
  const ticker: ScriptedNode = { id: 'ticker', role: 'status', name: 'Ticker', text: 'tick' };
  const progress: ScriptedNode = { id: 'progress', role: 'spinbutton', name: 'Progress', value: '10' };
  const save: ScriptedNode = { id: 'save', role: 'menuitem', name: 'Save', states: { disabled: true } };
  const growing: ScriptedNode = {
    id: 'growing',
    role: 'list',
    name: 'Growing',
    children: [{ id: 'grow-1', role: 'listitem', text: 'One' }],
  };
  // The clocks start from a tap in the body, not from the attempt launch, so
  // a slow worker cannot land the mutation before the assertion begins.
  const reveal: ScriptedNode = {
    id: 'reveal',
    role: 'button',
    name: 'Reveal',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(300, () => {
        lateArrival.states = { hidden: false };
        loading.states = { hidden: true };
      });
    },
  };
  const advance: ScriptedNode = {
    id: 'advance',
    role: 'button',
    name: 'Advance',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(250, () => {
        ticker.text = 'tock';
        progress.value = '100';
        save.states = { disabled: false };
      });
    },
  };
  const loadMore: ScriptedNode = {
    id: 'load-more',
    role: 'button',
    name: 'Load more',
    on(action) {
      if (action.kind !== 'tap') return;
      stage.after(200, () => growing.children?.push({ id: 'grow-2', role: 'listitem', text: 'Two' }));
      stage.after(400, () => growing.children?.push({ id: 'grow-3', role: 'listitem', text: 'Three' }));
    },
  };

  const todo = (index: number, text: string, done: boolean): ScriptedNode => ({
    id: `todo-${index}`,
    role: 'listitem',
    testId: 'todo',
    text,
    children: [{ id: `todo-${index}-done`, role: 'checkbox', name: 'Done', states: { checked: done } }],
  });

  return [
    { id: 'h1', role: 'heading', name: 'Dashboard', text: 'Dashboard', level: 1 },
    { id: 'h2', role: 'heading', name: 'Recent', text: 'Recent', level: 2 },
    {
      id: 'email',
      role: 'textbox',
      name: 'Email',
      value: '',
      attributes: { placeholder: 'you@example.test', autocomplete: 'email' },
      rect: { x: 10, y: 100, width: 200, height: 30 },
    },
    { id: 'notes', role: 'textbox', name: 'Notes', value: 'line1\n\nline2  ' },
    {
      id: 'password',
      role: 'textbox',
      name: 'Password',
      value: 'hunter2',
      inputPurpose: 'password',
      states: { secure: true },
      rect: { x: 10, y: 140, width: 200, height: 30 },
    },
    { id: 'search', role: 'searchbox', name: 'Search', value: 'hello-value' },
    { id: 'notify', role: 'checkbox', name: 'Notifications', states: { checked: false } },
    { id: 'dark', role: 'switch', name: 'Dark mode', states: { checked: true } },
    {
      id: 'plan',
      role: 'combobox',
      name: 'Plan',
      value: 'free',
      options: [
        { label: 'Free', value: 'free' },
        { label: 'Pro', value: 'pro' },
        { label: 'Team', value: 'team' },
      ],
    },
    { id: 'submit', role: 'button', name: 'Submit', text: 'Submit', rect: { x: 20, y: 200, width: 100, height: 40 } },
    { id: 'disabled', role: 'button', name: 'Disabled action', states: { disabled: true } },
    {
      id: 'menu',
      role: 'button',
      name: 'Menu',
      states: { expanded: false },
      on(action, node) {
        if (action.kind === 'tap') node.states = { ...node.states, expanded: node.states?.expanded !== true };
      },
    },
    {
      id: 'bold',
      role: 'button',
      name: 'Bold',
      states: { pressed: false },
      on(action, node) {
        if (action.kind === 'tap') node.states = { ...node.states, pressed: true };
      },
    },
    {
      id: 'increment',
      role: 'button',
      name: 'Increment',
      on(action) {
        if (action.kind === 'tap') counter.text = String(Number(counter.text) + 1);
      },
    },
    counter,
    { id: 'dup-1', role: 'button', name: 'Duplicated', text: 'Duplicated' },
    { id: 'dup-2', role: 'button', name: 'Duplicated', text: 'Duplicated' },
    { id: 'ready-hidden', role: 'status', name: 'Ready state', text: 'Ready', states: { hidden: true } },
    { id: 'ready-visible', role: 'status', name: 'Ready state', text: 'Ready' },
    { id: 'hidden-text', text: 'Hidden content', states: { hidden: true } },
    {
      id: 'todos',
      role: 'list',
      name: 'Todos',
      testId: 'todos',
      children: [todo(1, 'Write spec', false), todo(2, 'Ship runner', true), todo(3, 'Release', false)],
    },
    {
      id: 'tabs',
      role: 'tablist',
      name: 'Filter',
      children: [
        { id: 'tab-all', role: 'tab', name: 'All', text: 'All', states: { selected: true } },
        { id: 'tab-open', role: 'tab', name: 'Open', text: 'Open', states: { selected: false } },
      ],
    },
    {
      id: 'card',
      role: 'region',
      name: 'Card',
      testId: 'card',
      text: 'Card body',
      attributes: { class: 'card active', 'data-state': 'open' },
    },
    { id: 'map', role: 'image', name: 'Map', rect: { x: 100, y: 300, width: 400, height: 200 } },
    { id: 'drag', role: 'listitem', text: 'Draggable', testId: 'drag' },
    { id: 'drop', role: 'region', name: 'Dropzone', testId: 'drop' },
    { id: 'upload', role: 'button', name: 'Attachment' },
    { id: 'feed', role: 'list', name: 'Feed' },
    { id: 'focus-target', role: 'textbox', name: 'Focus target', value: '' },
    { id: 'city', role: 'textbox', name: 'City', value: '' },
    { id: 'echo', role: 'group', text: 'Echoed', children: [{ id: 'echo-inner', text: 'Echoed' }] },
    reveal,
    advance,
    loadMore,
    lateArrival,
    loading,
    ticker,
    progress,
    save,
    growing,
    { id: 'below', role: 'button', name: 'Below the fold', appearsAfterSwipes: 2 },
    { id: 'stale', role: 'button', name: 'Stale', staleOnce: true },
    {
      id: 'flaky',
      role: 'button',
      name: 'Flaky',
      fail: { tap: { code: 'NOT_ACTIONABLE', message: 'covered by an overlay' } },
    },
    {
      id: 'commit',
      role: 'button',
      name: 'Commit',
      fail: { tap: { code: 'ACTION_MAY_HAVE_COMMITTED', message: 'the tap may have landed' } },
    },
  ];
}

/** The passed attempt of one test; a failure prints the error the runner recorded. */
function passed(outcome: RunOutcome, title: string): AttemptRecord {
  const result = resultByTitle(outcome, title);
  expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  return result.attempts[0]!;
}

/** The failed attempt of one test, its error code checked and every fragment found in the message. */
function failed(outcome: RunOutcome, title: string, code: string, ...fragments: string[]): AttemptRecord {
  const result = resultByTitle(outcome, title);
  const attempt = result.attempts[0]!;
  expect(result.status, `${title}: ${JSON.stringify(attempt.error)}`).toBe('failed');
  expect(attempt.error?.code, attempt.error?.message).toBe(code);
  for (const fragment of fragments) expect(attempt.error?.message).toContain(fragment);
  return attempt;
}

/** The first step of an attempt recorded under `api`; a miss lists the apis the attempt did record. */
function step(attempt: AttemptRecord, api: string) {
  const found = attempt.steps.find((candidate) => candidate.api === api);
  expect(found, `no step ${api} in ${attempt.steps.map((entry) => entry.api).join(', ')}`).toBeDefined();
  return found!;
}

const OPEN = `open ${SCRIPTED_APP_URL}/`;

describe('scripted engine: expect(locator) matchers', () => {
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
  const soon = { timeout: 100 };
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

  let scripted: ScriptedEngineHandle;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    scripted = createScriptedEngine({ scene });
    ({ outcome, project } = await runProject(
      { 'tests/matchers.e2e.ts': MATCHERS },
      { appUrl: SCRIPTED_APP_URL, config: scriptedConfig(scripted) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('produces a valid report', () => {
    assertValidReport(outcome.report);
    expect(outcome.results).toHaveLength(20);
  });

  it('passes every matcher and its negation', () => {
    const attempt = passed(outcome, 'every matcher passes on the scripted screen');
    const apis = new Set(attempt.steps.map((entry) => entry.api));
    for (const matcher of [
      'toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeSelected',
      'toBeExpanded', 'toBeFocused', 'toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute',
      'toHaveAccessibleName', 'toHaveCount',
    ]) {
      expect(apis, matcher).toContain(`expect.${matcher}`);
    }
    expect(attempt.steps.every((entry) => entry.status === 'passed')).toBe(true);
    const negated = passed(outcome, 'every negated matcher passes on the scripted screen');
    expect(negated.steps.filter((entry) => entry.api.startsWith('expect.not.'))).toHaveLength(17);
    expect(step(negated, 'expect.not.toBeVisible')).toMatchObject({ kind: 'assertion', label: 'getByText("Hidden content")' });
  });

  it('names the observed state in every failure', () => {
    const cases: [string, ...string[]][] = [
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
    for (const [title, ...fragments] of cases) {
      const attempt = failed(outcome, title, 'ASSERTION_FAILED', ...fragments);
      expect(attempt.error?.details, title).toMatchObject({ locator: expect.any(String), expected: expect.any(String) });
    }
  });

  it('honors an explicit timeout and fails an ambiguous locator at once', () => {
    const timed = failed(outcome, 'a matcher honors its timeout', 'ASSERTION_FAILED', 'observed: no node (match count 0)');
    const timedStep = step(timed, 'expect.toBeVisible');
    expect(timedStep.status).toBe('failed');
    expect(timedStep.durationMs).toBeGreaterThanOrEqual(250);
    expect(timedStep.durationMs).toBeLessThan(2_000);
    const ambiguous = failed(outcome, 'an ambiguous locator fails an assertion at once', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    expect(step(ambiguous, 'expect.toBeVisible').durationMs).toBeLessThan(1_500);
    expect(ambiguous.error?.details).toMatchObject({ matches: 2, locator: 'getByText("Duplicated")' });
  });
});

describe('scripted engine: locator reads and queries', () => {
  const READS = `import { test, expect } from 'e2e';

test('reads answer from the current tree', async ({ app, screen }) => {
  await app.open('/');
  expect(await screen.getByRole('heading', { level: 1 }).textContent()).toBe('Dashboard');
  expect(await screen.getByRole('image', { name: 'Map' }).textContent()).toBeNull();
  expect(await screen.getByLabel('Search').inputValue()).toBe('hello-value');
  expect(await screen.getByRole('heading', { level: 1 }).inputValue()).toBe('');
  expect(await screen.getByTestId('card').getAttribute('class')).toBe('card active');
  expect(await screen.getByTestId('card').getAttribute('missing')).toBeNull();
  expect(await screen.getByRole('button', { name: 'Submit' }).isVisible()).toBe(true);
  expect(await screen.getByText('Hidden content').isVisible()).toBe(false);
  expect(await screen.getByText('Hidden content').isHidden()).toBe(true);
  expect(await screen.getByText('Never rendered').isVisible()).toBe(false);
  expect(await screen.getByText('Never rendered').isHidden()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Submit' }).isEnabled()).toBe(true);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isEnabled()).toBe(false);
  expect(await screen.getByRole('button', { name: 'Disabled action' }).isDisabled()).toBe(true);
  expect(await screen.getByRole('switch', { name: 'Dark mode' }).isChecked()).toBe(true);
  expect(await screen.getByRole('checkbox', { name: 'Notifications' }).isChecked()).toBe(false);
  expect(await screen.getByRole('button', { name: 'Submit' }).boundingBox()).toEqual({ x: 20, y: 200, width: 100, height: 40 });
  expect(await screen.getByRole('heading', { level: 1 }).boundingBox()).toBeNull();
  expect(await screen.getByTestId('todo').count()).toBe(3);
  expect(await screen.getByTestId('missing').count()).toBe(0);
  const items = await screen.getByTestId('todo').all();
  expect(items).toHaveLength(3);
  const texts: string[] = [];
  for (const item of items) texts.push((await item.textContent()) ?? '');
  expect(texts).toEqual(['Write spec', 'Ship runner', 'Release']);
  expect(await screen.getByTestId('todo').allTextContents()).toEqual(texts);
  expect(await screen.getByTestId('missing').all()).toEqual([]);
  expect(await screen.getByTestId('missing').allTextContents()).toEqual([]);
  await screen.getByRole('button', { name: 'Submit' }).waitFor();
  await screen.getByRole('button', { name: 'Submit' }).waitFor({ state: 'visible' });
  await screen.getByText('Hidden content').waitFor({ state: 'hidden' });
  await screen.getByText('Never rendered').waitFor({ state: 'hidden' });
});

test('secure fields still answer state reads', async ({ app, screen }) => {
  await app.open('/');
  expect(await screen.getByLabel('Password').isEnabled()).toBe(true);
  expect(await screen.getByLabel('Password').isChecked()).toBe(false);
  expect(await screen.getByLabel('Password').isVisible()).toBe(true);
  expect(await screen.getByLabel('Password').boundingBox()).toEqual({ x: 10, y: 140, width: 200, height: 30 });
});

test('textContent on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').textContent();
});

test('inputValue on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').inputValue();
});

test('getAttribute on a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').getAttribute('type');
});

test('allTextContents over a secure field is denied', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('textbox').allTextContents();
});

test('a read of zero matches is LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Never rendered').textContent();
});

test('a read of several matches is LOCATOR_AMBIGUOUS', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').textContent();
});

test('isVisible on several matches is LOCATOR_AMBIGUOUS', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').isVisible();
});

test('isDisabled on zero matches is LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).isDisabled();
});

test('waitFor times out with LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).waitFor({ timeout: 50 });
});

test('every query kind and refinement resolves', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'sub', exact: false })).toBeVisible();
  await expect(screen.getByRole('button', { name: /^Sub/ })).toBeVisible();
  await expect(screen.getByRole('img', { name: 'Map' })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 2 })).toHaveText('Recent');
  await expect(screen.getByRole('heading')).toHaveCount(2);
  await expect(screen.getByRole('tab', { selected: true })).toHaveText('All');
  await expect(screen.getByRole('button', { disabled: true })).toHaveAccessibleName('Disabled action');
  await expect(screen.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(screen.getByRole('button', { name: 'Menu', expanded: false })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Bold', pressed: false })).toBeVisible();
  await expect(screen.getByText('Ready')).toHaveCount(2);
  await expect(screen.getByRole('status', { name: 'Ready state' })).toHaveCount(1);
  await expect(screen.getByText('Ready', { visible: true })).toHaveCount(1);
  await expect(screen.getByText('Ready', { visible: true })).toBeVisible();
  await expect(screen.getByLabel('Email')).toBeVisible();
  await expect(screen.getByLabel('email', { exact: false })).toBeVisible();
  await expect(screen.getByLabel(/^Em/)).toBeVisible();
  await expect(screen.getByPlaceholder('you@example.test')).toHaveAccessibleName('Email');
  await expect(screen.getByPlaceholder('EXAMPLE', { exact: false })).toHaveCount(1);
  await expect(screen.getByText('Card body')).toBeVisible();
  await expect(screen.getByText('card BODY', { exact: false })).toBeVisible();
  await expect(screen.getByText(/^Card/)).toBeVisible();
  await expect(screen.getByText('Echoed')).toHaveCount(1);
  await expect(screen.getByDisplayValue('hello-value')).toHaveAccessibleName('Search');
  await expect(screen.getByDisplayValue(/^hello/)).toHaveCount(1);
  await expect(screen.getByDisplayValue('hunter2')).toHaveCount(0);
  await expect(screen.getByTestId('card')).toBeVisible();
  await expect(screen.getByTestId('todos').getByRole('checkbox')).toHaveCount(3);
  await expect(screen.getByTestId('todos').getByRole('listitem').filter({ hasText: 'ship' })).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').filter({ hasText: /^Write/ })).toHaveCount(1);
  await expect(screen.getByTestId('todo').filter({ has: screen.getByRole('checkbox', { checked: true }) })).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').filter({ hasText: 'Release', has: screen.getByRole('checkbox') })).toHaveCount(1);
  await expect(screen.getByTestId('todo').filter({ hasText: 'Release', has: screen.getByRole('checkbox', { checked: true }) })).toHaveCount(0);
  await expect(screen.getByTestId('todo').first()).toHaveText('Write spec');
  await expect(screen.getByTestId('todo').last()).toHaveText('Release');
  await expect(screen.getByTestId('todo').nth(1)).toHaveText('Ship runner');
  await expect(screen.getByTestId('todo').nth(7)).toHaveCount(0);
  await expect(screen.getByTestId('todo').filter({ hasText: 'Ship' }).getByRole('checkbox')).toBeChecked();
  await expect(screen.getByRole('list', { name: 'Todos' }).getByText('Release')).toBeVisible();
});

test('filter without a predicate is INVALID_LOCATOR', async ({ app, screen }) => {
  await app.open('/');
  screen.getByTestId('todo').filter({});
});

test('a negative index is INVALID_LOCATOR', async ({ app, screen }) => {
  await app.open('/');
  screen.getByTestId('todo').nth(-1);
});

test('acting before open is APP_NOT_OPEN', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Submit' }).tap({ timeout: 200 });
});
`;

  let scripted: ScriptedEngineHandle;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    scripted = createScriptedEngine({ scene });
    ({ outcome, project } = await runProject(
      { 'tests/reads.e2e.ts': READS },
      { appUrl: SCRIPTED_APP_URL, config: scriptedConfig(scripted) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('reads every field, count, and list without waiting', () => {
    assertValidReport(outcome.report);
    const attempt = passed(outcome, 'reads answer from the current tree');
    expect(attempt.steps.filter((entry) => entry.api === 'locator.waitFor')).toHaveLength(4);
    expect(step(attempt, 'locator.waitFor').label).toBe('getByRole("button", name: "Submit") → visible');
    passed(outcome, 'secure fields still answer state reads');
  });

  it('refuses value reads on a secure field with POLICY_DENIED', () => {
    for (const title of [
      'textContent on a secure field is denied',
      'inputValue on a secure field is denied',
      'getAttribute on a secure field is denied',
      'allTextContents over a secure field is denied',
    ]) {
      const attempt = failed(outcome, title, 'POLICY_DENIED', 'reading values from a secure field is denied');
      expect(attempt.error?.category).toBe('configuration');
    }
  });

  it('applies strictness to reads', () => {
    failed(outcome, 'a read of zero matches is LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'matched no nodes', 'getByText("Never rendered")');
    failed(outcome, 'a read of several matches is LOCATOR_AMBIGUOUS', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes, expected exactly one');
    failed(outcome, 'isVisible on several matches is LOCATOR_AMBIGUOUS', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    failed(outcome, 'isDisabled on zero matches is LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'matched no nodes');
    const waited = failed(outcome, 'waitFor times out with LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'did not become visible');
    expect(step(waited, 'locator.waitFor').status).toBe('failed');
  });

  it('resolves every query kind and refinement', () => {
    passed(outcome, 'every query kind and refinement resolves');
  });

  it('rejects malformed refinements before any query runs', () => {
    failed(outcome, 'filter without a predicate is INVALID_LOCATOR', 'INVALID_LOCATOR', 'filter() requires hasText and/or has');
    failed(outcome, 'a negative index is INVALID_LOCATOR', 'INVALID_LOCATOR', 'nonnegative integer');
    failed(outcome, 'acting before open is APP_NOT_OPEN', 'APP_NOT_OPEN', 'no app is open');
  });
});

describe('scripted engine: actions, pointer actions, and app hooks', () => {
  const ACTIONS = `import { test, expect } from 'e2e';

test('every node action reaches the engine', async ({ app, screen }) => {
  await app.open('/');
  const submit = screen.getByRole('button', { name: 'Submit' });
  await submit.tap();
  await submit.click();
  await submit.doubleTap();
  await submit.secondaryTap();
  await submit.longPress();
  await submit.longPress({ duration: 800 });
  await screen.getByLabel('Email').fill('ada@example.test');
  await expect(screen.getByLabel('Email')).toHaveValue('ada@example.test');
  await screen.getByLabel('Email').clear();
  await expect(screen.getByLabel('Email')).toHaveValue('');
  await screen.getByLabel('City').pressSequentially('Wa');
  await expect(screen.getByLabel('City')).toHaveValue('Wa');
  await expect(screen.getByLabel('City')).toBeFocused();
  await screen.getByLabel('City').pressSequentially('rs', { delay: 10 });
  await expect(screen.getByLabel('City')).toHaveValue('Wars');
  await screen.getByLabel('City').press('Backspace');
  await expect(screen.getByLabel('City')).toHaveValue('War');
  await screen.getByLabel('City').press('Shift+Tab');
  await screen.getByLabel('City').press('$');
  await expect(screen.getByLabel('City')).toHaveValue('War$');
  await screen.getByRole('checkbox', { name: 'Notifications' }).check();
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).toBeChecked();
  await screen.getByRole('checkbox', { name: 'Notifications' }).uncheck();
  await expect(screen.getByRole('checkbox', { name: 'Notifications' })).not.toBeChecked({ timeout: 100 });
  await screen.getByLabel('Plan').selectOption('Pro');
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await screen.getByLabel('Plan').selectOption({ label: 'Team' });
  await expect(screen.getByLabel('Plan')).toHaveValue('team');
  await screen.getByLabel('Plan').selectOption({ value: 'free' });
  await expect(screen.getByLabel('Plan')).toHaveValue('free');
  await screen.getByLabel('Plan').selectOption({ index: 1 });
  await expect(screen.getByLabel('Plan')).toHaveValue('pro');
  await screen.getByLabel('Focus target').focus();
  await expect(screen.getByLabel('Focus target')).toBeFocused();
  await expect(screen.getByLabel('City')).not.toBeFocused({ timeout: 100 });
  await submit.hover();
  await screen.getByRole('button', { name: 'Attachment' }).setInputFiles('fixtures/one.txt');
  await screen.getByRole('button', { name: 'Attachment' }).setInputFiles(['fixtures/one.txt', '/tmp/two.txt']);
  await screen.getByTestId('drag').dragTo(screen.getByTestId('drop'));
  await submit.scrollIntoView();
  await screen.getByRole('list', { name: 'Feed' }).swipe({ direction: 'down', momentum: 'slow' });
  await screen.getByRole('list', { name: 'Feed' }).swipe({ direction: 'left' });
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Count' })).toHaveText('2');
  await screen.getByRole('button', { name: 'Bold' }).tap();
  await expect(screen.getByRole('button', { name: 'Bold', pressed: true })).toBeVisible();
});

test('every pointer action reaches the engine', async ({ app, screen }) => {
  await app.open('/');
  await screen.tapAt({ x: 5, y: 6 });
  await screen.getByRole('image', { name: 'Map' }).tap({ position: { x: 10, y: 20 } });
  await screen.getByRole('image', { name: 'Map' }).click({ position: { x: 0, y: 0 } });
  await screen.swipe({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  await screen.swipe({ direction: 'up', momentum: 'fast' });
  await screen.swipe({ direction: 'down' });
});

test('a malformed key is INVALID_ARGUMENT', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('City').press('Bogus');
});

test('an unknown option is ACTION_FAILED', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Plan').selectOption('Enterprise');
});

test('app hooks reach the session', async ({ app, screen }) => {
  await app.open('/');
  await app.open('/settings');
  await app.back();
  await app.restart();
  await app.clearState();
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
});
`;

  let scripted: ScriptedEngineHandle;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    scripted = createScriptedEngine({ scene });
    ({ outcome, project } = await runProject(
      { 'tests/actions.e2e.ts': ACTIONS },
      { appUrl: SCRIPTED_APP_URL, config: scriptedConfig(scripted) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('dispatches every action kind with the expected ref and payload', () => {
    assertValidReport(outcome.report);
    const attempt = passed(outcome, 'every node action reaches the engine');
    const performs = scripted.performsOf(attempt.id).map((entry) => [entry.id, entry.action] as const);
    const fixtureOne = path.join(project.dir, 'fixtures', 'one.txt');
    expect(performs).toEqual([
      ['submit', { kind: 'tap' }],
      ['submit', { kind: 'tap' }],
      ['submit', { kind: 'doubleTap' }],
      ['submit', { kind: 'secondaryTap' }],
      ['submit', { kind: 'longPress', durationMs: 500 }],
      ['submit', { kind: 'longPress', durationMs: 800 }],
      ['email', { kind: 'fill', value: 'ada@example.test', sensitive: false }],
      ['email', { kind: 'clear' }],
      ['city', { kind: 'focus' }],
      ['city', { kind: 'focus' }],
      ['city', { kind: 'press', key: 'Backspace' }],
      ['city', { kind: 'press', key: 'Shift+Tab' }],
      ['city', { kind: 'press', key: '$' }],
      ['notify', { kind: 'check' }],
      ['notify', { kind: 'uncheck' }],
      ['plan', { kind: 'selectOption', value: 'Pro' }],
      ['plan', { kind: 'selectOption', value: { label: 'Team' } }],
      ['plan', { kind: 'selectOption', value: { value: 'free' } }],
      ['plan', { kind: 'selectOption', value: { index: 1 } }],
      ['focus-target', { kind: 'focus' }],
      ['submit', { kind: 'hover' }],
      ['upload', { kind: 'setInputFiles', paths: [fixtureOne] }],
      ['upload', { kind: 'setInputFiles', paths: [fixtureOne, '/tmp/two.txt'] }],
      ['drag', { kind: 'dragTo', target: { id: 'drop', revision: expect.stringMatching(/^l\d+$/) } }],
      ['submit', { kind: 'scrollIntoView' }],
      ['feed', { kind: 'swipe', direction: 'down', momentum: 'slow' }],
      ['feed', { kind: 'swipe', direction: 'left' }],
      ['increment', { kind: 'tap' }],
      ['increment', { kind: 'tap' }],
      ['bold', { kind: 'tap' }],
    ]);
    expect(scripted.keysOf(attempt.id)).toEqual([
      { attemptId: attempt.id, kind: 'type', text: 'Wa', replace: false },
      { attemptId: attempt.id, kind: 'type', text: 'r', replace: false },
      { attemptId: attempt.id, kind: 'type', text: 's', replace: false },
    ]);
    expect(scripted.pointerActionsOf(attempt.id)).toEqual([]);
    const apis = attempt.steps.map((entry) => entry.api);
    expect(apis).toEqual(
      expect.arrayContaining([
        'locator.tap', 'locator.click', 'locator.doubleTap', 'locator.secondaryTap', 'locator.longPress', 'locator.fill',
        'locator.clear', 'locator.pressSequentially', 'locator.press', 'locator.check', 'locator.uncheck',
        'locator.selectOption', 'locator.focus', 'locator.hover', 'locator.setInputFiles', 'locator.dragTo',
        'locator.scrollIntoView', 'locator.swipe',
      ]),
    );
    expect(step(attempt, 'locator.fill').label).toBe('getByLabel("Email")');
    expect(step(attempt, 'locator.pressSequentially').label).toBe('getByLabel("City")');
  });

  it('dispatches every pointer action at the point the test named', () => {
    const attempt = passed(outcome, 'every pointer action reaches the engine');
    expect(scripted.pointerActionsOf(attempt.id).map((entry) => [entry.point, entry.action])).toEqual([
      [{ x: 5, y: 6 }, { kind: 'tap' }],
      [{ x: 110, y: 320 }, { kind: 'tap' }],
      [{ x: 100, y: 300 }, { kind: 'tap' }],
      [{ x: 1, y: 2 }, { kind: 'swipeTo', target: { x: 3, y: 4 } }],
    ]);
    // A positioned tap scrolls the node into view first; a direction swipe is the root swipe.
    expect(scripted.performsOf(attempt.id).map((entry) => [entry.id, entry.action])).toEqual([
      ['map', { kind: 'scrollIntoView' }],
      ['map', { kind: 'scrollIntoView' }],
      [SCRIPTED_ROOT_ID, { kind: 'swipe', direction: 'up', momentum: 'fast' }],
      [SCRIPTED_ROOT_ID, { kind: 'swipe', direction: 'down' }],
    ]);
    expect(step(attempt, 'screen.tapAt').label).toBe('(5, 6)');
    expect(step(attempt, 'screen.swipe').label).toBe('(1, 2) → (3, 4)');
    expect(step(attempt, 'locator.tap').label).toBe('getByRole("image", name: "Map") at (10, 20)');
  });

  it('refuses a malformed key before resolving and maps an engine refusal to ACTION_FAILED', () => {
    const malformed = failed(outcome, 'a malformed key is INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'press key "Bogus" is not a key');
    expect(scripted.performsOf(malformed.id)).toEqual([]);
    const refused = failed(outcome, 'an unknown option is ACTION_FAILED', 'ACTION_FAILED', 'no option matches "Enterprise"');
    expect(scripted.performsOf(refused.id)).toHaveLength(1);
  });

  it('routes app.open, back, restart, and clearState to the session hooks', () => {
    const attempt = passed(outcome, 'app hooks reach the session');
    expect(scripted.sessionCallsOf(attempt.id)).toEqual([
      OPEN,
      `open ${SCRIPTED_APP_URL}/settings`,
      'back',
      'restart',
      OPEN,
      'reset',
      OPEN,
    ]);
    expect(attempt.steps.map((entry) => entry.api).slice(0, 5)).toEqual([
      'app.open', 'app.open', 'app.back', 'app.restart', 'app.clearState',
    ]);
  });
});

describe('scripted engine: polling, staleness, failure mapping, and scrolling', () => {
  const POLLING = `import { test, expect } from 'e2e';

test('a late node passes toBeVisible', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toBeVisible({ timeout: 1500 });
  await screen.getByRole('button', { name: 'Late arrival' }).waitFor({ state: 'visible' });
});

test('a growing count passes toHaveCount', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Load more' }).tap();
  await expect(screen.getByRole('list', { name: 'Growing' }).getByRole('listitem')).toHaveCount(3, { timeout: 1500 });
});

test('a changing value, text, and state pass their matchers', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeDisabled();
  await screen.getByRole('button', { name: 'Advance' }).tap();
  await expect(screen.getByRole('spinbutton', { name: 'Progress' })).toHaveValue('100', { timeout: 1500 });
  await expect(screen.getByRole('status', { name: 'Ticker' })).toHaveText('tock', { timeout: 1500 });
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeEnabled({ timeout: 1500 });
});

test('a negated matcher waits out the grace window', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Hidden content')).not.toBeVisible({ timeout: 1500 });
});

test('a negated matcher waits for the flip, then the grace window', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('status', { name: 'Loading' })).not.toBeVisible({ timeout: 2500 });
  await screen.getByRole('status', { name: 'Loading' }).waitFor({ state: 'hidden' });
});

test('a missing node is LOCATOR_NOT_FOUND after the deadline', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Never exists' }).tap({ timeout: 250 });
});

test('an ambiguous locator fails an action at once', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText('Duplicated').tap({ timeout: 3000 });
});

test('a stale node is re-resolved and the action retried once', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Stale' }).tap();
});

test('a possibly committed action is ACTION_FAILED and never repeated', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Commit' }).tap();
});

test('a non-actionable node is ACTION_FAILED', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Flaky' }).tap();
});

test('scrollUntilVisible reveals a node after two root swipes', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Below the fold' })).toHaveCount(0);
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Below the fold' }), { timeout: 3000 });
  await expect(screen.getByRole('button', { name: 'Below the fold' })).toBeVisible();
});

test('scrollUntilVisible times out with LOCATOR_NOT_FOUND', async ({ app, screen }) => {
  await app.open('/');
  await screen.scrollUntilVisible(screen.getByRole('button', { name: 'Never exists' }), { timeout: 350, direction: 'up' });
});
`;

  let scripted: ScriptedEngineHandle;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    scripted = createScriptedEngine({ scene });
    ({ outcome, project } = await runProject(
      { 'tests/polling.e2e.ts': POLLING },
      { appUrl: SCRIPTED_APP_URL, config: scriptedConfig(scripted) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('polls until the tree catches up', () => {
    assertValidReport(outcome.report);
    const late = passed(outcome, 'a late node passes toBeVisible');
    expect(step(late, 'expect.toBeVisible').durationMs).toBeGreaterThanOrEqual(200);
    const growing = passed(outcome, 'a growing count passes toHaveCount');
    expect(step(growing, 'expect.toHaveCount').durationMs).toBeGreaterThanOrEqual(300);
    const changing = passed(outcome, 'a changing value, text, and state pass their matchers');
    expect(step(changing, 'expect.toHaveValue').durationMs).toBeGreaterThanOrEqual(150);
  });

  it('holds a negated matcher for the grace window', () => {
    const held = passed(outcome, 'a negated matcher waits out the grace window');
    expect(step(held, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(900);
    const flipped = passed(outcome, 'a negated matcher waits for the flip, then the grace window');
    expect(step(flipped, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(1_150);
  });

  it('reports a missing node after the deadline and an ambiguous one at once', () => {
    const missing = failed(outcome, 'a missing node is LOCATOR_NOT_FOUND after the deadline', 'LOCATOR_NOT_FOUND', 'matched no nodes within');
    expect(missing.error?.details).toMatchObject({ role: 'button', name: 'Never exists', waitedMs: expect.any(Number) });
    expect(missing.error?.details?.waitedMs).toBeGreaterThanOrEqual(250);
    expect(step(missing, 'locator.tap').durationMs).toBeLessThan(2_000);
    expect(scripted.performsOf(missing.id)).toEqual([]);
    const ambiguous = failed(outcome, 'an ambiguous locator fails an action at once', 'LOCATOR_AMBIGUOUS', 'matched 2 nodes');
    expect(step(ambiguous, 'locator.tap').durationMs).toBeLessThan(1_500);
    expect(scripted.performsOf(ambiguous.id)).toEqual([]);
  });

  it('re-resolves a stale node and retries the action once', () => {
    const attempt = passed(outcome, 'a stale node is re-resolved and the action retried once');
    expect(scripted.performsOf(attempt.id).map((entry) => entry.id)).toEqual(['stale', 'stale~relocated']);
  });

  it('maps engine refusals to ACTION_FAILED without repeating them', () => {
    const committed = failed(outcome, 'a possibly committed action is ACTION_FAILED and never repeated', 'ACTION_FAILED', 'the tap may have landed');
    expect(scripted.performsOf(committed.id)).toHaveLength(1);
    expect(committed.error?.category).toBe('test');
    const blocked = failed(outcome, 'a non-actionable node is ACTION_FAILED', 'ACTION_FAILED', 'covered by an overlay');
    expect(scripted.performsOf(blocked.id)).toHaveLength(1);
  });

  it('scrolls the viewport until the target shows, or reports LOCATOR_NOT_FOUND', () => {
    const revealed = passed(outcome, 'scrollUntilVisible reveals a node after two root swipes');
    expect(scripted.performsOf(revealed.id).map((entry) => [entry.id, entry.action])).toEqual([
      [SCRIPTED_ROOT_ID, { kind: 'swipe', direction: 'down', momentum: 'slow' }],
      [SCRIPTED_ROOT_ID, { kind: 'swipe', direction: 'down', momentum: 'slow' }],
    ]);
    expect(step(revealed, 'screen.scrollUntilVisible').label).toBe('getByRole("button", name: "Below the fold")');
    const gaveUp = failed(outcome, 'scrollUntilVisible times out with LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND', 'did not become visible while scrolling');
    const swipes = scripted.performsOf(gaveUp.id);
    expect(swipes.length).toBeGreaterThanOrEqual(1);
    expect(swipes.every((entry) => entry.id === SCRIPTED_ROOT_ID && entry.action.kind === 'swipe' && entry.action.direction === 'up')).toBe(true);
  });
});

describe('scripted engine: undeclared capabilities', () => {
  const LIMITED = `import { test } from 'e2e';

test('a declared action still works', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});

test('a positioned tap skips scrollIntoView when the engine lacks it', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('image', { name: 'Map' }).tap({ position: { x: 1, y: 2 } });
});

test('an undeclared node action is UNSUPPORTED_CAPABILITY', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).hover();
});

test('an undeclared pointer action is UNSUPPORTED_CAPABILITY', async ({ app, screen }) => {
  await app.open('/');
  await screen.swipe({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
});

test('a direction swipe needs the swipe action', async ({ app, screen }) => {
  await app.open('/');
  await screen.swipe({ direction: 'down' });
});

test('pressSequentially needs a keyboard', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('City').pressSequentially('Wa');
});
`;

  let scripted: ScriptedEngineHandle;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    scripted = createScriptedEngine({ scene, actions: ['tap', 'focus'], pointerActions: ['tap'], keyboard: false });
    ({ outcome, project } = await runProject(
      { 'tests/limited.e2e.ts': LIMITED },
      { appUrl: SCRIPTED_APP_URL, config: scriptedConfig(scripted) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('honors what the engine declares', () => {
    assertValidReport(outcome.report);
    const tapped = passed(outcome, 'a declared action still works');
    expect(scripted.performsOf(tapped.id).map((entry) => entry.action.kind)).toEqual(['tap']);
    const positioned = passed(outcome, 'a positioned tap skips scrollIntoView when the engine lacks it');
    expect(scripted.performsOf(positioned.id)).toEqual([]);
    expect(scripted.pointerActionsOf(positioned.id).map((entry) => entry.point)).toEqual([{ x: 101, y: 302 }]);
  });

  it('fails an undeclared kind with UNSUPPORTED_CAPABILITY before reaching the engine', () => {
    const cases: [string, string][] = [
      ['an undeclared node action is UNSUPPORTED_CAPABILITY', 'the "hover" action is not available on this target: its engine declares tap, focus'],
      ['an undeclared pointer action is UNSUPPORTED_CAPABILITY', 'the "swipeTo" action at a point is not available'],
      ['a direction swipe needs the swipe action', 'swipe'],
      ['pressSequentially needs a keyboard', 'pressSequentially is not available on this target: its engine declares no keyboard'],
    ];
    for (const [title, fragment] of cases) {
      const attempt = failed(outcome, title, 'UNSUPPORTED_CAPABILITY', fragment);
      expect(attempt.error?.category, title).toBe('configuration');
      expect(scripted.performsOf(attempt.id), title).toEqual([]);
      expect(scripted.pointerActionsOf(attempt.id), title).toEqual([]);
    }
  });
});
