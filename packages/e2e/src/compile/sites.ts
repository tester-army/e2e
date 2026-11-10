/**
 * What a test file holds for `e2e compile`, read with oxc and never
 * evaluated: the `agent.act()` calls in each test's own callback, their
 * instructions and params as far as the source spells them, the fixtures the
 * callback destructures, and the compiled blocks already in the file.
 *
 * A call compiles in place only as a bare `await agent.act('<literal>', ...)`
 * statement directly in the test's own callback: one in a loop, a branch, or
 * a helper may run another number of times than its source shows, so its
 * recording cannot be pinned to it. A compiled block is a JSDoc comment
 * tagged `@compiled`, the lines, and a `/** @end compiled *\/` comment; the
 * comments are found in oxc's comment list, so a formatter, a trailing
 * comment, or CRLF line ends leave a block readable.
 */

import { oxcParser } from '../config/typescript.ts';
import { instructionDigest } from '../cache/identity.ts';
import { paramPointer } from '../cache/template.ts';

/** An oxc ESTree node, read loosely: only the fields this module walks. */
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

/**
 * A params value as far as the source spells it: literals, arrays, and
 * objects of them, a `unique()` value, and a secret or a username named
 * through `secrets.get()` or `credentials.user()`. Anything else makes the
 * whole params undefined.
 */
export type StaticValue =
  | { readonly type: 'json'; readonly value: string | number | boolean | null }
  | { readonly type: 'array'; readonly items: readonly StaticValue[] }
  | { readonly type: 'object'; readonly entries: readonly (readonly [string, StaticValue])[] }
  | { readonly type: 'unique' }
  | { readonly type: 'secret'; readonly name: string }
  | { readonly type: 'username'; readonly credential: string };

/** One `agent.act()` call in a test callback. */
export interface ActSite {
  /** The instruction, when it is a literal; undefined for one built at run time. */
  readonly instruction: string | undefined;
  readonly digest: string | undefined;
  /**
   * The call's params as the source spells them: `null` for a call with none,
   * undefined when an argument is not a literal the source can read (a
   * variable, a spread, a value computed at run time).
   */
  readonly params: StaticValue | null | undefined;
  /** Each `unique()` param's argument source, by its JSON Pointer in `params`. */
  readonly uniques: ReadonlyMap<string, string>;
  /**
   * The options the call passes that a compiled block would drop with
   * effect: a hook (`onAction`, `onBeforeAction`), a `timeout`, or options
   * the source does not spell out. `params` and the agent's own budgets
   * (`maxSteps`, `maxModelCalls`) are not among them.
   */
  readonly droppedOptions: readonly string[];
  /** Set when the call is not a bare statement of the callback body: why it cannot be replaced. */
  readonly nested: string | undefined;
  /** The statement to replace, as source offsets. */
  readonly start: number;
  readonly end: number;
  /** One-based line of the call. */
  readonly line: number;
  /** The whitespace the statement's line starts with. */
  readonly indent: string;
  /** The statement's source text, exactly: what `revert` puts back. */
  readonly source: string;
}

/** A test declaration's callback and the `agent.act()` calls in it. */
export interface TestSource {
  readonly sites: readonly ActSite[];
  /** The fixtures the callback destructures: local names by fixture name. */
  readonly fixtures: ReadonlyMap<string, string>;
  /** Whether the pattern gathers the rest of the fixtures (`...rest`), after which nothing may be added. */
  readonly fixtureRest: boolean;
  /** Where a missing fixture is inserted (after the pattern's last property), or undefined when the parameter is not a pattern. */
  readonly fixtureInsert: number | undefined;
  /** The callback's body, as source offsets. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** Every name the callback declares: its parameters and each binding anywhere in its body. */
  readonly bodyNames: ReadonlySet<string>;
}

/** A compiled block: its tags, and the source range from its `@compiled` comment to its end comment. */
export interface CompiledBlock {
  readonly start: number;
  readonly end: number;
  /** One-based line of the `@compiled` comment. */
  readonly line: number;
  /** The statement it was compiled from, exactly. */
  readonly from: string;
  /** The first characters of the recording's key hash. */
  readonly recording: string | undefined;
  /** The step the recording was keyed by, as `<instruction digest>.<params digest>`, each shortened. */
  readonly step: string | undefined;
  readonly recordedAt: string | undefined;
  readonly compiledAt: string | undefined;
  /** When a run last passed on the block's lines, under `compile --verify`. */
  readonly verifiedAt: string | undefined;
}

/** The `agent.act()` options a compiled block can drop without changing what the step does. */
const KEPT_OPTIONS: ReadonlySet<string> = new Set(['params', 'maxSteps', 'maxModelCalls']);

/** The tag a `@compiled` comment opens with, and the comment that ends a block. */
const START_TAG = /^\*?\s*(?:\*\s*)?@compiled\b/u;
const END_COMMENT = /^\*?\s*@end compiled\s*$/u;

/** One parsed test file. */
export class SourceFile {
  private readonly program: AstNode;
  private readonly comments: readonly { readonly type: string; readonly value: string; readonly start: number; readonly end: number }[];
  private readonly lineStarts: readonly number[];
  /** Module and callback consts bound to `credentials.user('<name>')`, by local name. */
  private readonly credentialBindings = new Map<string, string>();

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    const parsed = oxcParser().parseSync(file, text);
    if (parsed.errors.length > 0) throw new Error(`${file} does not parse: ${parsed.errors[0]?.message ?? 'unknown error'}`);
    const program: unknown = parsed.program;
    if (!isNode(program)) throw new Error(`${file} parsed to no program`);
    this.program = program;
    this.comments = parsed.comments;
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
    this.lineStarts = starts;
    walk(program, (node) => {
      if (node.type !== 'VariableDeclarator') return;
      const id = node['id'] as AstNode;
      const init = node['init'] as AstNode | null;
      const credential = init === null ? undefined : credentialOf(init);
      if (id.type === 'Identifier' && credential !== undefined) this.credentialBindings.set(id['name'] as string, credential);
    });
  }

  /** The line ending the file uses. */
  get eol(): string {
    return this.text.includes('\r\n') ? '\r\n' : '\n';
  }

  /** One-based line of an offset. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  /**
   * The test declared at a line: the call on that line whose last argument
   * is a function. Undefined when no call there takes a callback.
   */
  testAt(line: number): TestSource | undefined {
    let call: AstNode | undefined;
    walk(this.program, (node) => {
      if (call === undefined && isTestCall(node) && this.lineOf(node.start) === line) call = node;
    });
    return call === undefined ? undefined : this.testOf(call);
  }

  /** The innermost test callback whose body holds an offset. */
  testContaining(offset: number): TestSource | undefined {
    let best: AstNode | undefined;
    walk(this.program, (node) => {
      if (!isTestCall(node)) return;
      const body = callbackOf(node)['body'] as AstNode;
      if (body.start <= offset && offset < body.end && (best === undefined || body.start >= (callbackOf(best)['body'] as AstNode).start)) best = node;
    });
    return best === undefined ? undefined : this.testOf(best);
  }

  /**
   * The compiled blocks in the file, in order. A `@compiled` comment with no
   * end comment before the next one, an end comment with no start, or a
   * `@from` that is not a JSON string is an error: a revert must never guess
   * where a block ends.
   */
  compiledBlocks(): CompiledBlock[] {
    const blocks: CompiledBlock[] = [];
    let open: { readonly start: number; readonly tags: ReadonlyMap<string, string> } | undefined;
    for (const comment of this.comments) {
      if (comment.type !== 'Block') continue;
      if (START_TAG.test(comment.value)) {
        if (open !== undefined) throw new Error(`${this.file}:${String(this.lineOf(open.start))}: a @compiled block has no /** @end compiled */ before the next one`);
        open = { start: comment.start, tags: jsdocTags(comment.value) };
        continue;
      }
      if (!END_COMMENT.test(comment.value.trim())) continue;
      if (open === undefined) throw new Error(`${this.file}:${String(this.lineOf(comment.start))}: /** @end compiled */ with no @compiled block before it`);
      const fromJson = open.tags.get('from');
      let from: unknown;
      try {
        from = fromJson === undefined ? undefined : JSON.parse(fromJson);
      } catch {
        from = undefined;
      }
      if (typeof from !== 'string') throw new Error(`${this.file}:${String(this.lineOf(open.start))}: the @compiled block's @from is not a JSON string`);
      blocks.push({
        start: open.start,
        end: comment.end,
        line: this.lineOf(open.start),
        from,
        recording: open.tags.get('recording'),
        step: open.tags.get('step'),
        recordedAt: open.tags.get('recordedAt'),
        compiledAt: open.tags.get('compiledAt'),
        verifiedAt: open.tags.get('verifiedAt'),
      });
      open = undefined;
    }
    if (open !== undefined) throw new Error(`${this.file}:${String(this.lineOf(open.start))}: a @compiled block has no /** @end compiled */`);
    return blocks;
  }

  /** The value imports of the file: each local name and the module it comes from. */
  importedNames(): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const statement of this.program['body'] as readonly AstNode[]) {
      if (statement.type !== 'ImportDeclaration' || statement['importKind'] === 'type') continue;
      const from = (statement['source'] as AstNode)['value'] as string;
      for (const specifier of statement['specifiers'] as readonly AstNode[]) {
        if (specifier['importKind'] === 'type') continue;
        names.set((specifier['local'] as AstNode)['name'] as string, from);
      }
    }
    return names;
  }

  /** The names the module itself declares at its top level, imports aside. */
  moduleNames(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const statement of this.program['body'] as readonly AstNode[]) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? (statement['declaration'] as AstNode | null) : statement;
      if (declaration !== null && declaration.type !== 'ImportDeclaration') declaredNames(declaration, names);
    }
    return names;
  }

  /** The first `import { ... } from 'e2e'` value import: where to add a name. */
  e2eImport(): { readonly insert: number } | undefined {
    for (const statement of this.program['body'] as readonly AstNode[]) {
      if (statement.type !== 'ImportDeclaration' || statement['importKind'] === 'type') continue;
      if ((statement['source'] as AstNode)['value'] !== 'e2e') continue;
      const last = (statement['specifiers'] as readonly AstNode[]).findLast((specifier) => specifier.type === 'ImportSpecifier');
      if (last !== undefined) return { insert: last.end };
    }
    return undefined;
  }

  /** The offset after the last import declaration, where a new import goes. */
  afterImports(): number {
    let end = 0;
    for (const statement of this.program['body'] as readonly AstNode[]) if (statement.type === 'ImportDeclaration') end = statement.end;
    return end;
  }

  /** A test call's callback, its fixtures, and its `agent.act()` calls. */
  private testOf(call: AstNode): TestSource {
    const callback = callbackOf(call);
    const fixtures = new Map<string, string>();
    let fixtureRest = false;
    let fixtureInsert: number | undefined;
    const param = (callback['params'] as readonly AstNode[])[0];
    if (param?.type === 'ObjectPattern') {
      const properties = param['properties'] as readonly AstNode[];
      for (const property of properties) {
        if (property.type === 'RestElement') fixtureRest = true;
        if (property.type !== 'Property') continue;
        const key = property['key'] as AstNode;
        const value = property['value'] as AstNode;
        if (key.type === 'Identifier' && value.type === 'Identifier') fixtures.set(key['name'] as string, value['name'] as string);
      }
      fixtureInsert = properties.at(-1)?.end;
    }
    const agent = fixtures.get('agent');
    const body = callback['body'] as AstNode;
    const statements = body.type === 'BlockStatement' ? (body['body'] as readonly AstNode[]) : [];
    const sites: ActSite[] = [];
    if (agent !== undefined) {
      walk(body, (node, ancestors) => {
        if (node.type === 'CallExpression' && isMemberCall(node, agent, 'act')) sites.push(this.site(node, ancestors, statements));
      });
    }
    const bodyNames = new Set<string>();
    for (const parameter of callback['params'] as readonly AstNode[]) patternNames(parameter, bodyNames);
    walk(body, (node) => {
      if (node.type === 'VariableDeclarator') patternNames(node['id'] as AstNode, bodyNames);
      else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && isNode(node['id'])) patternNames(node['id'], bodyNames);
      else if (isFunction(node)) for (const parameter of node['params'] as readonly AstNode[]) patternNames(parameter, bodyNames);
      else if (node.type === 'CatchClause' && isNode(node['param'])) patternNames(node['param'], bodyNames);
    });
    return { sites, fixtures, fixtureRest, fixtureInsert, bodyStart: body.start, bodyEnd: body.end, bodyNames };
  }

  /** One `agent.act()` call, read. */
  private site(call: AstNode, ancestors: readonly AstNode[], statements: readonly AstNode[]): ActSite {
    const [first, options] = call['arguments'] as readonly AstNode[];
    const instruction = first === undefined ? undefined : literalString(first);
    const uniques = new Map<string, string>();
    const droppedOptions: string[] = [];
    let params: StaticValue | null | undefined = null;
    if (options !== undefined) {
      const properties = options.type === 'ObjectExpression' ? (options['properties'] as readonly AstNode[]) : [];
      if (options.type !== 'ObjectExpression' || properties.some((property) => property.type !== 'Property' || property['computed'] === true)) {
        params = undefined;
        droppedOptions.push('options the source does not spell out');
      } else {
        for (const property of properties) {
          const name = propertyName(property['key'] as AstNode) ?? '?';
          if (!KEPT_OPTIONS.has(name)) droppedOptions.push(name);
        }
        const node = propertyValue(options, 'params');
        params = node === undefined ? null : this.staticValue(node, '', uniques);
      }
    }
    const awaited = ancestors.at(-1);
    const statement = ancestors.at(-2);
    const direct = awaited?.type === 'AwaitExpression' && statement?.type === 'ExpressionStatement' && statements.includes(statement);
    const replaced = direct ? statement : call;
    const lineStart = this.text.lastIndexOf('\n', replaced.start - 1) + 1;
    return {
      instruction,
      digest: instruction === undefined ? undefined : instructionDigest(instruction),
      params,
      uniques,
      droppedOptions,
      nested: direct ? undefined : 'the call is not a bare `await agent.act(...)` statement of the test body',
      start: replaced.start,
      end: replaced.end,
      line: this.lineOf(call.start),
      indent: /^[ \t]*/u.exec(this.text.slice(lineStart))?.[0] ?? '',
      source: this.text.slice(replaced.start, replaced.end),
    };
  }

  /** A params value as the source spells it, recording each `unique()` argument by pointer; undefined when it is not static. */
  private staticValue(node: AstNode, pointer: string, uniques: Map<string, string>): StaticValue | undefined {
    const literal = literalValue(node);
    if (literal !== undefined) return { type: 'json', value: literal };
    if (node.type === 'ArrayExpression') {
      const items: StaticValue[] = [];
      for (const [index, item] of (node['elements'] as readonly (AstNode | null)[]).entries()) {
        const value = item === null || item.type === 'SpreadElement' ? undefined : this.staticValue(item, paramPointer(pointer, index), uniques);
        if (value === undefined) return undefined;
        items.push(value);
      }
      return { type: 'array', items };
    }
    if (node.type === 'ObjectExpression') {
      const entries: (readonly [string, StaticValue])[] = [];
      for (const property of node['properties'] as readonly AstNode[]) {
        if (property.type !== 'Property' || property['computed'] === true || property['kind'] !== 'init') return undefined;
        const key = propertyName(property['key'] as AstNode);
        if (key === undefined) return undefined;
        const value = this.staticValue(property['value'] as AstNode, paramPointer(pointer, key), uniques);
        if (value === undefined) return undefined;
        entries.push([key, value]);
      }
      return { type: 'object', entries };
    }
    if (node.type === 'CallExpression' && isIdentifier(node['callee'] as AstNode, 'unique')) {
      const arg = (node['arguments'] as readonly AstNode[])[0];
      if (arg === undefined) return undefined;
      uniques.set(pointer, this.text.slice(arg.start, arg.end));
      return { type: 'unique' };
    }
    if (node.type === 'CallExpression' && isMemberCall(node, 'secrets', 'get')) {
      const name = literalOf((node['arguments'] as readonly AstNode[])[0]);
      return name === undefined ? undefined : { type: 'secret', name };
    }
    if (node.type === 'MemberExpression' && node['computed'] !== true) {
      const field = (node['property'] as AstNode)['name'];
      const owner = node['object'] as AstNode;
      const credential = credentialOf(owner) ?? (owner.type === 'Identifier' ? this.credentialBindings.get(owner['name'] as string) : undefined);
      if (credential === undefined) return undefined;
      if (field === 'username') return { type: 'username', credential };
      if (field === 'password') return { type: 'secret', name: `${credential}.password` };
    }
    return undefined;
  }
}

/** Adds the names a declaration binds (a variable, function, or class declaration). */
function declaredNames(declaration: AstNode, into: Set<string>): void {
  if (declaration.type === 'VariableDeclaration') for (const declarator of declaration['declarations'] as readonly AstNode[]) patternNames(declarator['id'] as AstNode, into);
  else if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && isNode(declaration['id'])) patternNames(declaration['id'], into);
}

/** Adds every identifier a binding pattern binds. */
function patternNames(pattern: AstNode, into: Set<string>): void {
  switch (pattern.type) {
    case 'Identifier':
      into.add(pattern['name'] as string);
      return;
    case 'ObjectPattern':
      for (const property of pattern['properties'] as readonly AstNode[]) patternNames(property.type === 'RestElement' ? property : (property['value'] as AstNode), into);
      return;
    case 'ArrayPattern':
      for (const element of pattern['elements'] as readonly (AstNode | null)[]) if (element !== null) patternNames(element, into);
      return;
    case 'RestElement':
      patternNames(pattern['argument'] as AstNode, into);
      return;
    case 'AssignmentPattern':
      patternNames(pattern['left'] as AstNode, into);
      return;
    default:
      return;
  }
}

/** The `@tag value` pairs of a JSDoc comment's text, each value the rest of its line. */
function jsdocTags(value: string): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  for (const raw of value.split(/\r?\n/u)) {
    const match = /^\s*\*?\s*@(\w+)\s?(.*?)\s*$/u.exec(raw);
    if (match !== null) tags.set(match[1]!, match[2]!);
  }
  return tags;
}

/** Visits every node under `root`, depth first, with its ancestors (nearest last). */
function walk(root: AstNode, visit: (node: AstNode, ancestors: readonly AstNode[]) => void): void {
  const ancestors: AstNode[] = [];
  const step = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) step(item);
      return;
    }
    if (!isNode(value)) return;
    visit(value, ancestors);
    ancestors.push(value);
    for (const [key, child] of Object.entries(value)) if (key !== 'parent') step(child);
    ancestors.pop();
  };
  step(root);
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function isFunction(node: AstNode): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** Whether a node is a call whose last argument is a function: how a test is declared. */
function isTestCall(node: AstNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const last = (node['arguments'] as readonly AstNode[]).at(-1);
  return last !== undefined && isFunction(last);
}

/** The callback of a call `isTestCall` accepted. */
function callbackOf(call: AstNode): AstNode {
  return (call['arguments'] as readonly AstNode[]).at(-1)!;
}

function isIdentifier(node: AstNode, name: string): boolean {
  return node.type === 'Identifier' && node['name'] === name;
}

/** Whether a call is `<object>.<method>(...)` on a plain identifier. */
function isMemberCall(call: AstNode, object: string, method: string): boolean {
  const callee = call['callee'] as AstNode;
  if (callee.type !== 'MemberExpression' || callee['computed'] === true) return false;
  return isIdentifier(callee['object'] as AstNode, object) && isIdentifier(callee['property'] as AstNode, method);
}

/** The credential name of `credentials.user('<name>')`, or undefined. */
function credentialOf(node: AstNode): string | undefined {
  if (node.type !== 'CallExpression' || !isMemberCall(node, 'credentials', 'user')) return undefined;
  return literalOf((node['arguments'] as readonly AstNode[])[0]);
}

function literalOf(node: AstNode | undefined): string | undefined {
  return node === undefined ? undefined : literalString(node);
}

/** A string literal's value, a template's without substitutions, or `+` of them; undefined for anything else. */
function literalString(node: AstNode): string | undefined {
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'ParenthesizedExpression') return literalString(node['expression'] as AstNode);
  if (node.type === 'BinaryExpression' && node['operator'] === '+') {
    const left = literalString(node['left'] as AstNode);
    const right = left === undefined ? undefined : literalString(node['right'] as AstNode);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === 'TemplateLiteral' && (node['expressions'] as readonly unknown[]).length === 0) {
    const quasi = (node['quasis'] as readonly AstNode[])[0];
    const cooked = (quasi?.['value'] as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/** A JSON literal's value (a string, a finite number, a negated one, a boolean, or null); undefined for anything else. */
function literalValue(node: AstNode): string | number | boolean | null | undefined {
  const text = literalString(node);
  if (text !== undefined) return text;
  if (node.type === 'Literal') {
    const value = node['value'];
    if (value === null && node['regex'] === undefined && node['bigint'] === undefined) return null;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  }
  if (node.type === 'UnaryExpression' && node['operator'] === '-') {
    const inner = literalValue(node['argument'] as AstNode);
    if (typeof inner === 'number') return -inner;
  }
  return undefined;
}

/** An object property's name, when it is an identifier or a string literal. */
function propertyName(key: AstNode): string | undefined {
  if (key.type === 'Identifier') return key['name'] as string;
  return literalString(key);
}

/** The value of a named property of an object expression. */
function propertyValue(object: AstNode, name: string): AstNode | undefined {
  for (const property of object['properties'] as readonly AstNode[]) {
    if (property.type === 'Property' && propertyName(property['key'] as AstNode) === name) return property['value'] as AstNode;
  }
  return undefined;
}
