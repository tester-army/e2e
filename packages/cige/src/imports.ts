/**
 * The modules a source file imports, read with a parser, for the config
 * graph of `e2e-cige diff` (`config-graph.ts`). TypeScript is stripped the
 * way Node strips it to run the file, then acorn parses what's left, so
 * comments, strings, and templates are what the language says they are.
 *
 * A file whose imports can't all be read from it fails closed with a
 * reason: a computed `import()` or `require()`, a `createRequire` (its
 * function can be called under any name), `require` used as a value, or
 * code run from a string (`eval`, `Function`). Node's type stripping runs
 * this from source in tests, so it holds to erasable TypeScript.
 */

import { parse, type Program } from 'acorn';
import nodeModule from 'node:module';

/** What a file imports: the specifiers it names, and why that list is incomplete when it is. */
export interface ModuleImports {
  readonly specifiers: readonly string[];
  readonly unverified?: string;
}

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
    if (typeof nodeModule.stripTypeScriptTypes !== 'function') return { specifiers: [], unverified: "is TypeScript, and this Node can't strip its types" };
    try {
      code = nodeModule.stripTypeScriptTypes(text, { mode: 'strip' });
    } catch (cause) {
      return { specifiers: [], unverified: `has TypeScript Node can't strip: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}` };
    }
  }
  let tree: Program;
  try {
    tree = program(code);
  } catch (cause) {
    return { specifiers: [], unverified: `doesn't parse: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const specifiers: string[] = [];
  let unverified: string | undefined;
  const refuse = (reason: string): void => void (unverified ??= reason);
  const visit = (node: Fields, parent: Fields | undefined): void => {
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
      case 'CallExpression':
      case 'NewExpression': {
        const callee = isNode(node.callee) && node.callee.type === 'Identifier' ? node.callee.name : undefined;
        const first: unknown = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
        if (callee === 'require' && node.type === 'CallExpression') {
          const source = literal(first);
          if (source === undefined) refuse('imports a module by a computed name');
          else specifiers.push(source);
        }
        if (callee === 'eval' || callee === 'Function') refuse('runs code from a string (eval or Function)');
        break;
      }
      case 'Identifier':
        if (node.name === 'createRequire') refuse("calls createRequire, whose require can't be followed");
        else if (node.name === 'require' && !(parent?.type === 'CallExpression' && parent.callee === node) && !isKey(node, parent)) {
          refuse("uses require other than as require('<module>')");
        }
        break;
      case 'Literal':
        if (node.value === 'createRequire') refuse("calls createRequire, whose require can't be followed");
        break;
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child, node);
    }
  };
  const top: unknown = tree;
  if (isNode(top)) visit(top, undefined);
  return { specifiers, ...(unverified === undefined ? {} : { unverified }) };
}

/** A name that labels a field rather than reading a binding: `{ require: … }` or `class { require() {} }`. `x.require` is a read, so it isn't one. */
function isKey(node: Fields, parent: Fields | undefined): boolean {
  if (parent === undefined || parent.key !== node || parent.computed === true) return false;
  return (parent.type === 'Property' && parent.shorthand !== true) || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition';
}
