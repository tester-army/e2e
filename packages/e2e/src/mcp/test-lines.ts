/**
 * The test line each grammar action of an `e2e mcp` session answers with:
 * the `screen.*` or `app.*` call that repeats the action in a test, so a
 * coding agent can write the test while it walks the flow instead of calling
 * `locate` for every control afterwards. The locator comes from the target as
 * the newest observation listed it, read before the action runs, since the
 * action may remove it. It is tried in the order the skill recommends (role
 * and name, label, placeholder, text, test id) against the live screen with
 * the locator engine, as `locate` tries one: a locator that matches the
 * target and nothing else is printed, one that matches its twins too is
 * narrowed (to the nodes that render, under a container, or by position, in
 * that order), and otherwise the result says why there is no line. The
 * session keeps the lines in order, and `test_lines` returns them as a draft
 * test body. Only the session catalog wraps its grammar this way; the
 * testing agent's model loop never sees a line.
 */

import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { ExecutorNode, ExecutorObservation, ExecutorObserveOptions, StepExecutorContext } from '../agent/executor.ts';
import { isFailedResult } from '../agent/loop-guards.ts';
import { typedThroughKeyboard } from '../agent/primitives.ts';
import type { ScreenOutput } from '../agent/screen-update.ts';
import type { LocatorExpression, NodeRef, SemanticNode } from '../engine/surface.ts';
import { codedMessage, InfrastructureError } from '../internal/errors.ts';
import { collapseText } from '../internal/text.ts';
import { filterExpression, indexExpression } from '../locator/expression.ts';
import type { Role } from '../types.ts';

/** Matches read per locator while looking for the target among them. */
const MAX_READ_MATCHES = 50;
/**
 * Locators tried per target before giving up on a line. Each is one engine
 * resolve, which on a device is a whole snapshot, so a control nothing names
 * costs a bounded wait rather than every narrowing there is.
 */
const MAX_TRIES = 10;
/** Containers tried, nearest first, to narrow a locator that matches the target's twins too. */
const MAX_CONTAINERS = 3;
/** CSS pixels a match's center may sit outside the target's box and still be the target. */
const BOX_SLACK = 1;

/** The roles `getByRole` takes, so a node read as `generic` never becomes a role query. */
const ROLES: ReadonlySet<string> = new Set(
  Object.keys({
    button: true, link: true, textbox: true, searchbox: true, combobox: true, listbox: true, option: true, checkbox: true,
    radio: true, radiogroup: true, switch: true, slider: true, spinbutton: true, progressbar: true, meter: true, image: true,
    heading: true, tab: true, tablist: true, tabpanel: true, menu: true, menubar: true, menuitem: true, menuitemcheckbox: true,
    menuitemradio: true, toolbar: true, tooltip: true, tree: true, treeitem: true, list: true, listitem: true, table: true,
    grid: true, row: true, rowgroup: true, rowheader: true, cell: true, gridcell: true, columnheader: true, separator: true,
    group: true, article: true, figure: true, form: true, status: true, alert: true, dialog: true, alertdialog: true, main: true,
    navigation: true, banner: true, contentinfo: true, complementary: true, region: true,
  } satisfies Record<Role, true>),
);

/** One query a line can use, as `locate` takes it. */
export interface LineQuery {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly testId?: string;
}

/** A locator: its expression for the engine and its code for the test. */
interface Located {
  readonly expression: LocatorExpression;
  readonly code: string;
}

/** What a line needs of the session around it. */
export interface TestLineOptions {
  /** Builds a query's expression and `screen.*` code, as `locate` does (`locateQuery`). */
  readonly query: (query: LineQuery) => Located;
  /** Every node an expression matches on the live screen now, without waiting (`LocatorEngine.resolveNow`). */
  readonly resolve: (expression: LocatorExpression) => Promise<readonly NodeRef[]>;
  /** One node a resolve returned. */
  readonly read: (ref: NodeRef) => Promise<SemanticNode>;
  /** The attempt's secret ledger, for what a read node says before it goes into a line. */
  readonly redact: (text: string) => string;
  /** The app's base URL, which a navigation line is made relative to. */
  readonly appBase?: { readonly href: string; readonly origin: string } | undefined;
  /** The configured credentials and secrets a fill is written with. */
  readonly fills?: TestLineFills | undefined;
}

/** The names a test fills values from, as the config declares them. */
export interface TestLineFills {
  /** Each credential: the name `credentials.user()` takes, its username, and its password secret's name. */
  readonly credentials: readonly { readonly name: string; readonly username: string; readonly password: string }[];
  /** The `config.secrets` names `secrets.get()` takes. */
  readonly secrets: readonly string[];
}

/** What an action prints: the line, with a comment when it holds only by position, or why there is none. */
type LinePlan = { readonly line: string } | { readonly reason: string };

/** What a locator search found: the locator and how the line comments on it, or why there is none. */
type Found = (Located & { readonly comment?: string }) | { readonly reason: string };

/** A node the newest observation listed, with its ancestors, nearest first, and the screen's root. */
interface Listed {
  readonly node: ExecutorNode;
  readonly ancestors: readonly ExecutorNode[];
  readonly root: ExecutorNode;
}

/** The newest observation's tree, and its nodes by id, each with its parent's id. */
interface Screen {
  readonly root: ExecutorNode;
  readonly nodes: ReadonlyMap<string, { readonly node: ExecutorNode; readonly parent: string | undefined }>;
}

/** What one locator matched: how many nodes, and which of them is the target. */
interface Probe {
  readonly count: number;
  /** The target's index among the matches; -1 when none of the matches read is placed as it. */
  readonly index: number;
  /**
   * Whether the target's place among the matches is certain: the nodes that
   * read like it are the ones the observation listed, each where it was or
   * all moved together. False when only the target's own box placed it,
   * which a twin that moved into it can fool.
   */
  readonly certain: boolean;
  /** Every match read, in the locator engine's order. */
  readonly matches: readonly SemanticNode[];
}

/** The grammar tools that print a line or say why they print none; the point tools print nothing. */
const LINE_TOOLS: ReadonlySet<string> = new Set([
  'tap', 'double_tap', 'long_press', 'right_click', 'hover', 'type', 'type_secret', 'press', 'select', 'check',
  'drag', 'upload', 'scroll', 'scroll_to', 'navigate', 'back', 'dismiss_keyboard',
]);

/** The locator method each node verb's tool repeats as. */
const NODE_METHODS: Readonly<Record<string, string>> = {
  tap: 'tap',
  double_tap: 'doubleTap',
  long_press: 'longPress',
  right_click: 'secondaryTap',
  hover: 'hover',
};

/** One recorded action: its line, or why it has none. */
type Entry = { readonly tool: string } & LinePlan;

/** The test lines of one session: the observations it keeps for them, the wrapped grammar, and `test_lines`. */
export class SessionTestLines {
  private screen: Screen | undefined;
  private readonly entries: Entry[] = [];

  constructor(private readonly options: TestLineOptions) {}

  /**
   * The step context with every observation it takes kept for the lines:
   * each asks for the tree, which is indexed and then dropped again unless
   * the caller asked for it, so what the caller reads does not change.
   */
  watch(context: StepExecutorContext): StepExecutorContext {
    const observe = async (options: ExecutorObserveOptions = {}): Promise<ExecutorObservation> => {
      const observation = await context.observe({ ...options, tree: true });
      this.keep(observation);
      if (options.tree === true) return observation;
      const { tree: _tree, ...rest } = observation;
      return rest;
    };
    // A proxy, not a copy: the context's getters (`pixelsTainted`) must stay live.
    return new Proxy(context, {
      get: (target, key) => (key === 'observe' ? observe : Reflect.get(target, key, target)),
    });
  }

  /** Records the session's opening of the app, which a test does with `app.open()`. */
  opened(): void {
    this.entries.push({ tool: 'open_session', line: 'await app.open();' });
  }

  /** The grammar tools, each that has a line answering with it after its lead. */
  wrap(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, LINE_TOOLS.has(name) && tool.execute !== undefined ? this.wrapped(name, tool) : tool]),
    );
  }

  /** The read-only `test_lines` catalog tool. */
  tool(): ToolSet[string] {
    return {
      description:
        "Every test line this session's actions printed so far, in order, as a draft test body: the screen.* and app.* calls that repeat each action, with a comment where an action has none. Paste it into a test, then add the assertions.",
      inputSchema: z.object({}).strict(),
      execute: async () => this.draft(),
    };
  }

  /** The recorded lines as a draft test body. */
  draft(): string {
    if (this.entries.length === 0) {
      return 'No test lines yet. Each action (tap, type, select, check, and the rest) prints the line that repeats it in a test, and this tool returns them in order.';
    }
    const body = this.entries.map((entry) => ('line' in entry ? entry.line : `// ${entry.tool}: no test line: ${entry.reason}`));
    const imports = ['credentials', 'secrets'].filter((name) => body.some((line) => line.includes(`${name}.`)));
    return [
      `Draft test body from this session's actions, in order (${String(this.entries.filter((entry) => 'line' in entry).length)} lines):`,
      '',
      ...body,
      '',
      `Paste it into a test body, async ({ app, screen }) => { ... }, and add an expect after each step that should change the screen.${
        imports.length === 0 ? '' : ` Import ${imports.join(' and ')} from 'e2e'.`
      }`,
    ].join('\n');
  }

  /** Keeps an observation's tree as the newest screen; one without a tree leaves no id to look up, as for the step. */
  private keep(observation: ExecutorObservation): void {
    this.screen = observation.tree === undefined ? undefined : indexScreen(observation.tree);
  }

  /** The node an id names on the newest screen, with its ancestors. */
  private listed(id: string): Listed | undefined {
    const screen = this.screen;
    const entry = screen?.nodes.get(id.replace(/^#/, ''));
    if (screen === undefined || entry === undefined) return undefined;
    const ancestors: ExecutorNode[] = [];
    for (let parent = entry.parent; parent !== undefined; parent = screen.nodes.get(parent)?.parent) {
      const node = screen.nodes.get(parent)?.node;
      if (node !== undefined) ancestors.push(node);
    }
    return { node: entry.node, ancestors, root: screen.root };
  }

  /** A grammar tool that works out its line before the action and adds it to the result after. */
  private wrapped(name: string, tool: ToolSet[string]): ToolSet[string] {
    const execute = tool.execute!;
    return {
      ...tool,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const plan = await this.plan(name, isRecord(input) ? input : {}).catch(
          (cause: unknown): LinePlan => ({ reason: `trying its locator failed: ${codedMessage(cause)}` }),
        );
        if (options.abortSignal?.aborted === true) throw new InfrastructureError('CANCELLED', 'the tool call was cancelled');
        const output = (await execute(input, options)) as ScreenOutput;
        return this.annotate(name, output, plan);
      },
    } as ToolSet[string];
  }

  /** Records a performed action's line and puts it after the result's lead; a failed action gets none. */
  private annotate(name: string, output: ScreenOutput, plan: LinePlan): ScreenOutput {
    const text = typeof output === 'string' ? output : output.text;
    if (isFailedResult(name, text)) return output;
    const entry: Entry =
      name === 'type' && typedThroughKeyboard(text)
        ? { tool: name, reason: 'the node is not an input and took the value through the keyboard, which no locator line repeats' }
        : { tool: name, ...plan };
    this.entries.push(entry);
    const note = 'line' in entry ? `Test line: ${entry.line}` : `No test line: ${entry.reason}.`;
    const cut = text.indexOf('\n');
    const annotated = cut === -1 ? `${text}\n${note}` : `${text.slice(0, cut)}\n${note}${text.slice(cut)}`;
    return typeof output === 'string' ? annotated : { ...output, text: annotated };
  }

  /** The line an action will print, worked out before it runs, while its target is still on screen. */
  private async plan(name: string, input: Readonly<Record<string, unknown>>): Promise<LinePlan> {
    const target = stringField(input, 'target');
    const method = NODE_METHODS[name];
    if (method !== undefined) {
      const modifiers = Array.isArray(input['modifiers']) && input['modifiers'].length > 0 ? `{ modifiers: ${JSON.stringify(input['modifiers'])} }` : '';
      return this.onTarget(target, (locator) => `${locator}.${method}(${modifiers})`);
    }
    switch (name) {
      case 'type': {
        if (target === undefined) return { reason: 'the value went to the focused field; type into a listed node by id for a line' };
        const value = stringField(input, 'value') ?? '';
        return this.onTarget(target, (locator) => `${locator}.fill(${this.typed(value)})`);
      }
      case 'type_secret': {
        const secret = this.secretExpression(stringField(input, 'name') ?? '');
        if (secret === undefined) return { reason: 'the secret is neither a credential password nor a config secret' };
        return this.onTarget(target, (locator) => `${locator}.fill(${secret})`);
      }
      case 'press': {
        if (target === undefined) return { reason: 'the key went to whatever had focus; press it on a listed node by id for a line' };
        if (typeof input['times'] === 'number' && input['times'] > 1) return { reason: 'a key pressed several times in one call has no one-line equivalent; press it once per call for lines' };
        return this.onTarget(target, (locator) => `${locator}.press(${JSON.stringify(stringField(input, 'key') ?? '')})`);
      }
      case 'select':
        return this.onTarget(target, (locator) => `${locator}.selectOption(${JSON.stringify(stringField(input, 'value') ?? '')})`);
      case 'check':
        return this.onTarget(target, (locator) => `${locator}.${input['checked'] === false ? 'uncheck' : 'check'}()`);
      case 'upload': {
        const files = Array.isArray(input['files']) ? input['files'].filter((file): file is string => typeof file === 'string') : [];
        return this.onTarget(target, (locator) => `${locator}.setInputFiles(${JSON.stringify(files.length === 1 ? files[0] : files)})`);
      }
      case 'drag':
        return this.drag(target, stringField(input, 'to'));
      case 'scroll_to':
        if (target !== undefined && stringField(input, 'text') === undefined) return this.onTarget(target, (locator) => `${locator}.scrollIntoView()`);
        return { reason: 'scrolling to a text has none; a test action brings its node into view, and a row deep in a windowed list takes screen.scrollUntilVisible(locator)' };
      case 'scroll':
        return { reason: 'a test action brings its node into view itself, and a row deep in a windowed list takes screen.scrollUntilVisible(locator)' };
      case 'dismiss_keyboard':
        return { reason: 'a test hides the keyboard only when it covers the next control' };
      case 'navigate':
        return { line: navigationLine(stringField(input, 'url') ?? '', this.options.appBase) };
      case 'back':
        return { line: 'await app.back();' };
      default:
        return { reason: `${name} has no test line` };
    }
  }

  /** A line acting on one target, or why there is none. */
  private async onTarget(id: string | undefined, act: (locator: string) => string): Promise<LinePlan> {
    const found = await this.locator(id);
    if ('reason' in found) return found;
    return { line: `await ${act(found.code)};${found.comment === undefined ? '' : ` // ${found.comment}`}` };
  }

  /** A drag's line: both ends need a locator. */
  private async drag(source: string | undefined, destination: string | undefined): Promise<LinePlan> {
    const from = await this.locator(source);
    if ('reason' in from) return from;
    const to = await this.locator(destination);
    if ('reason' in to) return { reason: `the drop target: ${to.reason}` };
    const comments = [from.comment, to.comment].filter((comment) => comment !== undefined);
    return { line: `await ${from.code}.dragTo(${to.code});${comments.length === 0 ? '' : ` // ${comments.join('; ')}`}` };
  }

  /** A typed value as the line spells it: a credential's username by its name, anything else as written. */
  private typed(value: string): string {
    const credential = this.options.fills?.credentials.find((candidate) => candidate.username === value);
    return credential === undefined ? JSON.stringify(value) : `credentials.user(${JSON.stringify(credential.name)}).username`;
  }

  /** How a test names a secret `type_secret` filled: a credential's password, or a config secret. */
  private secretExpression(name: string): string | undefined {
    const credential = this.options.fills?.credentials.find((candidate) => candidate.password === name);
    if (credential !== undefined) return `credentials.user(${JSON.stringify(credential.name)}).password`;
    return this.options.fills?.secrets.includes(name) === true ? `secrets.get(${JSON.stringify(name)})` : undefined;
  }

  /**
   * The locator a test line uses for a target id: the first query from the
   * node's own fields that matches it alone; else the query that matched it
   * among its twins, kept to the nodes that render or scoped under a
   * container that tells them apart; else that query by position, with a
   * comment saying so, when its place among the twins is certain.
   */
  private async locator(id: string | undefined): Promise<Found> {
    if (id === undefined) return { reason: 'the action names no node' };
    const listed = this.listed(id);
    if (listed === undefined) return { reason: `#${id.replace(/^#/, '')} is not on the newest screen` };
    const { node } = listed;
    let tries = MAX_TRIES;
    const attempt = async (expression: LocatorExpression, within: ExecutorNode = listed.root): Promise<Probe | undefined> => {
      if (tries <= 0) return undefined;
      tries -= 1;
      return this.probe(expression, listed, within);
    };
    let twins: { readonly located: Located; readonly probe: Probe } | undefined;
    let match: SemanticNode | undefined;
    let matchCertain = false;
    const queries = nodeQueries(node);
    for (const query of queries) {
      const located = this.options.query(query);
      const probe = await attempt(located.expression);
      if (probe === undefined) break;
      if (probe.count === 1 && probe.index === 0) return located;
      if (probe.index >= 0 && (match === undefined || (probe.certain && !matchCertain))) {
        match = probe.matches[probe.index];
        matchCertain = probe.certain;
      }
      if (probe.count > 1 && probe.index >= 0 && (twins === undefined || (probe.certain && !twins.probe.certain))) twins = { located, probe };
    }
    // The tree an observation hands over carries no test id; the node the
    // locator engine read does, found among the matches of its role.
    if (match === undefined && node.role !== undefined && ROLES.has(node.role)) {
      const probe = await attempt(this.options.query({ role: node.role }).expression);
      if (probe !== undefined && probe.index >= 0) {
        match = probe.matches[probe.index];
        matchCertain = probe.certain;
      }
    }
    // Only a match placed for certain lends its test id: one its box alone
    // placed may be a twin that moved there, and its id would name the twin.
    const testId = !matchCertain || match?.testId === undefined ? undefined : clean(this.options.redact(match.testId));
    if (testId !== undefined) {
      const located = this.options.query({ testId });
      const probe = await attempt(located.expression);
      if (probe !== undefined && probe.count === 1 && probe.matches[0]?.testId === match?.testId) return located;
    }
    if (twins === undefined) {
      if (tries <= 0) return { reason: `no locator found it alone within ${String(MAX_TRIES)} tries; try locate` };
      return {
        reason:
          queries.length === 0 && testId === undefined
            ? 'the node has no name, text, placeholder, or test id to find it by'
            : 'no locator from its role and name, label, placeholder, text, or test id finds it on the live screen; try locate',
      };
    }
    const visible = visibleOnly(twins.located);
    if (visible !== undefined) {
      const probe = await attempt(visible.expression);
      if (probe !== undefined && probe.count === 1 && probe.index === 0) return visible;
    }
    for (const scope of containerScopes(listed, this.options.query)) {
      const expression = scopedUnder(twins.located.expression, scope.located.expression);
      if (expression === undefined) break;
      const probe = await attempt(expression, scope.within);
      if (probe === undefined) break;
      if (probe.count === 1 && probe.index === 0) return { expression, code: `${scope.located.code}${twins.located.code.replace(/^screen/, '')}` };
    }
    const { count, index, certain } = twins.probe;
    // A position is only as good as the evidence for it: a box from the
    // observation may have moved onto a twin since.
    if (!certain) return { reason: `it shares ${twins.located.code} with ${String(count - 1)} other nodes, and nothing on the screen tells it apart for certain` };
    return {
      expression: indexExpression(twins.located.expression, index),
      code: `${twins.located.code}${index === 0 ? '.first()' : `.nth(${String(index)})`}`,
      comment: `${String(index + 1)} of ${String(count)} matches, by position; a unique name or test id holds up better`,
    };
  }

  /**
   * How many nodes a locator matches now, and which of them is the target.
   * When every match was read and the matches that read like the target are
   * the twins the observation listed under `within`, each where it was or
   * all moved together, the target's place is certain: the twin in its turn,
   * or, when the engine lists them in another order than the observation
   * (light DOM before shadow roots), the one still in its box. Otherwise it
   * is the one match centered in its box from the observation, as an inner
   * text element sits inside the button it names, and the place is not
   * certain.
   */
  private async probe(expression: LocatorExpression, listed: Listed, within: ExecutorNode): Promise<Probe> {
    const refs = await this.options.resolve(expression);
    const matches: SemanticNode[] = [];
    for (const ref of refs.slice(0, MAX_READ_MATCHES)) matches.push(await this.options.read(ref));
    const count = refs.length;
    const target = listed.node;
    if (matches.length === count) {
      const self = identityOf(target);
      const alike = matches.flatMap((match, index) => (identityOf(match, this.options.redact) === self ? [index] : []));
      const twins = twinsOf(within, target);
      if (alike.length === twins.length) {
        const turn = twins.indexOf(target);
        if (twins.length === 1 || movedTogether(twins, alike.map((index) => matches[index]!))) return { count, index: alike[turn]!, certain: true, matches };
        const still = alike.filter((index) => centeredIn(matches[index]!, target));
        if (still.length === 1 && stayedPut(twins, alike.map((index) => matches[index]!))) return { count, index: still[0]!, certain: true, matches };
      }
    }
    const boxed = matches.flatMap((match, index) => (centeredIn(match, target) ? [index] : []));
    return { count, index: boxed.length === 1 ? boxed[0]! : -1, certain: false, matches };
  }
}

/**
 * The queries a node's own fields give, in the order the skill recommends:
 * role and name, then label, placeholder, and text. The test id is not among
 * an observation's fields; the line search reads it off the live node.
 */
export function nodeQueries(node: ExecutorNode): readonly LineQuery[] {
  const queries: LineQuery[] = [];
  const name = clean(node.name);
  if (name !== undefined && node.role !== undefined && ROLES.has(node.role)) queries.push({ role: node.role, name });
  if (name !== undefined) queries.push({ label: name });
  const placeholder = clean(node.attributes?.['placeholder']);
  if (placeholder !== undefined) queries.push({ placeholder });
  for (const text of new Set([clean(node.text), name])) {
    if (text !== undefined) queries.push({ text });
  }
  return queries;
}

/**
 * The `app.open` line for a navigation: a URL on the app's origin as its
 * path, so the line holds on the port the next run gets, the base URL itself
 * as `app.open()`, anything else as given.
 */
export function navigationLine(url: string, base: { readonly href: string; readonly origin: string } | undefined): string {
  if (base !== undefined && URL.canParse(url, base.href)) {
    const resolved = new URL(url, base.href);
    if (resolved.href === base.href) return 'await app.open();';
    if (resolved.origin === base.origin) return `await app.open(${JSON.stringify(`${resolved.pathname}${resolved.search}${resolved.hash}`)});`;
  }
  return `await app.open(${JSON.stringify(url)});`;
}

/**
 * The containers a locator can be scoped under to tell the target from its
 * twins, nearest first: an ancestor with a role, by its name, or by the
 * first text it holds outside the target, the way a test scopes the
 * "Delete" button of one row.
 */
function containerScopes(listed: Listed, query: (query: LineQuery) => Located): { readonly located: Located; readonly within: ExecutorNode }[] {
  const scopes: { readonly located: Located; readonly within: ExecutorNode }[] = [];
  let containers = 0;
  for (const ancestor of listed.ancestors) {
    const role = ancestor.role;
    if (role === undefined || !ROLES.has(role)) continue;
    if (containers >= MAX_CONTAINERS) break;
    containers += 1;
    const name = clean(ancestor.name);
    if (name !== undefined) scopes.push({ located: query({ role, name }), within: ancestor });
    const text = firstText(ancestor, listed.node.id) ?? clean(ancestor.text);
    if (text !== undefined && text !== name) {
      const base = query({ role });
      scopes.push({
        located: { expression: filterExpression(base.expression, { hasText: text }), code: `${base.code}.filter({ hasText: ${JSON.stringify(text)} })` },
        within: ancestor,
      });
    }
  }
  return scopes;
}

/** The first text a container holds, depth first, outside the subtree of `skip`. */
function firstText(node: ExecutorNode, skip: string): string | undefined {
  for (const child of node.children ?? []) {
    if (child.id === skip) continue;
    if ((child.children?.length ?? 0) === 0) {
      const own = clean(child.text) ?? clean(child.name);
      if (own !== undefined) return own;
      continue;
    }
    const deeper = firstText(child, skip);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/**
 * A bare query kept to the nodes that render, the way a test steps past a
 * hidden twin (`visible: true`); undefined for anything else, or a query
 * whose code already carries options.
 */
function visibleOnly(located: Located): Located | undefined {
  const { expression, code } = located;
  if (expression.kind !== 'query' || expression.scope !== undefined || code.includes('{')) return undefined;
  return { expression: { ...expression, query: { ...expression.query, visible: true } }, code: `${code.slice(0, -1)}, { visible: true })` };
}

/** A query expression scoped under another expression; undefined for an expression that is not a bare query. */
function scopedUnder(child: LocatorExpression, scope: LocatorExpression): LocatorExpression | undefined {
  return child.kind === 'query' && child.scope === undefined ? { ...child, scope } : undefined;
}

/** Whether a node the locator engine read sits with its center inside the target's box from the observation. */
function centeredIn(match: SemanticNode, target: ExecutorNode): boolean {
  const box = target.rect;
  const found = match.rect;
  if (box === undefined || found === undefined) return false;
  const x = found.x + found.width / 2;
  const y = found.y + found.height / 2;
  return x >= box.x - BOX_SLACK && x <= box.x + box.width + BOX_SLACK && y >= box.y - BOX_SLACK && y <= box.y + box.height + BOX_SLACK;
}

/**
 * What a node reads as: its role, name, text, and placeholder, in the
 * one-line form. A node the locator engine read passes the ledger first, as
 * the observation's nodes already did.
 */
function identityOf(node: ExecutorNode | SemanticNode, redact: (text: string) => string = (text) => text): string {
  const field = (value: string | undefined) => clean(value === undefined ? undefined : redact(value)) ?? '';
  return [node.role ?? '', field(node.name), field(node.text), field(node.attributes?.['placeholder'])].join('\u0000');
}

/**
 * The nodes under `root` that read like the target, in the observation's
 * order, the target among them; only those in the target's own frame, which
 * is the only one a locator without a frame reaches.
 */
function twinsOf(root: ExecutorNode, target: ExecutorNode): readonly ExecutorNode[] {
  const self = identityOf(target);
  const frame = JSON.stringify(target.framePath ?? []);
  const twins: ExecutorNode[] = [];
  const walk = (node: ExecutorNode): void => {
    if (identityOf(node) === self && JSON.stringify(node.framePath ?? []) === frame) twins.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return twins;
}

/** Whether each live twin, taken in turn, sits where its observed twin sat, every one moved by the same offset. */
function movedTogether(observed: readonly ExecutorNode[], live: readonly SemanticNode[]): boolean {
  let shift: { readonly x: number; readonly y: number } | undefined;
  return observed.every((twin, index) => {
    const was = twin.rect;
    const now = live[index]?.rect;
    if (was === undefined || now === undefined) return false;
    const moved = { x: now.x - was.x, y: now.y - was.y };
    shift ??= moved;
    return Math.abs(moved.x - shift.x) <= BOX_SLACK && Math.abs(moved.y - shift.y) <= BOX_SLACK;
  });
}

/** Whether every live twin is centered in the box of exactly one observed twin, each box taken once: the same twins, none moved. */
function stayedPut(observed: readonly ExecutorNode[], live: readonly SemanticNode[]): boolean {
  const taken = new Set<string>();
  return live.every((match) => {
    const boxes = observed.filter((twin) => centeredIn(match, twin));
    const box = boxes[0];
    if (boxes.length !== 1 || box === undefined || taken.has(box.id)) return false;
    taken.add(box.id);
    return true;
  });
}

/** Indexes an observation's tree by id, each node with its parent's id. */
function indexScreen(root: ExecutorNode): Screen {
  const nodes = new Map<string, { readonly node: ExecutorNode; readonly parent: string | undefined }>();
  const walk = (node: ExecutorNode, parent: string | undefined): void => {
    nodes.set(node.id, { node, parent });
    for (const child of node.children ?? []) walk(child, node.id);
  };
  walk(root, undefined);
  return { root, nodes };
}

/** Text in the one-line form a locator matches against, or undefined for none. */
function clean(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const collapsed = collapseText(text);
  return collapsed === '' ? undefined : collapsed;
}

/** A string argument of a tool call, or undefined. */
function stringField(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/** Whether a tool's input is an object to read arguments from. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
