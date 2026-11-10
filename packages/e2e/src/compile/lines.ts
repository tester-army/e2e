/**
 * One recorded `agent.act()` step as test lines: each grammar action of a
 * `trace-1` entry becomes the `screen.*` or `app.*` call that repeats it,
 * and the step's end anchors become `expect` lines. A step compiles whole or
 * not at all: one action no locator line repeats (a project-tool gap, a bare
 * viewport point, keyboard input to whatever held focus) leaves the step to
 * the agent, with the reason.
 *
 * Unlike the MCP session's lines (`mcp/test-lines.ts`), nothing here sees the
 * live screen: a locator comes from the recorded descriptor alone. So the
 * default is conservative: a target without a test id leaves the step to the
 * agent (`unverified-locator`). Under `loose` such a target compiles from its
 * role and name, text, or placeholder, with a comment saying so, and a
 * locator that also matches a twin fails loudly when the compiled test runs.
 */

import { CONTENT_NAMED_ROLES } from '../mcp/catalog.ts';
import { navigationLine, ROLES } from '../mcp/test-lines.ts';
import { targetLabel, type RecordedAction, type TraceTargetDescriptor, type ActionTrace } from '../cache/trace.ts';

/** Roles whose end anchor is the step's visible outcome even without a test id or state. */
const OUTCOME_ROLES: ReadonlySet<string> = new Set(['status', 'alert', 'dialog', 'alertdialog']);

/** End anchors turned into assertions, at most. */
const MAX_ASSERTIONS = 3;

/** Anchor text longer than this is asserted as contained, not whole: a recorded text is bounded. */
const MAX_WHOLE_TEXT = 80;

const PLACEHOLDER = /\{\{param:([^}|]*)(\|[^}]*)?\}\}/gu;

/** The names a compiled line fills values from, as the config declares them. */
export interface CompileFills {
  /** Each credential: the name `credentials.user()` takes, its username, and its password secret's name. */
  readonly credentials: readonly { readonly name: string; readonly username: string; readonly password: string }[];
  /** The `config.secrets` names `secrets.get()` takes. */
  readonly secrets: readonly string[];
}

/**
 * Why a step stays an `agent.act()`, as a stable id a tool or a person can
 * key on: `e2e compile status --json` reports it, and a coverage count
 * groups by it.
 */
export type RefusalCode =
  | 'truncated'
  | 'empty'
  | 'unverified-locator'
  | 'long-scroll'
  | 'viewport'
  | 'point'
  | 'focus-keyboard'
  | 'project-tool'
  | 'runtime-value'
  | 'no-identity'
  | 'container-position'
  | 'secret-value'
  | 'secret-unknown'
  | 'unique-unresolved';

/** What compiling one step needs beyond its trace. */
export interface CompileContext {
  /**
   * Compile targets with no test id too, from their role and name, text, or
   * placeholder, unchecked against a live screen. Off by default: such a step
   * stays an `agent.act()` with `unverified-locator`.
   */
  readonly loose?: boolean;
  readonly fills: CompileFills;
  /** The target app's base URL, which a navigation line is made relative to. */
  readonly appBase: { readonly href: string; readonly origin: string } | undefined;
  /** The source expression of each `unique()` param, by its JSON Pointer in the call's params. */
  readonly uniques: ReadonlyMap<string, string>;
}

/** A compiled step: its lines, and the free names they use (fixtures and `e2e` exports). */
export interface CompiledStep {
  readonly lines: readonly string[];
  readonly actions: number;
  readonly assertions: number;
  readonly fixtures: ReadonlySet<'screen' | 'app'>;
  readonly imports: ReadonlySet<'expect' | 'credentials' | 'secrets'>;
}

/**
 * A compiled step, or why the step stays an `agent.act()`. `unverified` lists
 * the targets found by a locator nothing checked: what a test id would make
 * safe, and on a compiled step under `loose`, what its lines guess.
 */
export type CompileResult =
  | { readonly ok: true; readonly step: CompiledStep; readonly unverified: readonly TraceTargetDescriptor[] }
  | { readonly ok: false; readonly code: RefusalCode; readonly reason: string; readonly unverified: readonly TraceTargetDescriptor[] };

/** Thrown inside one step's compilation to leave the whole step to the agent. */
class Uncompilable extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** Compiles one recorded step, or says why it stays an `agent.act()`. */
export function compileTrace(trace: ActionTrace, context: CompileContext): CompileResult {
  if (trace.truncated === true) return { ok: false, code: 'truncated', reason: 'the recording overflowed a cap and only documents the step', unverified: [] };
  const fixtures = new Set<'screen' | 'app'>();
  const imports = new Set<'expect' | 'credentials' | 'secrets'>();
  const writer = new LineWriter(context, fixtures, imports, trace.endWaitMs);
  const lines: string[] = [];
  try {
    for (const [index, action] of trace.actions.entries()) {
      const line = writer.action(action, index);
      if (line !== undefined) lines.push(line);
    }
  } catch (cause) {
    if (cause instanceof Uncompilable) return { ok: false, code: cause.code, reason: cause.message, unverified: writer.unverified };
    throw cause;
  }
  // The call evaluated each unique() once; a line per use would evaluate an expression again, unless it is a plain name.
  for (const [pointer, uses] of writer.uniqueUses) {
    const expression = context.uniques.get(pointer) ?? '';
    if (uses > 1 && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(expression)) {
      return { ok: false, code: 'unique-unresolved', reason: `the unique() value ${expression} is typed ${String(uses)} times, and each line would evaluate it again; bind it to a const first`, unverified: [] };
    }
  }
  if (lines.length === 0) return { ok: false, code: 'empty', reason: 'the recording holds no action a test line repeats', unverified: [] };
  if (context.loose !== true && writer.unverified.length > 0) {
    const named = [...new Set(writer.unverified.map((target) => targetLabel(target)))].join(', ');
    return { ok: false, code: 'unverified-locator', reason: `no test id on ${named}; a locator from the recording alone may match a twin (--loose compiles it anyway)`, unverified: writer.unverified };
  }
  const actions = lines.length;
  for (const anchor of chosenAnchors(trace.endAnchors ?? [], context.loose === true)) {
    const line = writer.assertion(anchor);
    if (line !== undefined) lines.push(line);
  }
  return { ok: true, step: { lines, actions, assertions: lines.length - actions, fixtures, imports }, unverified: writer.unverified };
}

/**
 * The end anchors worth asserting, in recorded order: under `loose`, the ones
 * with a test id, a state, a value, or an outcome role; otherwise only the
 * ones with a test id, chosen before the cap so a guessed one never takes a
 * place.
 */
function chosenAnchors(anchors: readonly TraceTargetDescriptor[], loose: boolean): readonly TraceTargetDescriptor[] {
  return anchors
    .filter((anchor) =>
      loose ? anchor.testId !== undefined || (anchor.states?.length ?? 0) > 0 || anchor.value !== undefined || OUTCOME_ROLES.has(anchor.role ?? '') : anchor.testId !== undefined,
    )
    .filter((anchor) => !Object.values(anchor).some((value) => typeof value === 'string' && (value.includes('<secret:') || value.includes('{{param:'))))
    .slice(0, MAX_ASSERTIONS);
}

/** Writes the line of each action and anchor, noting the fixtures and imports they use. */
class LineWriter {
  /** Action targets found by a locator without a test id, in recorded order. */
  readonly unverified: TraceTargetDescriptor[] = [];
  /** How many lines each `unique()` param's expression is written into, by pointer. */
  readonly uniqueUses = new Map<string, number>();

  constructor(
    private readonly context: CompileContext,
    private readonly fixtures: Set<'screen' | 'app'>,
    private readonly imports: Set<'expect' | 'credentials' | 'secrets'>,
    /** How long the recorded step took, with a margin: the wait a long scroll is given. */
    private readonly endWaitMs: number | undefined,
  ) {}

  /** One action's line; undefined for an action a test does not repeat (a plain scroll, a hidden keyboard). */
  action(action: RecordedAction, index: number): string | undefined {
    const where = `action ${String(index + 1)} (${action.summary})`;
    switch (action.name) {
      case 'tap':
      case 'doubleTap':
      case 'longPress':
      case 'secondaryTap':
      case 'hover': {
        const modifiers = action.modifiers !== undefined && action.modifiers.length > 0 ? `{ modifiers: ${JSON.stringify(action.modifiers)} }` : '';
        return this.on(action.target, (locator) => `${locator}.${action.name}(${modifiers})`);
      }
      case 'scrollTo':
        return this.on(action.target, (locator) => `${locator}.scrollIntoView()`);
      case 'type':
        return this.on(action.target, (locator) => `${locator}.fill(${this.typed(action.value, where)})`);
      case 'typeSecret':
        return this.on(action.target, (locator) => `${locator}.fill(${this.secret(action.secret, where)})`);
      case 'press':
        return this.on(action.target, (locator) => `${locator}.press(${JSON.stringify(action.key)})`);
      case 'select':
        return this.on(action.target, (locator) => `${locator}.selectOption(${this.typed(action.value, where)})`);
      case 'check':
        return this.on(action.target, (locator) => `${locator}.${action.checked ? 'check' : 'uncheck'}()`);
      case 'upload': {
        for (const file of action.paths) this.verbatim(file, where);
        return this.on(action.target, (locator) => `${locator}.setInputFiles(${JSON.stringify(action.paths.length === 1 ? action.paths[0] : action.paths)})`);
      }
      case 'drag': {
        const destination = this.locator(action.destination);
        return this.on(action.target, (locator) => `${locator}.dragTo(${destination})`);
      }
      case 'scrollUntil': {
        if (this.context.loose !== true) throw new Uncompilable('long-scroll', `${where}: a test's scroll pages at its own pace, and a long one may time out where the agent's did not (--loose compiles it anyway)`);
        this.fixtures.add('screen');
        const scroller = action.target === undefined ? 'screen' : this.locator(action.target);
        const sought = `screen.getByText(${this.typed(action.text, where)})`;
        const timeout = this.endWaitMs === undefined ? '' : `, timeout: ${String(this.endWaitMs)}`;
        return `await ${scroller}.scrollUntilVisible(${sought}, { direction: ${JSON.stringify(action.direction)}${timeout} });`;
      }
      case 'scroll':
      case 'dismissKeyboard':
        // A test action brings its node into view and steps past the keyboard itself.
        return undefined;
      case 'navigate':
        this.verbatim(action.url, where);
        this.fixtures.add('app');
        return navigationLine(action.url, this.context.appBase);
      case 'back':
        this.fixtures.add('app');
        return 'await app.back();';
      case 'resize':
        throw new Uncompilable('viewport', `${where}: the viewport size is the engine fixture's call, which a compiled line does not name`);
      case 'tapAt':
      case 'hoverAt':
      case 'dragAt':
        throw new Uncompilable('point', `${where}: a bare viewport point has no locator line`);
      case 'typeText':
      case 'pressKey':
        throw new Uncompilable('focus-keyboard', `${where}: keyboard input to whatever held focus has no locator line`);
      case 'tool':
        throw new Uncompilable(
          action.derived === undefined ? 'project-tool' : 'runtime-value',
          action.derived === undefined
            ? `${where}: a project tool ran, which no test line repeats`
            : `${where}: the typed value was this run's data (${action.derived}), not the flow's`,
        );
    }
  }

  /** An `expect` line for one end anchor; undefined when the anchor gives nothing to find it by. */
  assertion(anchor: TraceTargetDescriptor): string | undefined {
    let locator: string;
    try {
      locator = this.locator(anchor, 'anchor');
    } catch (cause) {
      if (cause instanceof Uncompilable) return undefined;
      throw cause;
    }
    this.imports.add('expect');
    const states = anchor.states ?? [];
    if (states.includes('checked')) return `await expect(${locator}).toBeChecked();`;
    // A value cut at the recorder's limit ends in an ellipsis no field holds.
    if (anchor.value !== undefined && !anchor.value.includes('fakepath') && !anchor.value.endsWith('…')) return `await expect(${locator}).toHaveValue(${JSON.stringify(anchor.value)});`;
    const text = anchor.text;
    if (text !== undefined && !locator.includes(JSON.stringify(text)) && !text.includes('{{param:')) {
      return text.length > MAX_WHOLE_TEXT
        ? `await expect(${locator}).toContainText(${JSON.stringify(text.slice(0, MAX_WHOLE_TEXT))});`
        : `await expect(${locator}).toHaveText(${JSON.stringify(text)});`;
    }
    return `await expect(${locator}).toBeVisible();`;
  }

  /** A line acting on one recorded target. */
  private on(target: TraceTargetDescriptor, act: (locator: string) => string): string {
    const locator = this.locator(target);
    const notes = [
      target.testId === undefined ? 'unverified locator' : undefined,
      // A container key holding a redacted secret or a run-unique value stays out of the file.
      target.within === undefined || /<secret:|\{\{param:/u.test(target.within) ? undefined : `recorded inside ${JSON.stringify(target.within)}`,
      target.position === undefined ? undefined : `${String(target.position.index + 1)} of ${String(target.position.of)} matches, by position`,
    ].filter((note) => note !== undefined);
    return `await ${act(locator)};${notes.length === 0 ? '' : ` // ${notes.join('; ')}`}`;
  }

  /**
   * The locator a recorded descriptor reads as: test id, then role and name,
   * placeholder, text, and the name as a label, the first the descriptor has.
   * A position among twins becomes `.nth()`.
   */
  private locator(target: TraceTargetDescriptor, use: 'action' | 'anchor' = 'action'): string {
    const { role, name, testId, placeholder, text } = target;
    for (const value of [name, testId, placeholder, text]) {
      if (value !== undefined && (value.includes('<secret:') || value.includes('{{param:'))) {
        throw new Uncompilable('runtime-value', `a recorded target names a secret or a run-unique value: ${JSON.stringify(value)}`);
      }
    }
    if (testId === undefined) {
      // An assertion is optional: without a test id it is left out unless loose, never refused.
      if (use === 'anchor' && this.context.loose !== true) throw new Uncompilable('unverified-locator', 'anchor without a test id');
      if (use === 'action' && (name !== undefined || text !== undefined || placeholder !== undefined)) this.unverified.push(target);
    }
    this.fixtures.add('screen');
    // A content-named role's name is its text unless a distinct text says the name is a real label.
    const contentNamed = role !== undefined && CONTENT_NAMED_ROLES.has(role) && (text === undefined || name === text);
    let base: string | undefined;
    // Nothing here checks a locator against a live screen, so a test id, unique by convention,
    // goes before a role and name that a twin may share.
    if (testId !== undefined) base = `screen.getByTestId(${JSON.stringify(portableTestId(testId))})`;
    else if (role !== undefined && ROLES.has(role) && name !== undefined && !contentNamed) {
      base = `screen.getByRole(${JSON.stringify(role)}, ${JSON.stringify(name)})`;
    }
    else if (placeholder !== undefined) base = `screen.getByPlaceholder(${JSON.stringify(placeholder)})`;
    else if (text !== undefined) base = `screen.getByText(${JSON.stringify(text)})`;
    else if (contentNamed && name !== undefined) base = `screen.getByText(${JSON.stringify(name)})`;
    else if (name !== undefined) base = `screen.getByLabel(${JSON.stringify(name)})`;
    if (base === undefined) throw new Uncompilable('no-identity', `a recorded target has no role and name, test id, placeholder, or text: ${JSON.stringify(target)}`);
    const position = target.position;
    if (position === undefined || position.of <= 1) return base;
    // The place was counted among the twins inside the container; a screen-wide .nth() would count others too.
    if (target.within !== undefined) {
      throw new Uncompilable('container-position', `${targetLabel(target)} was one of ${String(position.of)} alike inside "${target.within}", and a test line cannot scope a locator to that container`);
    }
    return `${base}${position.index === 0 ? '.first()' : `.nth(${String(position.index)})`}`;
  }

  /**
   * A typed value as a line spells it: a `unique()` param by the expression
   * the test passed, a credential's username by its name, anything else as
   * recorded.
   */
  private typed(value: string, where: string): string {
    if (value.includes('<secret:')) throw new Uncompilable('secret-value', `${where}: the value carries a redacted secret`);
    const credential = this.context.fills.credentials.find((candidate) => candidate.username === value);
    if (credential !== undefined) {
      this.imports.add('credentials');
      return `credentials.user(${JSON.stringify(credential.name)}).username`;
    }
    if (!value.includes('{{param:')) return JSON.stringify(value);
    const parts: string[] = [];
    const expressions: string[] = [];
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      const [whole, pointer = '', encoding] = match;
      if (encoding !== undefined) throw new Uncompilable('unique-unresolved', `${where}: a unique() value is typed ${encoding.slice(1)}-encoded`);
      const expression = this.context.uniques.get(pointer);
      if (expression === undefined) throw new Uncompilable('unique-unresolved', `${where}: no unique() param at ${pointer} in the call's params`);
      this.uniqueUses.set(pointer, (this.uniqueUses.get(pointer) ?? 0) + 1);
      parts.push(escapeTemplate(value.slice(last, match.index)), `\${${expression}}`);
      expressions.push(expression);
      last = match.index + whole.length;
    }
    parts.push(escapeTemplate(value.slice(last)));
    // The value is the expression itself only when one placeholder is all it holds.
    if (expressions.length === 1 && parts.length === 3 && parts[0] === '' && parts[2] === '') return expressions[0]!;
    return `\`${parts.join('')}\``;
  }

  /** Refuses a value replayed as given (a URL, a file path) that holds a run-unique value or a redacted secret. */
  private verbatim(value: string, where: string): void {
    if (value.includes('<secret:')) throw new Uncompilable('secret-value', `${where}: ${JSON.stringify(value)} holds a redacted secret`);
    if (value.includes('{{param:')) throw new Uncompilable('unique-unresolved', `${where}: ${JSON.stringify(value)} holds a unique() value, which only a typed value is written with`);
  }

  /** How a test names a secret the agent filled: a credential's password, or a config secret. */
  private secret(name: string, where: string): string {
    const credential = this.context.fills.credentials.find((candidate) => candidate.password === name);
    if (credential !== undefined) {
      this.imports.add('credentials');
      return `credentials.user(${JSON.stringify(credential.name)}).password`;
    }
    if (this.context.fills.secrets.includes(name)) {
      this.imports.add('secrets');
      return `secrets.get(${JSON.stringify(name)})`;
    }
    throw new Uncompilable('secret-unknown', `${where}: the secret ${JSON.stringify(name)} is neither a credential password nor a config secret`);
  }
}

/**
 * A recorded test id as a line names it on every platform: an Android
 * resource id without its `<package>:id/` prefix. UIAutomator reports a .NET
 * MAUI `AutomationId` or a native `android:id` that way, iOS never prefixes
 * one, and the mobile engine matches the short form when nothing matches the
 * full id, so the short form is the one a test on both platforms finds. The
 * framework's own `android:id/...` keeps its prefix.
 */
function portableTestId(testId: string): string {
  const match = /^([A-Za-z][\w.]*):id\/(.+)$/u.exec(testId);
  return match === null || match[1] === 'android' ? testId : match[2]!;
}

/** Text placed inside a template literal as itself. */
function escapeTemplate(text: string): string {
  return text.replace(/[`\\]|\$\{/gu, (match) => `\\${match}`);
}
