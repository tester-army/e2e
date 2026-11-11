import type { Argument, Expression, Node } from 'oxc-parser';
import { oxcParser } from '../config/typescript.ts';
import { replay } from '../replay.ts';

/** Rejects expressions outside the literal grammar before invoking the native parser. */
function preflight(source: string): void {
  if (source.length > 1_048_576) throw new Error('replay source exceeds 1 MiB');
  const token = /\s+|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|[{}()[\],.:;]/y;
  let depth = 0;
  for (let offset = 0; offset < source.length;) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (match === null) throw new Error(`unsupported replay syntax at ${position(source, offset)}`);
    const text = match[0];
    if (text.length === 1 && '({['.includes(text)) depth += 1;
    if (text.length === 1 && ')}]'.includes(text)) depth -= 1;
    if (depth > 64) throw new Error('replay source nests deeper than 64 levels');
    offset = token.lastIndex;
  }
}

/** Converts a source offset into a diagnostic location. */
function position(source: string, offset: number): string {
  const lines = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/u);
  return `${lines.length}:${lines.at(-1)!.length + 1}`;
}

/** Reads the closed replay declaration grammar with the same native parser as MCP run_code. */
export function parseReplaySource(source: string): unknown {
  preflight(source);
  const { program, errors } = oxcParser().parseSync('recording.ts', source, { lang: 'ts', sourceType: 'module' });
  const error = errors.find((candidate) => candidate.severity === 'Error');
  if (error !== undefined) throw new Error(`replay syntax at ${position(source, error.labels[0]?.start ?? 0)}: ${error.message}`);
  const fail = (node: Node, message: string): never => { throw new Error(`${message} at ${position(source, node.start)}`); };
  const [header, exported, extra] = program.body;
  if (header?.type !== 'ImportDeclaration' || header.source.value !== 'e2e/replay' || header.specifiers.length !== 1 || header.importKind !== 'value') {
    throw new Error('expected import { replay } from "e2e/replay"');
  }
  const specifier = header.specifiers[0]!;
  if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier' || specifier.imported.name !== 'replay' || specifier.local.name !== 'replay' || specifier.importKind !== 'value') fail(header, 'expected the replay binding');
  if (exported?.type !== 'ExportDefaultDeclaration' || extra !== undefined) throw new Error('expected only a replay import and default export');

  /** Checks a named replay call without evaluating its callee or arguments. */
  function call(node: Node): { name: string; args: readonly Argument[] } {
    if (node.type !== 'CallExpression' || node.optional || node.typeArguments !== null) return fail(node, 'expected a replay call');
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || callee.object.type !== 'Identifier' || callee.object.name !== 'replay' || callee.property.type !== 'Identifier') return fail(node, 'expected replay.<operation>');
    const name = callee.property.name;
    if (!Object.hasOwn(replay, name)) return fail(node, 'unknown replay operation');
    return { name, args: node.arguments };
  }

  /** Materializes JSON literals into own properties, rejecting executable and ambiguous object forms. */
  function value(node: Argument | Expression): unknown {
    switch (node.type) {
      case 'Literal':
        if ('regex' in node || 'bigint' in node || (typeof node.value === 'number' && !Number.isFinite(node.value))) break;
        return node.value;
      case 'UnaryExpression':
        if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) return -node.argument.value;
        break;
      case 'ArrayExpression':
        return node.elements.map((item) => item === null ? fail(node, 'array holes are forbidden') : value(item));
      case 'ObjectExpression': {
        const entries: [string, unknown][] = [];
        const names = new Set<string>();
        for (const property of node.properties) {
          if (property.type !== 'Property' || property.computed || property.method || property.shorthand || property.kind !== 'init') return fail(property, 'expected a literal property');
          const key = property.key;
          const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
          if (name === undefined || name === '__proto__' || names.has(name)) return fail(property, 'invalid or duplicate property');
          names.add(name);
          entries.push([name, value(property.value)]);
        }
        return Object.fromEntries(entries);
      }
    }
    return fail(node, 'expected a JSON literal');
  }
  /** Parses one step's replay declaration, never an arbitrary nested expression. */
  function definition(node: Node): unknown {
    const operation = call(node);
    const [context, actions] = operation.args;
    if (operation.name !== 'define' || operation.args.length !== 2 || context?.type !== 'ObjectExpression' || actions?.type !== 'ArrayExpression') return fail(node, 'expected replay.define(context, actions)');
    const metadata = value(context) as Record<string, unknown>;
    if (Object.hasOwn(metadata, 'actions')) return fail(context, 'context cannot override actions');
    return {
      ...metadata,
      actions: actions.elements.map((action) => {
        if (action === null) return fail(actions, 'action holes are forbidden');
        const verb = call(action);
        const [input] = verb.args;
        if (['define', 'test', 'step'].includes(verb.name) || verb.args.length !== 1 || input?.type !== 'ObjectExpression') return fail(action, 'expected one action input object');
        const fields = value(input) as Record<string, unknown>;
        if (Object.hasOwn(fields, 'name')) return fail(input, 'input cannot override the operation');
        return { ...fields, name: verb.name };
      }),
    };
  }
  const root = call(exported.declaration);
  if (root.name === 'define') return definition(exported.declaration);
  const [context, steps] = root.args;
  if (root.name !== 'test' || root.args.length !== 2 || context?.type !== 'ObjectExpression' || steps?.type !== 'ArrayExpression') return fail(exported, 'expected replay.test(context, steps)');
  const metadata = value(context) as Record<string, unknown>;
  if (Object.hasOwn(metadata, 'steps')) return fail(context, 'context cannot override steps');
  return {
    ...metadata,
    steps: steps.elements.map((node) => {
      if (node === null) return fail(steps, 'step holes are forbidden');
      const operation = call(node);
      const [input, trace] = operation.args;
      if (operation.name !== 'step' || operation.args.length !== 2 || input?.type !== 'ObjectExpression' || trace === undefined) return fail(node, 'expected replay.step(context, replay.define(...))');
      const fields = value(input) as Record<string, unknown>;
      if (Object.hasOwn(fields, 'trace')) return fail(input, 'step cannot override trace');
      return { ...fields, trace: definition(trace) };
    }),
  };
}
