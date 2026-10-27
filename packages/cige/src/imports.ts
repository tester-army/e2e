/**
 * The modules a source file imports, read with a parser, for the config
 * graph of `e2e-cige diff` (`config-graph.ts`). TypeScript is stripped the
 * way Node strips it to run the file, then acorn parses what's left, so
 * comments, strings, and templates are what the language says they are.
 *
 * A file whose imports can't all be read from it fails closed with a
 * reason: a computed `import()` or `require()`, or any other read of a
 * loader: `require` other than a direct call, `createRequire` (its function
 * can be called under any name), `eval`, or `Function`, whether by name, as
 * a member (`globalThis.eval`, `module['require']`), or destructured. Node's type stripping runs
 * this from source in tests, so it holds to erasable TypeScript.
 */

import { parse, type Program } from 'acorn';
import nodeModule from 'node:module';

/** What a file imports: the specifiers it names, by how Node resolves them, and why that list is incomplete when it is. */
export interface ModuleImports {
  /** Static imports, re-exports, and `import()`: ESM resolution. */
  readonly specifiers: readonly string[];
  /** `require()` calls: CommonJS resolution, extension search included. */
  readonly requires: readonly string[];
  readonly unverified?: string;
}

/** The names that load or run code by a value the parser can't follow, and why reading one blocks. */
const LOADERS: Readonly<Record<string, string>> = {
  require: "uses require other than as require('<module>')",
  createRequire: "calls createRequire, whose require can't be followed",
  eval: 'runs code from a string (eval or Function)',
  Function: 'runs code from a string (eval or Function)',
};

const TYPESCRIPT = /\.[cm]?ts$/;

/** An ESTree node as a plain record, so the walk reads any node's fields the same way. */
type Fields = { readonly type: string } & Record<string, unknown>;

function isNode(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** A specifier written out in full: a string literal, or a template with nothing interpolated. */
function literal(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0 && Array.isArray(node.quasis)) {
    const quasi: unknown = node.quasis[0];
    const cooked = isNode(quasi) && typeof quasi.value === 'object' && quasi.value !== null ? (quasi.value as { cooked?: unknown }).cooked : undefined;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

function program(code: string): Program {
  try {
    return parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch {
    // CommonJS can hold what a module can't, such as a top-level `return`.
    return parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  }
}

/** The specifiers `text` imports, statically, lazily, or through `require`, and the first reason the list can't be trusted. */
export function importsOf(text: string, file: string): ModuleImports {
  let code = text;
  if (TYPESCRIPT.test(file)) {
    if (typeof nodeModule.stripTypeScriptTypes !== 'function') return { specifiers: [], requires: [], unverified: "is TypeScript, and this Node can't strip its types" };
    try {
      code = nodeModule.stripTypeScriptTypes(text, { mode: 'strip' });
    } catch (cause) {
      return { specifiers: [], requires: [], unverified: `has TypeScript Node can't strip: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}` };
    }
  }
  let tree: Program;
  try {
    tree = program(code);
  } catch (cause) {
    return { specifiers: [], requires: [], unverified: `doesn't parse: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const specifiers: string[] = [];
  const requires: string[] = [];
  let unverified: string | undefined;
  const refuse = (reason: string): void => void (unverified ??= reason);
  const visit = (node: Fields, parent: Fields | undefined, grandparent: Fields | undefined): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const source = literal(node.source);
        if (source !== undefined) specifiers.push(source);
        break;
      }
      case 'ImportExpression': {
        const source = literal(node.source);
        if (source === undefined) refuse('imports a module by a computed name');
        else specifiers.push(source);
        break;
      }
      case 'CallExpression': {
        if (isNode(node.callee) && node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const source = literal(Array.isArray(node.arguments) ? node.arguments[0] : undefined);
          if (source === undefined) refuse('imports a module by a computed name');
          else requires.push(source);
        }
        break;
      }
      case 'Identifier': {
        const reason = typeof node.name === 'string' && Object.hasOwn(LOADERS, node.name) ? LOADERS[node.name] : undefined;
        const directRequire = node.name === 'require' && parent?.type === 'CallExpression' && parent.callee === node;
        if (reason !== undefined && !directRequire && !isKey(node, parent, grandparent)) refuse(reason);
        break;
      }
      case 'Literal': {
        // `module['require']` reads the loader as surely as `module.require`; a string anywhere else is only text.
        const reason = typeof node.value === 'string' && Object.hasOwn(LOADERS, node.value) ? LOADERS[node.value] : undefined;
        if (reason !== undefined && parent?.type === 'MemberExpression' && parent.computed === true && parent.property === node) refuse(reason);
        break;
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child, node, parent);
    }
  };
  const top: unknown = tree;
  if (isNode(top)) visit(top, undefined, undefined);
  return { specifiers, requires, ...(unverified === undefined ? {} : { unverified }) };
}

/**
 * A name that labels a field rather than reading a binding: `{ require: … }`
 * in an object literal, or `class { require() {} }`. `x.require` is a read,
 * and so is `const { require: r } = module`, a destructure, so neither is one.
 */
function isKey(node: Fields, parent: Fields | undefined, grandparent: Fields | undefined): boolean {
  if (parent === undefined || parent.key !== node || parent.computed === true) return false;
  if (parent.type === 'Property') return parent.shorthand !== true && grandparent?.type === 'ObjectExpression';
  return parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition';
}
