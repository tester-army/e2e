/**
 * The grammar `run_code` accepts: test statements as they appear in a test
 * body, parsed by oxc and walked into data the runner reads. Nothing here, or
 * anywhere after it, evaluates the text as code. A statement is an optional
 * `await`, then a call chain on `screen` or `app` that ends in an action or a
 * read, or `expect(<locator>)` with an optional `.not` and a matcher.
 * Arguments are literals (strings, numbers, booleans, `null`, regular
 * expressions, templates without `${}`), arrays and objects of them, locators
 * on `screen`, `credentials.user(name).username` as a string, and a Secret
 * (`credentials.user(name).password`, `secrets.get(name)`) as `fill`'s value.
 * Every node is checked against the closed table in `code-surface.ts` as it is
 * walked; any other node is `INVALID_ARGUMENT` naming it and where it starts.
 */

import type { Argument, CallExpression, Directive, Expression, MemberExpression, Node, ObjectExpression, PropertyKey, Span, Statement as SourceStatement } from 'oxc-parser';
import { oxcParser } from '../config/typescript.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { suggest } from '../internal/suggest.ts';
import { LEFT_OUT, RECEIVER_LABELS, SURFACE, type Arity, type Member, type Receiver } from './code-surface.ts';

/**
 * The longest code one call takes, in characters. With `MAX_BRACKETS` it
 * bounds how deep oxc's parser recurses on the server's own stack, where an
 * overflow kills the process: the deepest code both let through, brackets and
 * then arrow functions, parses on half of Node's 8 MB main-thread stack.
 */
const MAX_CODE_LENGTH = 10_000;
/**
 * The most brackets one call may open. About 5,330 nested brackets alone
 * overflow the stack (oxc 0.155 on Node 22 and 24, macOS arm64). Brackets
 * inside strings count too, so a text with more than this many is refused.
 */
const MAX_BRACKETS = 1_000;
/** The most statements one call runs. */
const MAX_STATEMENTS = 50;
/** How deep arrays, objects, and locator arguments may nest. */
const MAX_DEPTH = 16;

/** A fixture a statement starts from. */
export type Root = 'screen' | 'app';

/** One argument, as data. */
export type Value =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'regex'; readonly source: string; readonly flags: string }
  | { readonly kind: 'array'; readonly items: readonly Value[] }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, Value])[] }
  | { readonly kind: 'locator'; readonly chain: Chain }
  | { readonly kind: 'username'; readonly credential: string }
  | { readonly kind: 'secret'; readonly from: 'credential' | 'secrets'; readonly name: string };

/** One member called along a chain. */
export interface Call {
  readonly name: string;
  readonly args: readonly Value[];
}

/** A fixture and the members called on it, in order. */
export interface Chain {
  readonly root: Root;
  readonly calls: readonly Call[];
}

/** What a statement runs. */
export type StatementBody =
  /** A chain whose last call is an action, or a read whose value the result shows. */
  | { readonly kind: 'call'; readonly chain: Chain; readonly read: boolean }
  /** `expect(locator)`, maybe `.not`, and one matcher. */
  | { readonly kind: 'expect'; readonly locator: Chain; readonly negated: boolean; readonly matcher: Call };

export interface Statement {
  /** The statement as written. */
  readonly source: string;
  readonly body: StatementBody;
}

export interface ParseOptions {
  /** The fixtures the target's engine contributes, so a statement on one is told why it is refused. */
  readonly fixtures: readonly string[];
}

/** Parses `code` into statements, or throws `INVALID_ARGUMENT` at the first node outside the grammar. */
export function parseCode(code: string, options: ParseOptions): readonly Statement[] {
  if (code.length > MAX_CODE_LENGTH) {
    throw invalid(`the code is ${String(code.length)} characters; pass at most ${String(MAX_CODE_LENGTH)} at once`);
  }
  const brackets = code.match(/[([{]/g)?.length ?? 0;
  if (brackets > MAX_BRACKETS) {
    throw invalid(`the code opens ${String(brackets)} brackets; pass at most ${String(MAX_BRACKETS)} at once`);
  }
  const { program, errors } = oxcParser().parseSync('run_code.js', code, { lang: 'js', sourceType: 'module' });
  const error = errors.find((candidate) => candidate.severity === 'Error');
  if (error !== undefined) {
    throw invalid(`the code does not parse at ${position(code, error.labels[0]?.start ?? 0)}: ${error.message}`);
  }
  return new Walker(code, options).program(program.body);
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_ARGUMENT', `run_code: ${message}`);
}

/** `line:column` of an offset into `code`, both counted from 1. */
function position(code: string, offset: number): string {
  const lines = code.slice(0, offset).split('\n');
  return `${String(lines.length)}:${String(lines.at(-1)!.length + 1)}`;
}

/** One member along a chain, and the call on it: `.name(...)`, `.name`, or a call of what came before, `(...)`. */
type Link =
  | { readonly member: MemberExpression; readonly call: CallExpression | undefined }
  | { readonly member: undefined; readonly call: CallExpression };

/**
 * A chain as its root and the links along it, root first: `screen.a(x).b` is
 * `screen`, then `a(x)`, then `b`. The root is what no member or call is taken
 * on: an identifier, a call of one (`expect(...)`), or any other node.
 */
function flatten(expression: Expression): { readonly root: Expression; readonly links: readonly Link[] } {
  const links: Link[] = [];
  let node = expression;
  for (;;) {
    if (node.type === 'MemberExpression') {
      links.push({ member: node, call: undefined });
      node = node.object;
    } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      links.push({ member: node.callee, call: node });
      node = node.callee.object;
    } else if (node.type === 'CallExpression' && node.callee.type === 'CallExpression') {
      links.push({ member: undefined, call: node });
      node = node.callee;
    } else {
      return { root: node, links: links.toReversed() };
    }
  }
}

/** What a chain came to: a receiver it can go on from, or a call that ended it. */
type ChainEnd = { readonly kind: 'receiver'; readonly receiver: Receiver } | { readonly kind: 'ended'; readonly member: Member };

/** A member's name and where it is written. */
type Name = Span & { readonly name: string };

class Walker {
  constructor(
    private readonly code: string,
    private readonly options: ParseOptions,
  ) {}

  program(body: readonly (Directive | SourceStatement)[]): Statement[] {
    const statements: Statement[] = [];
    for (const node of body) {
      if (node.type === 'EmptyStatement') continue;
      if (statements.length === MAX_STATEMENTS) {
        throw invalid(`pass at most ${String(MAX_STATEMENTS)} statements at once`);
      }
      if (node.type !== 'ExpressionStatement') throw this.outside(node, `a statement starts with ${STARTS}`);
      statements.push({ source: this.code.slice(node.start, node.end), body: this.statement(node.expression) });
    }
    if (statements.length === 0) {
      throw invalid("no statement to run; pass test lines such as await screen.getByRole('button', 'Save').tap();");
    }
    return statements;
  }

  private statement(expression: Expression): StatementBody {
    const { root, links } = flatten(expression.type === 'AwaitExpression' ? expression.argument : expression);
    if (root.type === 'CallExpression' && root.callee.type === 'Identifier' && root.callee.name === 'expect') {
      return this.expectStatement(root, links);
    }
    if (root.type === 'Identifier' && root.name === 'expect') {
      const first = links[0];
      const name = first === undefined ? 'expect' : `expect.${this.name(first).name}`;
      throw invalid(`${name} at ${this.where(root)} is not in the grammar; run_code runs expect(...) itself, not expect.soft or expect.poll`);
    }
    if (root.type !== 'Identifier' || (root.name !== 'screen' && root.name !== 'app')) {
      throw this.outside(root.type === 'CallExpression' ? root.callee : root, `a statement starts with ${STARTS}`);
    }
    const { calls, end } = this.calls(root.name, links, 0);
    if (end.kind === 'receiver') {
      const ending = end.receiver === 'locator' ? 'ends on a locator' : `ends on ${RECEIVER_LABELS[end.receiver]}`;
      throw invalid(`the statement at ${this.where(root)} ${ending}; end it with an action or a read, or wrap the locator in expect(...)`);
    }
    return { kind: 'call', chain: { root: root.name, calls }, read: end.member.kind === 'read' };
  }

  /** `expect(locator)`, an optional `.not`, and one matcher. */
  private expectStatement(call: CallExpression, links: readonly Link[]): StatementBody {
    const [subject, extra] = call.arguments;
    if (subject === undefined || extra !== undefined) {
      throw invalid(`expect at ${this.where(call)} takes one locator, got ${String(call.arguments.length)}`);
    }
    if (subject.type === 'Identifier' && subject.name === 'screen') {
      throw invalid(`expect(screen) at ${this.where(subject)} only compares screenshots, which run in a test; look with the screenshot tool`);
    }
    const chain = subject.type === 'SpreadElement' ? undefined : flatten(subject);
    if (chain?.root.type === 'Identifier' && this.options.fixtures.includes(chain.root.name)) throw this.engineFixture(chain.root, `a statement starts with ${STARTS}`);
    if (chain?.root.type !== 'Identifier' || chain.root.name !== 'screen') {
      throw invalid(`expect takes a locator on screen, found ${this.describe(subject)} at ${this.where(subject)}`);
    }
    const locator = this.locatorChain(chain.root, chain.links, 0);
    const [first] = links;
    const negated = first !== undefined && first.call === undefined && this.name(first).name === 'not';
    const [matcher, after] = negated ? links.slice(1) : links;
    if (matcher === undefined) throw invalid(`expect(...) at ${this.where(call)} needs a matcher, such as .toBeVisible()`);
    const name = this.name(matcher);
    if (negated && name.name === 'not') throw invalid(`"not" at ${this.where(name)}: a matcher is negated once`);
    const member = this.member('locator-expectation', name);
    const args = this.call(matcher, name, member.args, 'locator-expectation', undefined, 0);
    if (after !== undefined) throw invalid(`nothing may follow the matcher; the chain goes on at ${this.where(matcher.call?.end ?? name.end)}`);
    return { kind: 'expect', locator, negated, matcher: { name: name.name, args } };
  }

  /** The refusal of a fixture the target's engine contributes: core names none of its members. */
  private engineFixture(node: Name, hint: string): ConfigurationError {
    return invalid(`"${node.name}" at ${this.where(node)} is a fixture of this target's engine, which run_code does not run; ${hint}`);
  }

  /** The refusal of a node outside the grammar: an engine fixture as one, anything else as written. */
  private outside(node: Node, hint: string): ConfigurationError {
    if (node.type === 'Identifier' && this.options.fixtures.includes(node.name)) return this.engineFixture(node, hint);
    return invalid(`${this.describe(node)} at ${this.where(node)} is not in the grammar; ${hint}`);
  }

  /** The members called along a chain, each checked against the receiver it is called on. */
  private calls(root: Receiver, links: readonly Link[], depth: number): { calls: Call[]; end: ChainEnd } {
    const calls: Call[] = [];
    let receiver = root;
    for (const [index, link] of links.entries()) {
      const name = this.name(link);
      const member = this.member(receiver, name);
      const secretValue = member.kind === 'action' && member.secretValue === true ? 0 : undefined;
      calls.push({ name: name.name, args: this.call(link, name, member.args, receiver, secretValue, depth) });
      if (member.kind === 'query') {
        receiver = 'locator';
        continue;
      }
      if (index < links.length - 1) {
        throw invalid(`nothing may follow ${name.name}(...); the chain goes on at ${this.where(link.call?.end ?? name.end)}`);
      }
      return { calls, end: { kind: 'ended', member } };
    }
    return { calls, end: { kind: 'receiver', receiver } };
  }

  /** A locator: `screen` and at least one query, with nothing called on its match. */
  private locatorChain(root: Span, links: readonly Link[], depth: number): Chain {
    const { calls, end } = this.calls('screen', links, depth);
    if (end.kind === 'ended') {
      throw invalid(`the locator at ${this.where(root)} ends in a call; pass the locator itself, such as screen.getByText('Done')`);
    }
    if (end.receiver !== 'locator') {
      throw invalid(`the argument at ${this.where(root)} is screen itself; pass a locator, such as screen.getByText('Done')`);
    }
    return { root: 'screen', calls };
  }

  /** The name a link calls a member by: never computed, private, or a call of what came before. */
  private name(link: Link): Name {
    if (link.member === undefined) {
      throw invalid(`the call at ${this.where(link.call.callee.end)} calls what came before it; call a member by name, such as screen.getByText('Done')`);
    }
    const { computed, property } = link.member;
    if (computed || property.type !== 'Identifier') {
      throw invalid(`${this.describe(property)} at ${this.where(property)} is not a member name; call a member by name, such as screen.getByText('Done')`);
    }
    return property;
  }

  /** The member `name` names on `receiver`, or a refusal that says what it may name instead. */
  private member(receiver: Receiver, name: Name): Member {
    const members = SURFACE[receiver];
    const member = members.get(name.name);
    if (member !== undefined) return member;
    const label = RECEIVER_LABELS[receiver];
    const leftOut = LEFT_OUT.get(name.name);
    if (leftOut !== undefined) throw invalid(`"${name.name}" at ${this.where(name)} is left out of run_code: it ${leftOut}`);
    if (receiver !== 'locator-expectation' && SURFACE['locator-expectation'].has(name.name)) {
      throw invalid(`"${name.name}" at ${this.where(name)} is a matcher; call it on expect(...)`);
    }
    const names = [...members.keys()];
    const near = suggest(name.name, names);
    const hint = near === undefined ? `; ${label} takes ${names.join(', ')}` : `; did you mean "${near}"?`;
    throw invalid(`"${name.name}" at ${this.where(name)} is not something run_code runs on ${label}${hint}`);
  }

  /** A link's arguments, counted against what the member takes; a Secret only at `secretValue`. */
  private call(link: Link, name: Name, arity: Arity, receiver: Receiver, secretValue: number | undefined, depth: number): Value[] {
    if (link.call === undefined) throw invalid(`${name.name} at ${this.where(name)} is not called; write ${name.name}(...)`);
    const args = link.call.arguments.map((argument, index) => this.value(argument, depth + 1, secretValue === index));
    const [min, max] = arity;
    if (args.length < min || args.length > max) {
      const takes = min === max ? `${String(min)} argument${min === 1 ? '' : 's'}` : `${String(min)} to ${String(max)} arguments`;
      throw invalid(`${name.name} at ${this.where(name)} on ${RECEIVER_LABELS[receiver]} takes ${takes}, got ${String(args.length)}`);
    }
    return args;
  }

  /** One argument; a Secret only where `secretAllowed` says so. */
  private value(node: Argument, depth: number, secretAllowed: boolean): Value {
    if (depth > MAX_DEPTH) throw invalid(`the argument at ${this.where(node)} nests deeper than ${String(MAX_DEPTH)} levels`);
    switch (node.type) {
      case 'Literal':
        if ('regex' in node) {
          let pattern: RegExp;
          try {
            pattern = new RegExp(node.regex.pattern, node.regex.flags);
          } catch (cause) {
            throw invalid(`the regular expression at ${this.where(node)} is invalid: ${(cause as Error).message}`);
          }
          return { kind: 'regex', source: pattern.source, flags: pattern.flags };
        }
        if ('bigint' in node) break;
        return { kind: 'literal', value: node.value };
      case 'TemplateLiteral': {
        const [quasi] = node.quasis;
        if (quasi === undefined) break;
        if (node.expressions.length > 0) {
          throw invalid(`the template at ${this.where(node)} has a \${...} expression at ${this.where(quasi.end)}; run_code runs no expressions, so write the text out`);
        }
        // Only a tagged template can hold an escape that cooks to nothing.
        if (quasi.value.cooked === null) break;
        return { kind: 'literal', value: quasi.value.cooked };
      }
      case 'UnaryExpression':
        if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
          return { kind: 'literal', value: -node.argument.value };
        }
        break;
      case 'ArrayExpression':
        return {
          kind: 'array',
          items: node.elements.map((item) => {
            if (item === null) throw invalid(`the array at ${this.where(node)} skips an item; write every item`);
            return this.value(item, depth + 1, false);
          }),
        };
      case 'ObjectExpression':
        return this.object(node, depth);
      case 'Identifier':
      case 'MemberExpression':
      case 'CallExpression':
        return this.reference(node, depth, secretAllowed);
      default:
        break;
    }
    throw this.outside(node, ARGUMENTS);
  }

  /** A name in argument position: a locator, or a credential or secret reference. */
  private reference(node: Expression, depth: number, secretAllowed: boolean): Value {
    const { root, links } = flatten(node);
    if (root.type !== 'Identifier') throw this.outside(root.type === 'CallExpression' ? root.callee : root, ARGUMENTS);
    switch (root.name) {
      case 'screen':
        return { kind: 'locator', chain: this.locatorChain(root, links, depth) };
      case 'credentials': {
        const [user, field, extra] = links;
        if (user?.call === undefined || this.name(user).name !== 'user' || field === undefined || field.call !== undefined || extra !== undefined) {
          throw invalid(`the credential at ${this.where(root)} is not in the grammar; write credentials.user('name').username or .password`);
        }
        const name = this.nameArgument(user.call, 'credentials.user');
        const property = this.name(field);
        if (property.name === 'username') return { kind: 'username', credential: name };
        if (property.name !== 'password') throw invalid(`"${property.name}" at ${this.where(property)}: a credential has username and password`);
        if (!secretAllowed) throw this.misplacedSecret(root);
        return { kind: 'secret', from: 'credential', name };
      }
      case 'secrets': {
        const [get, extra] = links;
        if (get?.call === undefined || this.name(get).name !== 'get' || extra !== undefined) {
          throw invalid(`the secret at ${this.where(root)} is not in the grammar; write secrets.get('name')`);
        }
        const name = this.nameArgument(get.call, 'secrets.get');
        if (!secretAllowed) throw this.misplacedSecret(root);
        return { kind: 'secret', from: 'secrets', name };
      }
      default:
        throw this.outside(root, ARGUMENTS);
    }
  }

  /** The one string argument of `credentials.user(...)` or `secrets.get(...)`. */
  private nameArgument(call: CallExpression, api: string): string {
    const [argument, extra] = call.arguments;
    if (argument?.type === 'Literal' && typeof argument.value === 'string' && argument.value !== '' && extra === undefined) return argument.value;
    const found = argument === undefined ? `nothing at ${this.where(call.end)}` : `${this.describe(argument)} at ${this.where(argument)}`;
    throw invalid(`${api} takes the name as a string, found ${found}`);
  }

  private object(node: ObjectExpression, depth: number): Value {
    const entries: (readonly [string, Value])[] = [];
    for (const property of node.properties) {
      const plain = property.type === 'Property' && property.kind === 'init' && !property.method && !property.shorthand && !property.computed;
      const key = plain ? keyName(property.key) : undefined;
      if (!plain || key === undefined) {
        throw invalid(`the property ${this.describe(property)} at ${this.where(property)} is not in the grammar; write each property as name: value`);
      }
      if (key === '__proto__') throw invalid(`the property name "__proto__" at ${this.where(property.key)} is not allowed`);
      if (entries.some(([seen]) => seen === key)) throw invalid(`the property "${key}" at ${this.where(property.key)} is named twice`);
      entries.push([key, this.value(property.value, depth + 1, false)]);
    }
    return { kind: 'object', entries };
  }

  private misplacedSecret(node: Span): ConfigurationError {
    return invalid(`the secret at ${this.where(node)} is accepted only as fill's value, such as screen.getByLabel('Password').fill(credentials.user('admin').password)`);
  }

  /** Where a node, or an offset, is in the code. */
  private where(at: Span | number): string {
    return position(this.code, typeof at === 'number' ? at : at.start);
  }

  /** A node as written, as a message quotes it, bounded. */
  private describe(node: Span): string {
    const text = this.code.slice(node.start, node.end);
    return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
  }
}

/** A property's name, written plain or quoted; any other key is outside the grammar. */
function keyName(key: PropertyKey): string | undefined {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

const STARTS = 'screen, app, or expect(...)';

const ARGUMENTS =
  "an argument is a string, number, boolean, null, regular expression, array, or object, a locator on screen, credentials.user('name').username, or a secret as fill's value";
