/**
 * The grammar `run_code` accepts: test statements as they appear in a test
 * body, read by a tokenizer and a recursive-descent parser into data the
 * runner walks. Nothing here, or anywhere after it, evaluates the text as
 * code. A statement is an optional `await`, then a call chain on `screen` or
 * `app` that ends in an action or a read, or `expect(<locator>)` with an
 * optional `.not` and a matcher. Arguments are literals (strings, numbers,
 * booleans, `null`, regular expressions, templates without `${}`), arrays and
 * objects of them, locators on `screen`, `credentials.user(name).username` as
 * a string, and a Secret (`credentials.user(name).password`,
 * `secrets.get(name)`) as `fill`'s value. Every name is checked against the
 * closed table in `code-surface.ts` as it is read; anything else is
 * `INVALID_ARGUMENT` naming the token and where it is.
 */

import { ConfigurationError } from '../internal/errors.ts';
import { suggest } from '../internal/suggest.ts';
import { LEFT_OUT, RECEIVER_LABELS, SURFACE, type Arity, type Member, type Receiver } from './code-surface.ts';

/** The longest code one call takes, in characters. */
const MAX_CODE_LENGTH = 20_000;
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
  /** The statement as written, on one line, without its comments. */
  readonly source: string;
  readonly body: StatementBody;
}

export interface ParseOptions {
  /** The fixtures the target's engine contributes, so a statement on one is told why it is refused. */
  readonly fixtures: readonly string[];
}

/** Parses `code` into statements, or throws `INVALID_ARGUMENT` at the first token outside the grammar. */
export function parseCode(code: string, options: ParseOptions): readonly Statement[] {
  if (code.length > MAX_CODE_LENGTH) {
    throw invalid(`the code is ${String(code.length)} characters; pass at most ${String(MAX_CODE_LENGTH)} at once`);
  }
  return new Parser(code, tokenize(code), options).program();
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_ARGUMENT', `run_code: ${message}`);
}

// --- tokens ---

interface Token {
  readonly kind: 'identifier' | 'string' | 'number' | 'regex' | 'punctuator' | 'end';
  /** The token as written. */
  readonly text: string;
  /** A string's or a number's value, a regex's source. */
  readonly value?: string | number;
  readonly flags?: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  /** A line break sits between this token and the one before it. */
  readonly newlineBefore: boolean;
}

const PUNCTUATORS = new Set(['.', '(', ')', '[', ']', '{', '}', ',', ':', ';', '-']);
/** Characters of the operators the grammar has none of, read greedily so `=>` is named whole. */
const OPERATOR = /^[=+*%&|<>!?^~@#]+/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const REGEX_FLAGS = /^[a-z]*/;

/** Splits `code` into tokens, skipping whitespace and comments. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  let newlineBefore = false;
  const at = (offset: number): string => {
    let row = 1;
    let start = 0;
    for (let i = 0; i < offset; i += 1) {
      if (code[i] === '\n') {
        row += 1;
        start = i + 1;
      }
    }
    return `${String(row)}:${String(offset - start + 1)}`;
  };
  const push = (kind: Token['kind'], start: number, end: number, extra: { value?: string | number; flags?: string } = {}): void => {
    tokens.push({ kind, text: code.slice(start, end), ...extra, line, column: start - lineStart + 1, start, end, newlineBefore });
    newlineBefore = false;
  };
  /** Moves past text that may hold line breaks, keeping the line count. */
  const advance = (to: number): void => {
    for (let i = index; i < to; i += 1) {
      if (code[i] === '\n') {
        line += 1;
        lineStart = i + 1;
        newlineBefore = true;
      }
    }
    index = to;
  };
  while (index < code.length) {
    const char = code[index]!;
    const rest = code.slice(index);
    if (/\s/.test(char)) {
      advance(index + 1);
      continue;
    }
    if (rest.startsWith('//')) {
      const end = code.indexOf('\n', index);
      advance(end === -1 ? code.length : end);
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = code.indexOf('*/', index + 2);
      if (end === -1) throw invalid(`the comment at ${at(index)} never ends`);
      advance(end + 2);
      continue;
    }
    const identifier = IDENTIFIER.exec(rest);
    if (identifier !== null) {
      push('identifier', index, index + identifier[0].length);
      index += identifier[0].length;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number !== null) {
      const end = index + number[0].length;
      if (/[\w$.]/.test(code[end] ?? '')) throw invalid(`the number at ${at(index)} is not a plain decimal number`);
      push('number', index, end, { value: Number(number[0]) });
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const { value, end } = readQuoted(code, index, at);
      const start = index;
      const startLine = line;
      const startColumn = start - lineStart + 1;
      const before = newlineBefore;
      advance(end);
      tokens.push({ kind: 'string', text: code.slice(start, end), value, line: startLine, column: startColumn, start, end, newlineBefore: before });
      newlineBefore = false;
      continue;
    }
    if (char === '/') {
      const { source, end } = readRegexBody(code, index, at);
      const flags = REGEX_FLAGS.exec(code.slice(end))![0];
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, flags);
      } catch (cause) {
        throw invalid(`the regular expression at ${at(index)} is invalid: ${(cause as Error).message}`);
      }
      if (repeatsRepetition(source)) {
        throw invalid(`the regular expression at ${at(index)} repeats a group that repeats or alternates inside, which can run for hours on a short text; repeat a single character or class instead`);
      }
      push('regex', index, end + flags.length, { value: pattern.source, flags: pattern.flags });
      index = end + flags.length;
      continue;
    }
    if (PUNCTUATORS.has(char)) {
      push('punctuator', index, index + 1);
      index += 1;
      continue;
    }
    const operator = OPERATOR.exec(rest);
    if (operator !== null) {
      push('punctuator', index, index + operator[0].length);
      index += operator[0].length;
      continue;
    }
    throw invalid(`unexpected character ${JSON.stringify(char)} at ${at(index)}`);
  }
  tokens.push({ kind: 'end', text: '', line, column: index - lineStart + 1, start: index, end: index, newlineBefore });
  return tokens;
}

/** The escapes a quoted string decodes; any other escaped character stands for itself, as in JavaScript. */
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Reads a quoted string or a template without substitutions, from its opening quote. */
function readQuoted(code: string, start: number, at: (offset: number) => string): { value: string; end: number } {
  const quote = code[start]!;
  let value = '';
  let index = start + 1;
  for (;;) {
    const char = code[index];
    if (char === undefined || (char === '\n' && quote !== '`')) {
      throw invalid(`the string at ${at(start)} never ends`);
    }
    if (char === quote) return { value, end: index + 1 };
    if (quote === '`' && char === '$' && code[index + 1] === '{') {
      throw invalid(`the template at ${at(start)} has a \${...} expression at ${at(index)}; run_code runs no expressions, so write the text out`);
    }
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }
    const escaped = code[index + 1];
    if (escaped === undefined) throw invalid(`the string at ${at(start)} never ends`);
    if (escaped === '\n') {
      index += 2;
      continue;
    }
    const hex = escaped === 'x' ? /^[\da-fA-F]{2}/.exec(code.slice(index + 2)) : undefined;
    const unicode = escaped === 'u' ? /^(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\})/.exec(code.slice(index + 2)) : undefined;
    if (hex !== undefined || unicode !== undefined) {
      const digits = (hex ?? unicode)?.[0];
      if (digits === undefined) throw invalid(`the escape at ${at(index)} is malformed`);
      const point = Number.parseInt(digits.replace(/[{}]/g, ''), 16);
      if (point > 0x10ffff) throw invalid(`the escape at ${at(index)} is malformed`);
      value += String.fromCodePoint(point);
      index += 2 + digits.length;
      continue;
    }
    value += ESCAPES[escaped] ?? escaped;
    index += 2;
  }
}

/** Reads a regular expression's body, from its opening slash to its closing one. */
function readRegexBody(code: string, start: number, at: (offset: number) => string): { source: string; end: number } {
  let index = start + 1;
  let inClass = false;
  for (;;) {
    const char = code[index];
    if (char === undefined || char === '\n') throw invalid(`the regular expression at ${at(start)} never ends`);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      if (index === start + 1) throw invalid(`the regular expression at ${at(start)} is empty`);
      return { source: code.slice(start + 1, index), end: index + 1 };
    }
    index += 1;
  }
}

/**
 * Whether a pattern repeats without bound a group that repeats or alternates
 * inside, `(\w+\s?)*` or `(a|ab)+`: the shapes that backtrack exponentially.
 * A matcher tests a `run_code` pattern in the server's own thread, where no
 * timeout can stop it, so such a pattern would hang every session.
 */
function repeatsRepetition(source: string): boolean {
  const groups: { inner: boolean }[] = [];
  /** The group that just closed, until a quantifier on it is read or another token is. */
  let closed: { inner: boolean } | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const quantifier = QUANTIFIER.exec(source.slice(index));
    if (quantifier !== null) {
      const unbounded = quantifier[1] === '*' || quantifier[1] === '+' || quantifier[2] === '';
      if (closed?.inner === true && unbounded) return true;
      const enclosing = groups.at(-1);
      if (enclosing !== undefined) enclosing.inner = true;
      index += quantifier[0].length - 1;
      closed = undefined;
      continue;
    }
    closed = undefined;
    const char = source[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      for (index += 1; index < source.length && source[index] !== ']'; index += 1) {
        if (source[index] === '\\') index += 1;
      }
    } else if (char === '(') {
      groups.push({ inner: false });
      index += GROUP_PREFIX.exec(source.slice(index + 1))?.[0].length ?? 0;
    } else if (char === ')') {
      const group = groups.pop();
      const enclosing = groups.at(-1);
      if (group?.inner === true && enclosing !== undefined) enclosing.inner = true;
      closed = group;
    } else if (char === '|') {
      const enclosing = groups.at(-1);
      if (enclosing !== undefined) enclosing.inner = true;
    }
  }
  return false;
}

/** A quantifier, lazy or not: its kind, and for a brace its upper bound (empty when open). */
const QUANTIFIER = /^(?:([*+?])|\{\d+(?:,(\d*))?\})\??/;
/** What follows `(` in a group that is not a plain capture: `?:`, a lookaround, or a name. */
const GROUP_PREFIX = /^\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>)/;

// --- statements ---

/** What a chain came to: a receiver it can go on from, or a call that ended it. */
type ChainEnd = { readonly kind: 'receiver'; readonly receiver: Receiver } | { readonly kind: 'ended'; readonly member: Member };

class Parser {
  private index = 0;

  constructor(
    private readonly code: string,
    private readonly tokens: readonly Token[],
    private readonly options: ParseOptions,
  ) {}

  program(): Statement[] {
    const statements: Statement[] = [];
    while (this.peek().kind !== 'end') {
      if (this.isPunctuator(';')) {
        this.index += 1;
        continue;
      }
      if (statements.length === MAX_STATEMENTS) {
        throw invalid(`pass at most ${String(MAX_STATEMENTS)} statements at once`);
      }
      statements.push(this.statement());
    }
    if (statements.length === 0) {
      throw invalid("no statement to run; pass test lines such as await screen.getByRole('button', 'Save').tap();");
    }
    return statements;
  }

  private statement(): Statement {
    const first = this.index;
    if (isWord(this.peek(), 'await')) this.index += 1;
    const body = isWord(this.peek(), 'expect') ? this.expectStatement() : this.callStatement();
    this.requireStatementEnd();
    // The semicolon stays with the statement, so a passing line reads as it pastes.
    const last = this.isPunctuator(';') ? this.index : this.index - 1;
    return { source: this.source(first, last), body };
  }

  /** A statement ends at ";", a new line, or the end of the code. */
  private requireStatementEnd(): void {
    const next = this.peek();
    if (next.kind !== 'end' && !next.newlineBefore && !(next.kind === 'punctuator' && next.text === ';')) {
      throw invalid(`expected ";" or a new line after the statement, found ${describe(next)} at ${where(next)}`);
    }
  }

  /**
   * The tokens from `first` through `last` on one line: each as written, a
   * comment or a run of whitespace between two of them one space, and none
   * before a member call that opens a line.
   */
  private source(first: number, last: number): string {
    let text = this.tokens[first]!.text;
    for (let index = first + 1; index <= last; index += 1) {
      const token = this.tokens[index]!;
      const gap = this.code.slice(this.tokens[index - 1]!.end, token.start);
      const joined = gap === '' || (token.newlineBefore && token.text === '.');
      text += `${joined ? '' : ' '}${token.text}`;
    }
    return text;
  }

  /** `screen…` or `app…`, ending in an action or a read. */
  private callStatement(): StatementBody {
    const rootToken = this.peek();
    const root = this.root(rootToken, `a statement starts with ${STARTS}`);
    const { calls, end } = this.calls(root);
    if (end.kind === 'receiver') {
      this.requireStatementEnd();
      const ending = end.receiver === 'locator' ? 'ends on a locator' : `ends on ${RECEIVER_LABELS[end.receiver]}`;
      throw invalid(`the statement at ${where(rootToken)} ${ending}; end it with an action or a read, or wrap the locator in expect(...)`);
    }
    return { kind: 'call', chain: { root, calls }, read: end.member.kind === 'read' };
  }

  /** `expect(locator)`, an optional `.not`, and one matcher. */
  private expectStatement(): StatementBody {
    const expectToken = this.next();
    if (this.isPunctuator('.')) {
      const member = this.tokens[this.index + 1];
      const name = member?.kind === 'identifier' ? `expect.${member.text}` : 'expect';
      throw invalid(`${name} at ${where(expectToken)} is not in the grammar; run_code runs expect(...) itself, not expect.soft or expect.poll`);
    }
    this.punctuator('(', 'after expect');
    const subject = this.peek();
    const closes = this.tokens[this.index + 1]?.kind === 'punctuator' && this.tokens[this.index + 1]?.text === ')';
    if (isWord(subject, 'screen') && closes) {
      throw invalid(`expect(screen) at ${where(subject)} only compares screenshots, which run in a test; look with the screenshot tool`);
    }
    if (subject.kind === 'identifier' && this.options.fixtures.includes(subject.text)) throw this.engineFixture(subject);
    if (!isWord(subject, 'screen')) {
      throw invalid(`expect takes a locator on screen, found ${describe(subject)} at ${where(subject)}`);
    }
    const locator = this.locatorChain(0);
    this.punctuator(')', 'to close expect(');
    let negated = false;
    this.punctuator('.', 'and a matcher after expect(...)');
    if (isWord(this.peek(), 'not')) {
      this.index += 1;
      negated = true;
      this.punctuator('.', 'and a matcher after .not');
    }
    const nameToken = this.identifier('a matcher');
    if (negated && nameToken.text === 'not') throw invalid(`"not" at ${where(nameToken)}: a matcher is negated once`);
    const member = this.member('locator-expectation', nameToken);
    const args = this.call(nameToken, member.args, 'locator-expectation', undefined, 0);
    if (this.isPunctuator('.')) throw invalid(`nothing may follow the matcher; found "." at ${where(this.peek())}`);
    return { kind: 'expect', locator, negated, matcher: { name: nameToken.text, args } };
  }

  /** The statement's fixture: `screen` or `app`. */
  private root(token: Token, hint: string): Root {
    if (isWord(token, 'screen') || isWord(token, 'app')) {
      this.index += 1;
      return token.text as Root;
    }
    if (token.kind === 'identifier' && this.options.fixtures.includes(token.text)) throw this.engineFixture(token);
    if (token.kind === 'identifier') {
      throw invalid(`"${token.text}" at ${where(token)} is not in the grammar; ${hint}`);
    }
    throw invalid(`expected a statement, found ${describe(token)} at ${where(token)}; ${hint}`);
  }

  /** The refusal of a fixture the target's engine contributes: core names none of its members. */
  private engineFixture(token: Token): ConfigurationError {
    return invalid(`"${token.text}" at ${where(token)} is a fixture of this target's engine, which run_code does not run; a statement starts with ${STARTS}`);
  }

  /** The members called along a chain, each checked against the receiver it is called on. */
  private calls(root: Receiver, depth = 0): { calls: Call[]; end: ChainEnd } {
    const calls: Call[] = [];
    let receiver = root;
    while (this.isPunctuator('.')) {
      this.index += 1;
      const nameToken = this.identifier(`a member of ${RECEIVER_LABELS[receiver]}`);
      const member = this.member(receiver, nameToken);
      const secretValue = member.kind === 'action' && member.secretValue === true ? 0 : undefined;
      calls.push({ name: nameToken.text, args: this.call(nameToken, member.args, receiver, secretValue, depth) });
      if (member.kind === 'query') {
        receiver = 'locator';
        continue;
      }
      if (this.isPunctuator('.')) {
        throw invalid(`nothing may follow ${nameToken.text}(...); found "." at ${where(this.peek())}`);
      }
      return { calls, end: { kind: 'ended', member } };
    }
    return { calls, end: { kind: 'receiver', receiver } };
  }

  /** A locator: `screen` and at least one query, with nothing called on its match. */
  private locatorChain(depth: number): Chain {
    const start = this.peek();
    this.word('screen', 'a locator on screen');
    const { calls, end } = this.calls('screen', depth);
    if (end.kind === 'ended') {
      throw invalid(`the locator at ${where(start)} ends in a call; pass the locator itself, such as screen.getByText('Done')`);
    }
    if (end.receiver !== 'locator') {
      throw invalid(`the argument at ${where(start)} is screen itself; pass a locator, such as screen.getByText('Done')`);
    }
    return { root: 'screen', calls };
  }

  /** The member `nameToken` names on `receiver`, or a refusal that says what it may name instead. */
  private member(receiver: Receiver, nameToken: Token): Member {
    const members = SURFACE[receiver];
    const member = members.get(nameToken.text);
    if (member !== undefined) return member;
    const label = RECEIVER_LABELS[receiver];
    const leftOut = LEFT_OUT.get(nameToken.text);
    if (leftOut !== undefined) throw invalid(`"${nameToken.text}" at ${where(nameToken)} is left out of run_code: it ${leftOut}`);
    if (receiver !== 'locator-expectation' && SURFACE['locator-expectation'].has(nameToken.text)) {
      throw invalid(`"${nameToken.text}" at ${where(nameToken)} is a matcher; call it on expect(...)`);
    }
    const names = [...members.keys()];
    const near = suggest(nameToken.text, names);
    const hint = near === undefined ? `; ${label} takes ${names.join(', ')}` : `; did you mean "${near}"?`;
    throw invalid(`"${nameToken.text}" at ${where(nameToken)} is not something run_code runs on ${label}${hint}`);
  }

  /** A call's parenthesized arguments, counted against what the member takes. */
  private call(nameToken: Token, arity: Arity, receiver: Receiver, secretValue: number | undefined, depth: number): Value[] {
    this.punctuator('(', `to call ${nameToken.text}`);
    const args: Value[] = [];
    while (!this.isPunctuator(')')) {
      args.push(this.value(depth + 1, secretValue === args.length));
      if (this.isPunctuator(',')) {
        this.index += 1;
        continue;
      }
      if (!this.isPunctuator(')')) {
        throw invalid(`expected "," or ")" in the arguments of ${nameToken.text}, found ${describe(this.peek())} at ${where(this.peek())}`);
      }
    }
    this.index += 1;
    const [min, max] = arity;
    if (args.length < min || args.length > max) {
      const takes = min === max ? `${String(min)} argument${min === 1 ? '' : 's'}` : `${String(min)} to ${String(max)} arguments`;
      throw invalid(`${nameToken.text} at ${where(nameToken)} on ${RECEIVER_LABELS[receiver]} takes ${takes}, got ${String(args.length)}`);
    }
    return args;
  }

  /** One argument; a Secret only where `secretAllowed` says so. */
  private value(depth: number, secretAllowed: boolean): Value {
    if (depth > MAX_DEPTH) throw invalid(`the argument at ${where(this.peek())} nests deeper than ${String(MAX_DEPTH)} levels`);
    const token = this.peek();
    switch (token.kind) {
      case 'string':
        this.index += 1;
        return { kind: 'literal', value: token.value as string };
      case 'number':
        this.index += 1;
        return { kind: 'literal', value: token.value as number };
      case 'regex':
        this.index += 1;
        return { kind: 'regex', source: token.value as string, flags: token.flags ?? '' };
      case 'identifier':
        return this.reference(token, depth, secretAllowed);
      case 'punctuator':
        if (token.text === '-' && this.tokens[this.index + 1]?.kind === 'number') {
          this.index += 2;
          return { kind: 'literal', value: -(this.tokens[this.index - 1]!.value as number) };
        }
        if (token.text === '[') return this.array(depth);
        if (token.text === '{') return this.object(depth);
        break;
      case 'end':
        break;
    }
    throw invalid(`unexpected ${describe(token)} at ${where(token)}; ${ARGUMENTS}`);
  }

  /** A word in argument position: a literal word, a locator, or a credential or secret reference. */
  private reference(token: Token, depth: number, secretAllowed: boolean): Value {
    switch (token.text) {
      case 'true':
      case 'false':
        this.index += 1;
        return { kind: 'literal', value: token.text === 'true' };
      case 'null':
        this.index += 1;
        return { kind: 'literal', value: null };
      case 'screen':
        return { kind: 'locator', chain: this.locatorChain(depth) };
      case 'credentials': {
        this.index += 1;
        this.punctuator('.', 'after credentials');
        this.word('user', 'credentials.user(name)');
        const name = this.nameArgument('credentials.user');
        this.punctuator('.', `after credentials.user(${JSON.stringify(name)})`);
        const field = this.identifier('username or password');
        if (field.text === 'username') return { kind: 'username', credential: name };
        if (field.text !== 'password') {
          throw invalid(`"${field.text}" at ${where(field)}: a credential has username and password`);
        }
        if (!secretAllowed) throw misplacedSecret(token);
        return { kind: 'secret', from: 'credential', name };
      }
      case 'secrets': {
        this.index += 1;
        this.punctuator('.', 'after secrets');
        this.word('get', 'secrets.get(name)');
        const name = this.nameArgument('secrets.get');
        if (!secretAllowed) throw misplacedSecret(token);
        return { kind: 'secret', from: 'secrets', name };
      }
      default:
        throw invalid(`"${token.text}" at ${where(token)} is not in the grammar; ${ARGUMENTS}`);
    }
  }

  /** The one string argument of `credentials.user(...)` or `secrets.get(...)`. */
  private nameArgument(api: string): string {
    this.punctuator('(', `to call ${api}`);
    const token = this.peek();
    if (token.kind !== 'string' || (token.value as string) === '') {
      throw invalid(`${api} takes the name as a string, found ${describe(token)} at ${where(token)}`);
    }
    this.index += 1;
    this.punctuator(')', `to close ${api}(`);
    return token.value as string;
  }

  private array(depth: number): Value {
    this.index += 1;
    const items: Value[] = [];
    while (!this.isPunctuator(']')) {
      items.push(this.value(depth + 1, false));
      if (this.isPunctuator(',')) {
        this.index += 1;
        continue;
      }
      if (!this.isPunctuator(']')) throw invalid(`expected "," or "]" in the array, found ${describe(this.peek())} at ${where(this.peek())}`);
    }
    this.index += 1;
    return { kind: 'array', items };
  }

  private object(depth: number): Value {
    this.index += 1;
    const entries: (readonly [string, Value])[] = [];
    while (!this.isPunctuator('}')) {
      const keyToken = this.peek();
      if (keyToken.kind !== 'identifier' && keyToken.kind !== 'string') {
        throw invalid(`expected a property name, found ${describe(keyToken)} at ${where(keyToken)}`);
      }
      const key = keyToken.kind === 'string' ? (keyToken.value as string) : keyToken.text;
      if (key === '__proto__') throw invalid(`the property name "__proto__" at ${where(keyToken)} is not allowed`);
      if (entries.some(([seen]) => seen === key)) throw invalid(`the property "${key}" at ${where(keyToken)} is named twice`);
      this.index += 1;
      this.punctuator(':', `after the property name "${key}"`);
      entries.push([key, this.value(depth + 1, false)]);
      if (this.isPunctuator(',')) {
        this.index += 1;
        continue;
      }
      if (!this.isPunctuator('}')) throw invalid(`expected "," or "}" in the object, found ${describe(this.peek())} at ${where(this.peek())}`);
    }
    this.index += 1;
    return { kind: 'object', entries };
  }

  // --- token helpers ---

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  private isPunctuator(text: string): boolean {
    const token = this.peek();
    return token.kind === 'punctuator' && token.text === text;
  }

  private punctuator(text: string, context: string): void {
    const token = this.peek();
    if (token.kind !== 'punctuator' || token.text !== text) {
      throw invalid(`expected "${text}" ${context}, found ${describe(token)} at ${where(token)}`);
    }
    this.index += 1;
  }

  private identifier(what: string): Token {
    const token = this.peek();
    if (token.kind !== 'identifier') throw invalid(`expected ${what}, found ${describe(token)} at ${where(token)}`);
    this.index += 1;
    return token;
  }

  private word(word: string, what: string): void {
    const token = this.peek();
    if (!isWord(token, word)) throw invalid(`expected ${what}, found ${describe(token)} at ${where(token)}`);
    this.index += 1;
  }
}

const STARTS = 'screen, app, or expect(...)';

const ARGUMENTS =
  "an argument is a string, number, boolean, null, regular expression, array, or object, a locator on screen, credentials.user('name').username, or a secret as fill's value";

function misplacedSecret(token: Token): ConfigurationError {
  return invalid(`the secret at ${where(token)} is accepted only as fill's value, such as screen.getByLabel('Password').fill(credentials.user('admin').password)`);
}

function isWord(token: Token, word: string): boolean {
  return token.kind === 'identifier' && token.text === word;
}

function where(token: Token): string {
  return `${String(token.line)}:${String(token.column)}`;
}

/** A token as a message names it, bounded. */
function describe(token: Token): string {
  if (token.kind === 'end') return 'the end of the code';
  const text = token.text.length > 40 ? `${token.text.slice(0, 39)}…` : token.text;
  return JSON.stringify(text);
}
