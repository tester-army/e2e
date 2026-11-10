/**
 * A recorded step as test lines: each action's line, the end anchors'
 * assertions, the fills spelled by name, and every refusal with its code.
 * A target without a test id compiles from its role, text, or placeholder,
 * marked as a guess until the run after the write passes on it.
 */

import { describe, expect, it } from 'vitest';
import type { ActionTrace, RecordedAction, TraceTargetDescriptor } from '../../src/cache/trace.ts';
import { compileTrace, type CompileContext } from '../../src/compile/lines.ts';

const BASE = { href: 'http://127.0.0.1:4280/', origin: 'http://127.0.0.1:4280' };

const context = (overrides: Partial<CompileContext> = {}): CompileContext => ({
  fills: { credentials: [{ name: 'admin', username: 'admin@example.test', password: 'admin.password' }], secrets: ['api-token'] },
  appBase: BASE,
  uniques: new Map(),
  ...overrides,
});

const trace = (actions: readonly RecordedAction[], endAnchors: readonly TraceTargetDescriptor[] = [], extra: Partial<ActionTrace> = {}): ActionTrace => ({
  actions,
  executor: { name: 'test' },
  summary: 'passed',
  endAnchors,
  ...extra,
});

const tap = (target: TraceTargetDescriptor): RecordedAction => ({ name: 'tap', summary: 'tap', target });

/** The lines of a step that must compile. */
function lines(recorded: ActionTrace, overrides: Partial<CompileContext> = {}): readonly string[] {
  const result = compileTrace(recorded, context(overrides));
  if (!result.ok) throw new Error(`expected a compiled step, got [${result.code}] ${result.reason}`);
  return result.step.lines;
}

/** The refusal of a step that must not compile. */
function refusal(recorded: ActionTrace, overrides: Partial<CompileContext> = {}) {
  const result = compileTrace(recorded, context(overrides));
  if (result.ok) throw new Error(`expected a refusal, got ${result.step.lines.join('\n')}`);
  return result;
}

describe('compileTrace: actions', () => {
  it('writes each node verb on its test id locator, and a navigation relative to the app', () => {
    expect(
      lines(
        trace([
          { name: 'navigate', summary: 'open', url: 'http://127.0.0.1:4280/settings?tab=1' },
          tap({ role: 'button', name: 'Save', testId: 'save' }),
          { name: 'type', summary: 'type', target: { role: 'textbox', name: 'City', testId: 'city' }, value: 'Kraków' },
          { name: 'check', summary: 'uncheck', target: { role: 'checkbox', name: 'News', testId: 'news' }, checked: false },
          { name: 'select', summary: 'select', target: { role: 'combobox', name: 'Size', testId: 'size' }, value: 'Large' },
          { name: 'press', summary: 'press', target: { role: 'textbox', name: 'City', testId: 'city' }, key: 'Enter' },
          { name: 'drag', summary: 'drag', target: { testId: 'card-1' }, destination: { testId: 'done' } },
          { name: 'back', summary: 'back' },
        ]),
      ),
    ).toEqual([
      'await app.open("/settings?tab=1");',
      'await screen.getByTestId("save").tap();',
      'await screen.getByTestId("city").fill("Kraków");',
      'await screen.getByTestId("news").uncheck();',
      'await screen.getByTestId("size").selectOption("Large");',
      'await screen.getByTestId("city").press("Enter");',
      'await screen.getByTestId("card-1").dragTo(screen.getByTestId("done"));',
      'await app.back();',
    ]);
  });

  it('names an Android resource id without its package, as a test on iOS finds the same view', () => {
    expect(
      lines(
        trace([
          tap({ role: 'button', testId: 'dev.e2e.examples.maui:id/greet' }),
          tap({ role: 'button', testId: 'android:id/button1' }),
        ]),
      ),
    ).toEqual(['await screen.getByTestId("greet").tap();', 'await screen.getByTestId("android:id/button1").tap();']);
  });

  it('drops the scrolls and keyboard dismissals a test action does itself', () => {
    expect(
      lines(
        trace([
          { name: 'scroll', summary: 'scroll', direction: 'down' },
          { name: 'dismissKeyboard', summary: 'hide keyboard' },
          tap({ testId: 'save' }),
        ]),
      ),
    ).toEqual(['await screen.getByTestId("save").tap();']);
  });

  it('spells a typed username and a filled secret by the names the config gives them', () => {
    expect(
      lines(
        trace([
          { name: 'type', summary: 'type', target: { testId: 'email' }, value: 'admin@example.test' },
          { name: 'typeSecret', summary: 'fill', target: { testId: 'password' }, secret: 'admin.password' },
          { name: 'typeSecret', summary: 'fill', target: { testId: 'token' }, secret: 'api-token' },
        ]),
      ),
    ).toEqual([
      'await screen.getByTestId("email").fill(credentials.user("admin").username);',
      'await screen.getByTestId("password").fill(credentials.user("admin").password);',
      'await screen.getByTestId("token").fill(secrets.get("api-token"));',
    ]);
  });

  it('types a unique() value as the expression the test passed', () => {
    const uniques = new Map([['/label', 'label']]);
    expect(
      lines(
        trace([
          { name: 'type', summary: 'type', target: { testId: 'label' }, value: '{{param:/label}}' },
          { name: 'type', summary: 'type', target: { testId: 'note' }, value: 'for `{{param:/label}}` only' },
        ]),
        { uniques },
      ),
    ).toEqual(['await screen.getByTestId("label").fill(label);', 'await screen.getByTestId("note").fill(`for \\`${label}\\` only`);']);
  });
});

describe('compileTrace: unique() values', () => {
  it('writes two values typed into one field as a template', () => {
    const uniques = new Map([
      ['/first', 'first'],
      ['/last', 'last'],
    ]);
    expect(lines(trace([{ name: 'type', summary: 'type', target: { testId: 'name' }, value: '{{param:/first}} {{param:/last}}' }]), { uniques })).toEqual([
      'await screen.getByTestId("name").fill(`${first} ${last}`);',
    ]);
  });

  it('refuses an expression typed twice, which each line would evaluate again, and lets a plain name be', () => {
    const typedTwice = trace([
      { name: 'type', summary: 'type', target: { testId: 'a' }, value: '{{param:/label}}' },
      { name: 'type', summary: 'type', target: { testId: 'b' }, value: '{{param:/label}}' },
    ]);
    expect(refusal(typedTwice, { uniques: new Map([['/label', '`Cabin ${Date.now()}`']]) }).code).toBe('unique-unresolved');
    expect(lines(typedTwice, { uniques: new Map([['/label', 'label']]) })).toHaveLength(2);
  });

  it('refuses a navigation or an upload that holds a unique() value or a secret', () => {
    expect(refusal(trace([{ name: 'navigate', summary: 'open', url: 'http://127.0.0.1:4280/c/{{param:/name|slug}}' }])).code).toBe('unique-unresolved');
    expect(refusal(trace([{ name: 'upload', summary: 'upload', target: { testId: 'file' }, paths: ['fixtures/<secret:pin>.pdf'] }])).code).toBe('secret-value');
  });
});

describe('compileTrace: assertions', () => {
  it('asserts the end anchors with a test id, by text, state, or value', () => {
    const result = compileTrace(
      trace(
        [tap({ testId: 'save' })],
        [
          { text: 'Saved', testId: 'toast' },
          { role: 'checkbox', name: 'News', testId: 'news', states: ['checked'] },
          { role: 'textbox', name: 'City', testId: 'city', value: 'Kraków' },
          { text: 'Row 4', testId: 'row-4' },
        ],
      ),
      context(),
    );
    expect(result.ok && result.step.lines.slice(1)).toEqual([
      'await expect(screen.getByTestId("toast")).toHaveText("Saved");',
      'await expect(screen.getByTestId("news")).toBeChecked();',
      'await expect(screen.getByTestId("city")).toHaveValue("Kraków");',
    ]);
    expect(result.ok && result.step).toMatchObject({ actions: 1, assertions: 3 });
  });

  it('picks the anchors with a test id before the cap, so guessed ones never take their place', () => {
    const guessed = [1, 2, 3].map((index): TraceTargetDescriptor => ({ role: 'status', name: `Status ${String(index)}` }));
    expect(lines(trace([tap({ testId: 'save' })], [...guessed, { text: 'Saved', testId: 'toast' }]))).toEqual([
      'await screen.getByTestId("save").tap();',
      'await expect(screen.getByTestId("toast")).toHaveText("Saved");',
      'await expect(screen.getByText("Status 1")).toBeVisible();',
      'await expect(screen.getByText("Status 2")).toBeVisible();',
    ]);
  });

  it('leaves out an anchor that names a run-unique value without refusing the step', () => {
    expect(lines(trace([tap({ testId: 'save' })], [{ role: 'status', name: 'Saved' }, { text: 'Hi {{param:/label}}', testId: 'greeting' }]))).toEqual([
      'await screen.getByTestId("save").tap();',
      'await expect(screen.getByText("Saved")).toBeVisible();',
    ]);
  });
});

describe('compileTrace: targets with no test id', () => {
  it('compiles one from its role and name, with a comment, and lists it as unverified', () => {
    const recorded = trace([tap({ role: 'button', name: 'Buy now', within: 'Headphones' })]);
    expect(lines(recorded)).toEqual(['await screen.getByRole("button", "Buy now").tap(); // unverified locator; recorded inside "Headphones"']);
    const compiled = compileTrace(recorded, { fills: { credentials: [], secrets: [] }, appBase: undefined, uniques: new Map() });
    expect(compiled.unverified).toEqual([{ role: 'button', name: 'Buy now', within: 'Headphones' }]);
  });

  it('finds a content-named role by its text, and keeps a position among twins', () => {
    expect(
      lines(trace([{ name: 'secondaryTap', summary: 'right-click', target: { role: 'listitem', name: 'report.pdf', position: { index: 1, of: 3 } } }])),
    ).toEqual(['await screen.getByText("report.pdf").nth(1).secondaryTap(); // unverified locator; 2 of 3 matches, by position']);
  });

  it('refuses a place among twins counted inside a container, which a screen-wide nth() would miscount', () => {
    const refused = refusal(trace([tap({ testId: 'delete', within: 'Budget', position: { index: 1, of: 2 } })]));
    expect(refused.code).toBe('container-position');
    expect(refused.reason).toContain('inside "Budget"');
  });

  it('taps a bare viewport point at the recorded point, naming the viewport it was recorded on', () => {
    expect(lines(trace([{ name: 'tapAt', summary: 'tap at', point: { x: 120.5, y: 48 }, viewport: { width: 800, height: 600 } }]))).toEqual([
      'await screen.tapAt({ x: 120.5, y: 48 }); // a viewport point, recorded at 800x600',
    ]);
  });

  it('gives a long scroll the recorded wait', () => {
    const recorded = trace([{ name: 'scrollUntil', summary: 'scroll', text: 'Row 4322', direction: 'down', target: { testId: 'viewport' } }], [], { endWaitMs: 45_000 });
    expect(lines(recorded)).toEqual([
      'await screen.getByTestId("viewport").scrollUntilVisible(screen.getByText("Row 4322"), { direction: "down", timeout: 45000 });',
    ]);
  });
});

describe('compileTrace: refusals', () => {
  it.each<[string, readonly RecordedAction[], string]>([
    ['runtime-value', [{ name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token' }], 'this run\'s data (minted-token)'],
    ['project-tool', [{ name: 'tool', summary: 'tool seedDatabase' }], 'a project tool ran'],
    ['point', [{ name: 'hoverAt', summary: 'hover at', point: { x: 1, y: 2 }, viewport: { width: 800, height: 600 } }], 'bare viewport point'],
    ['focus-keyboard', [{ name: 'typeText', summary: 'type', value: 'x', replace: false }], 'whatever held focus'],
    ['viewport', [{ name: 'resize', summary: 'resize', size: { width: 390, height: 844 } }], 'viewport size'],
    ['secret-unknown', [{ name: 'typeSecret', summary: 'fill', target: { testId: 'pin' }, secret: 'pin' }], 'neither a credential password'],
    ['secret-value', [{ name: 'type', summary: 'type', target: { testId: 'pin' }, value: '<secret:pin>' }], 'redacted secret'],
    ['unique-unresolved', [{ name: 'type', summary: 'type', target: { testId: 'q' }, value: '{{param:/query}}' }], 'no unique() param at /query'],
    ['no-identity', [tap({ role: 'textbox', within: 'Account' })], 'no role and name, test id'],
  ])('%s', (code, actions, reason) => {
    const refused = refusal(trace([tap({ testId: 'first' }), ...actions]));
    expect(refused.code).toBe(code);
    expect(refused.reason).toContain(reason);
  });

  it('refuses a truncated recording and one with nothing a line repeats', () => {
    expect(refusal(trace([tap({ testId: 'save' })], [], { truncated: true })).code).toBe('truncated');
    expect(refusal(trace([{ name: 'scroll', summary: 'scroll', direction: 'down' }])).code).toBe('empty');
  });
});
