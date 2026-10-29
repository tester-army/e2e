/**
 * The modules a source file imports, read with a parser, for the config
 * graph of `e2e-cige diff` (`config-graph.ts`). TypeScript is stripped the
 * way Node strips it to run the file, then acorn parses what's left, so
 * comments, strings, and templates are what the language says they are.
 *
 * A file whose imports can't all be read from it fails closed with a
 * reason: a computed `import()` or `require()`; an import of a builtin that
 * loads code by a value (`node:module`, `node:vm`, `node:worker_threads`,
 * `node:inspector`), which closes every export of each at once; or any
 * other read of a loader: `require` other than a direct call,
 * `process.getBuiltinModule`, `process.mainModule`, `.constructor` (which
 * reaches `Function` and CommonJS's `Module`), `eval`, or `Function`,
 * whether by name, as a member (`globalThis.eval`, ``module[`require`]``),
 * or destructured. A `data:` import blocks too. A load built from strings
 * or reached by reflection (`globalThis['ev' + 'al']`) can't be seen. Node's type stripping runs this from source in tests, so
 * it holds to erasable TypeScript.
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
  getBuiltinModule: "reads process.getBuiltinModule, which can reach a loader the walk can't follow",
  mainModule: "reads process.mainModule, which reaches Node's module loader",
  constructor: "reads .constructor, which reaches Function or Node's module loader",
  eval: 'runs code from a string (eval or Function)',
  Function: 'runs code from a string (eval or Function)',
};

/** Builtins that load or run code by a value: `Module._load`, `createRequire`, `vm.runInThisContext`, a `Worker` with `eval`, an inspector's `Runtime.evaluate`, `node:test`'s in-process `run`. */
const LOADING_BUILTINS = new Set(['module', 'node:module', 'vm', 'node:vm', 'worker_threads', 'node:worker_threads', 'inspector', 'node:inspector', 'inspector/promises', 'node:inspector/promises', 'node:test']);

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
  const named = (list: string[], specifier: string): void => {
    if (LOADING_BUILTINS.has(specifier)) refuse(`imports ${specifier}, which loads code by a name the walk can't follow`);
    // URL schemes ignore case, so Node runs `DATA:text/javascript,…` too.
    if (/^data:/i.test(specifier)) refuse("imports a data: URL, code the walk can't follow");
    list.push(specifier);
  };
  const loaderKey = (key: unknown): string | undefined => {
    const name = literal(key);
    return name !== undefined && Object.hasOwn(LOADERS, name) ? LOADERS[name] : undefined;
  };
  const visit = (node: Fields, parent: Fields | undefined, grandparent: Fields | undefined): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const source = literal(node.source);
        if (source !== undefined) named(specifiers, source);
        break;
      }
      case 'ImportExpression': {
        const source = literal(node.source);
        if (source === undefined) refuse('imports a module by a computed name');
        else named(specifiers, source);
        break;
      }
      case 'CallExpression': {
        if (isNode(node.callee) && node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const source = literal(Array.isArray(node.arguments) ? node.arguments[0] : undefined);
          if (source === undefined) refuse('imports a module by a computed name');
          else named(requires, source);
        }
        break;
      }
      case 'Identifier': {
        const reason = typeof node.name === 'string' && Object.hasOwn(LOADERS, node.name) ? LOADERS[node.name] : undefined;
        const directRequire = node.name === 'require' && parent?.type === 'CallExpression' && parent.callee === node;
        if (reason !== undefined && !directRequire && !isKey(node, parent, grandparent)) refuse(reason);
        break;
      }
      case 'MemberExpression': {
        // ``module[`require`]`` reads the loader as surely as `module.require`; a string anywhere else is only text.
        const reason = node.computed === true ? loaderKey(node.property) : undefined;
        if (reason !== undefined) refuse(reason);
        break;
      }
      case 'Property': {
        // `const { ['eval']: run } = globalThis` destructures the loader; the same key in an object literal only labels a field.
        const reason = node.computed === true && parent?.type === 'ObjectPattern' ? loaderKey(node.key) : undefined;
        if (reason !== undefined) refuse(reason);
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
