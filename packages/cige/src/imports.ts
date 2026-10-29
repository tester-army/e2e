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
 * `require` other than a direct call, `process.getBuiltinModule`,
 * `process.mainModule`, `.constructor` other than for its `.name` (it
 * reaches `Function` and CommonJS's `Module`), `eval`, or `Function`,
 * whether by name, as a member (`globalThis.eval`, ``module[`require`]``),
 * or destructured.
 *
 * `binding` and `dlopen` are common names, so they count only on `process`
 * (also `globalThis.process`, `require('node:process')`, an import of
 * `node:process`). Where it's referenced, `process` may only have a field
 * read or destructured: handed on (an alias, an argument, an export) it
 * blocks, since the walk can't see what's read from it there. A load built
 * from strings or reached by reflection (`globalThis['ev' + 'al']`) can't be
 * seen.
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

/** What `process` holds that loads code, read only on `process`: as bare names they're common. */
const PROCESS_LOADERS: Readonly<Record<string, string>> = {
  binding: "reads process.binding, which reaches Node's internal loaders",
  dlopen: 'reads process.dlopen, which loads a native addon',
};
const PROCESS_MODULES = new Set(['process', 'node:process']);
/** The names of the global object, which holds `process`. */
const GLOBALS = new Set(['globalThis', 'global']);
const HANDED_ON = "hands process on (an alias, an argument, an export), where the walk can't see binding or dlopen read";

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
/** Expressions whose value is the one they wrap: a cast, `await`, `?.`. */
const WRAPPERS = new Set(['ChainExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'AwaitExpression']);
/** Where a value is only tested, compared, or dropped, so it goes no further. */
const TESTED = new Set(['ExpressionStatement', 'UnaryExpression', 'BinaryExpression', 'IfStatement', 'ConditionalExpression']);

const TYPESCRIPT = /\.[cm]?ts$/;

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

/** Whether `node` names `node:process`, as a specifier. */
function isProcessModule(node: unknown): boolean {
  return PROCESS_MODULES.has(literal(node) ?? '');
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
    const result = parseSync(file, text, { lang: TYPESCRIPT.test(file) ? 'ts' : 'jsx', sourceType, preserveParens: false });
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
  // `process` under its import names: `import proc from 'node:process'`, `import * as proc`, `import { default as proc }`. Imports hoist, so they're read first.
  const processNames = new Set(['process']);
  for (const statement of tree.body) {
    if (statement.type !== 'ImportDeclaration' || !isProcessModule(statement.source)) continue;
    for (const specifier of statement.specifiers as (Fields & { local: { name: string } })[]) {
      if (specifier.type !== 'ImportSpecifier' || nameOf(specifier.imported, false) === 'default') processNames.add(specifier.local.name);
    }
  }
  /** Whether `node` evaluates to `process` itself, or for `import()`, to a promise of it. */
  const isProcess = (node: Fields, parent: Fields | undefined): boolean => {
    switch (node.type) {
      case 'Identifier':
        return processNames.has(node.name as string) && !isName(node, parent);
      case 'MemberExpression':
        return nameOf(node.property, node.computed) === 'process' && GLOBALS.has(nameOf(node.object, false) ?? '');
      case 'CallExpression':
        return isRequire(node) && isProcessModule((node.arguments as unknown[])[0]);
      case 'ImportExpression':
        return isProcessModule(node.source);
      default:
        return false;
    }
  };
  /** Why `process`, reached at `node`, lets a load past the walk: a loader read off it, or `process` handed on. */
  const processUse = (node: Fields, ancestors: readonly Fields[]): string | undefined => {
    let value = node;
    let index = ancestors.length - 1;
    // The value a cast, an await, a comma, or `a || b` gives may still be process.
    for (; index >= 0; index -= 1) {
      const parent = ancestors[index] as Fields;
      const passes = WRAPPERS.has(parent.type) || parent.type === 'LogicalExpression' || (parent.type === 'ConditionalExpression' && parent.test !== value);
      if (passes || (parent.type === 'SequenceExpression' && (parent.expressions as unknown[]).at(-1) === value)) value = parent;
      else break;
    }
    // A promise of process is only awaited.
    if (node.type === 'ImportExpression' && value === node) return HANDED_ON;
    const parent = ancestors[index];
    // Tested, compared, or dropped: a test, an operand, a statement, a comma's earlier value.
    if (parent === undefined || TESTED.has(parent.type) || parent.type === 'SequenceExpression') return undefined;
    if (parent.type === 'MemberExpression' && parent.object === value) {
      const name = nameOf(parent.property, parent.computed);
      return name === undefined ? 'reads process by a computed name' : lookup(PROCESS_LOADERS, name);
    }
    // A declaration's own name never counts as process, so a declarator here holds it as its value.
    const target = parent.type === 'VariableDeclarator' ? parent.id : parent.type === 'AssignmentExpression' || parent.type === 'AssignmentPattern' ? (parent.right === value ? parent.left : undefined) : undefined;
    if (!isNode(target) || target.type !== 'ObjectPattern') return HANDED_ON;
    // `const { env } = process` reads fields; a rest element takes the loaders with the rest.
    for (const property of target.properties as Fields[]) {
      if (property.type !== 'Property') return HANDED_ON;
      const name = nameOf(property.key, property.computed);
      if (name === undefined) return 'reads process by a computed name';
      const reason = lookup(PROCESS_LOADERS, name);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };
  const visit = (node: Fields, ancestors: Fields[]): void => {
    // Types, ambient declarations, and type-only imports: Node erases them, so they load nothing.
    if (TYPE_ONLY.has(node.type) || node.declare === true || node.importKind === 'type' || node.exportKind === 'type') return;
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    if (isProcess(node, parent)) refuse(processUse(node, ancestors));
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const source = literal(node.source);
        if (source === undefined) break;
        named(specifiers, source);
        if (!PROCESS_MODULES.has(source)) break;
        // `import { binding }` reads the loader; `export *` and `export { default }` hand it, or process, on.
        if (node.type === 'ExportAllDeclaration') refuse(HANDED_ON);
        for (const specifier of (node.specifiers ?? []) as Fields[]) {
          const name = nameOf(specifier.type === 'ExportSpecifier' ? specifier.local : specifier.imported, false);
          refuse(lookup(PROCESS_LOADERS, name) ?? (specifier.type === 'ExportSpecifier' && name === 'default' ? HANDED_ON : undefined));
        }
        break;
      }
      case 'TSImportEqualsDeclaration': {
        // `import x = require('./y')`, TypeScript's CommonJS import; of node:process it's an alias.
        // An alias of a namespace (`import x = N.y`) has no expression, so names no module.
        const source = literal((node.moduleReference as Fields).expression);
        if (source !== undefined) named(requires, source);
        if (PROCESS_MODULES.has(source ?? '')) refuse(HANDED_ON);
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
  visit(tree, []);
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

/**
 * An identifier that names rather than references: a member's property, a
 * key, an import or export's name, a declared local, or a parameter. The
 * name `process` there is not the object.
 */
function isName(node: Fields, parent: Fields | undefined): boolean {
  switch (parent?.type) {
    case 'MemberExpression':
      return parent.property === node && parent.computed !== true;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
      return parent.key === node && parent.computed !== true && parent.shorthand !== true;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return true;
    case 'ExportSpecifier':
      return parent.exported === node && parent.local !== node;
    // A local or a parameter that shadows process is a new binding, not the object.
    case 'VariableDeclarator':
      return parent.id === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return (parent.params as unknown[]).includes(node);
    default:
      return false;
  }
}
