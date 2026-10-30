/**
 * The modules a source file imports, read with a parser, for the config
 * graph of `e2e-cige diff` (`config-graph.ts`). JavaScript is parsed with
 * acorn; TypeScript, and JavaScript acorn can't read (JSX, a decorator),
 * with oxc's parser, whose types the walk skips as Node erases them.
 * Comments, strings, and templates are what the language says they are. A
 * file neither parser reads is unreadable: its imports are unknown.
 *
 * A file whose imports can't all be read from it fails closed with a
 * reason: a computed `import()` or `require()`; an import of a builtin that
 * loads code by a value (`node:module`, `node:vm`, `node:worker_threads`,
 * `node:inspector`, `node:repl`, `node:test`), which closes every export of
 * each at once; a `data:` import; `with`; or any other read of a loader:
 * `require` other than a direct call, `getBuiltinModule`, `mainModule`,
 * `.constructor` other than for its `.name` (it reaches `Function` and
 * CommonJS's `Module`), `eval`, or `Function`, whether by name, as a member
 * (`globalThis.eval`, ``module[`require`]``), destructured, or as a JSX tag.
 *
 * The walk catches the loads an honest change makes, a person's or an
 * agent's. It matches names without scopes, so it's no boundary against code
 * written to get past it: a load built from strings, reached by reflection
 * (`Reflect.get(module, 'req' + 'uire')`), or through `process.binding` or
 * `process.dlopen`, isn't seen.
 */

import { parse } from 'acorn';
import nodeModule from 'node:module';
import type * as OxcParser from 'oxc-parser';

/** What a file imports: the specifiers it names, by how Node resolves them, and why that list is incomplete when it is. */
export interface ModuleImports {
  /** Static imports, re-exports, and `import()`: ESM resolution. */
  readonly specifiers: readonly string[];
  /** `require()` calls and TypeScript's `import x = require()`: CommonJS resolution, extension search included. */
  readonly requires: readonly string[];
  /** Why the file couldn't be read at all, so nothing is known of what it imports. */
  readonly unreadable?: string;
  /** Why the list may miss a load: the file loads code by a value. */
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

/** Builtins that load or run code by a value: `Module._load`, `createRequire`, `vm.runInThisContext`, a `Worker` with `eval`, an inspector's `Runtime.evaluate`, a REPL's `eval`. */
const LOADING_BUILTINS = new Set(['module', 'vm', 'worker_threads', 'inspector', 'inspector/promises', 'repl']);
/** The same, for builtins Node knows only with the prefix: `node:test`'s in-process `run`. */
const PREFIXED_LOADING_BUILTINS = new Set(['node:test']);

/** Fields that hold only types, which Node erases before the file runs; a return type sits under its `typeAnnotation`. */
const TYPE_FIELDS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements']);
/** TypeScript declarations that emit no code. */
const TYPE_ONLY = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
  'TSIndexSignature',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSAbstractAccessorProperty',
]);
const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/;

const ownRequire = nodeModule.createRequire(import.meta.url);
let oxc: typeof OxcParser | Error | undefined;

/**
 * oxc's parser, loaded on first use, as e2e loads it
 * (`e2e/src/config/typescript.ts`), so plain JavaScript never needs its
 * native binding. A failed load is kept, and throws with the way back.
 */
function oxcParser(): typeof OxcParser {
  oxc ??= loadOxc();
  if (oxc instanceof Error) throw oxc;
  return oxc;
}

/** oxc's parser, or why it didn't load. */
function loadOxc(): typeof OxcParser | Error {
  try {
    return ownRequire('oxc-parser') as typeof OxcParser;
  } catch (cause) {
    const reason = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0];
    // napi-rs's loader says so when no platform package is installed.
    const fix = /Cannot find native binding/.test(String(reason))
      ? `its native binding for ${process.platform}-${process.arch} isn't installed: install again without --omit=optional`
      : `it didn't load (${reason})`;
    return new Error(`needs oxc-parser to read it, and ${fix}`, { cause });
  }
}

/** An ESTree node as a plain record, so the walk reads any node's fields the same way. */
type Fields = { readonly type: string } & Record<string, unknown>;

function isNode(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** A specifier written out in full: a string literal, or a template with nothing interpolated. */
function literal(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    const cooked = (node.quasis as { value: { cooked?: unknown } }[])[0]?.value.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/** The name a key, a member, or an import specifier spells: an identifier, or a literal when computed or quoted. */
function nameOf(node: unknown, computed: unknown): string | undefined {
  if (computed !== true && isNode(node) && node.type === 'Identifier') return node.name as string;
  return literal(node);
}

/** `table`'s reason for `name`, when it has one. */
function lookup(table: Readonly<Record<string, string>>, name: string | undefined): string | undefined {
  return Object.hasOwn(table, name ?? '') ? table[name ?? ''] : undefined;
}

/** Whether `node` calls `require` by name. */
function isRequire(node: Fields): boolean {
  const callee = node.callee;
  return isNode(callee) && callee.type === 'Identifier' && callee.name === 'require';
}

/** An ESTree program, as both parsers give it. */
type Program = Fields & { readonly body: readonly Fields[] };

/** A parser's tree as the walk reads it: both give an ESTree program whose body is a list. */
function asProgram(tree: unknown): Program {
  if (!isNode(tree) || !Array.isArray(tree.body)) throw new Error('is not an ESTree program');
  return tree as Program;
}

/** The program `text` holds, or a throw with why it doesn't parse. CommonJS can hold what a module can't, such as a top-level `return`. */
function program(text: string, file: string): Program {
  let first: string | undefined;
  if (!TYPESCRIPT.test(file)) {
    for (const sourceType of ['module', 'script'] as const) {
      try {
        return asProgram(parse(text, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true }));
      } catch (cause) {
        first ??= cause instanceof Error ? cause.message : String(cause);
      }
    }
  }
  const { parseSync } = oxcParser();
  for (const sourceType of ['module', 'commonjs'] as const) {
    const lang = file.endsWith('.tsx') ? 'tsx' : TYPESCRIPT.test(file) ? 'ts' : 'jsx';
    const result = parseSync(file, text, { lang, sourceType, preserveParens: false });
    const error = result.errors.find((item) => item.severity === 'Error');
    if (error === undefined) return asProgram(result.program);
    first ??= error.message;
  }
  throw new Error(`doesn't parse: ${first}`);
}

/** The specifiers `text` imports, statically, lazily, or through `require`, and the first reason the list can't be trusted. */
export function importsOf(text: string, file: string): ModuleImports {
  let tree: Program;
  try {
    tree = program(text, file);
  } catch (cause) {
    return { specifiers: [], requires: [], unreadable: cause instanceof Error ? cause.message : String(cause) };
  }
  const specifiers: string[] = [];
  const requires: string[] = [];
  let unverified: string | undefined;
  const refuse = (reason: string | undefined): void => void (unverified ??= reason);
  const named = (list: string[], specifier: string): void => {
    if (LOADING_BUILTINS.has(specifier.replace(/^node:/, '')) || PREFIXED_LOADING_BUILTINS.has(specifier)) refuse(`imports ${specifier}, which loads code by a name the walk can't follow`);
    // URL schemes ignore case, so Node runs `DATA:text/javascript,…` too.
    if (/^data:/i.test(specifier)) refuse("imports a data: URL, code the walk can't follow");
    list.push(specifier);
  };
  const visit = (node: Fields, ancestors: Fields[]): void => {
    // Types, ambient declarations, and type-only imports: Node erases them, so they load nothing.
    if (TYPE_ONLY.has(node.type) || node.declare === true || node.importKind === 'type' || node.exportKind === 'type') return;
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const source = literal(node.source);
        if (source === undefined) break;
        // `import { type Script } from 'node:vm'` keeps the import but binds nothing a loader could be read from.
        const bound = (node.specifiers ?? []) as Fields[];
        if (bound.length > 0 && bound.every((specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type')) specifiers.push(source);
        else named(specifiers, source);
        break;
      }
      case 'TSImportEqualsDeclaration': {
        // `import x = require('./y')`, TypeScript's CommonJS import. An alias of a namespace (`import x = N.y`) has no expression, so names no module.
        const source = literal((node.moduleReference as Fields).expression);
        if (source !== undefined) named(requires, source);
        break;
      }
      case 'ImportExpression': {
        const source = literal(node.source);
        if (source === undefined) refuse('imports a module by a computed name');
        else named(specifiers, source);
        break;
      }
      case 'CallExpression': {
        if (isRequire(node)) {
          const source = literal((node.arguments as unknown[])[0]);
          if (source === undefined) refuse('imports a module by a computed name');
          else named(requires, source);
        }
        break;
      }
      case 'WithStatement':
        refuse("uses with, which reads names off an object the walk can't follow");
        break;
      case 'Identifier': {
        const reason = lookup(LOADERS, node.name as string);
        const directRequire = node.name === 'require' && parent?.type === 'CallExpression' && parent.callee === node;
        // `err.constructor.name` reads a string, never the constructor.
        const constructorName = node.name === 'constructor' && parent?.type === 'MemberExpression' && parent.property === node && grandparent?.type === 'MemberExpression' && grandparent.object === parent && nameOf(grandparent.property, grandparent.computed) === 'name';
        if (reason !== undefined && !directRequire && !constructorName && !isKey(node, parent, grandparent)) refuse(reason);
        break;
      }
      case 'JSXIdentifier':
        // A capitalized or dotted tag reads a value, which a pragma calls (`<Function>`, `<module.require>`); a lowercase tag or an attribute is only a name.
        if (parent?.type === 'JSXMemberExpression' || (parent?.type === 'JSXOpeningElement' && /^[A-Z]/.test(node.name as string))) refuse(lookup(LOADERS, node.name as string));
        break;
      case 'MemberExpression':
        // ``module[`require`]`` reads the loader as surely as `module.require`; a string anywhere else is only text.
        refuse(lookup(LOADERS, literal(node.property)));
        break;
      case 'Property':
        // `const { ['eval']: run } = globalThis` destructures the loader; the same key in an object literal only labels a field.
        if (node.computed === true && parent?.type === 'ObjectPattern') refuse(lookup(LOADERS, literal(node.key)));
        break;
    }
    ancestors.push(node);
    for (const [field, value] of Object.entries(node)) {
      if (TYPE_FIELDS.has(field)) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child, ancestors);
    }
    ancestors.pop();
  };
  try {
    visit(tree, []);
  } catch (cause) {
    // A tree the walk doesn't expect fails closed, naming why, rather than ending the graph's process.
    return { specifiers: [], requires: [], unreadable: `couldn't be walked: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { specifiers, requires, ...(unverified === undefined ? {} : { unverified }) };
}

/**
 * A name that labels a field rather than reading a binding: `{ require: … }`
 * in an object literal, `class { require() {} }`, or an enum member. `x.require`
 * is a read, and so is `const { require: r } = module`, a destructure, so
 * neither is one.
 */
function isKey(node: Fields, parent: Fields | undefined, grandparent: Fields | undefined): boolean {
  if (parent === undefined || parent.computed === true) return false;
  if (parent.type === 'TSEnumMember') return parent.id === node;
  if (parent.key !== node) return false;
  if (parent.type === 'Property') return parent.shorthand !== true && grandparent?.type === 'ObjectExpression';
  return parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty';
}
