/**
 * Compiles a TypeScript or JSX file to JavaScript this Node.js runs, with oxc. The
 * output carries an inline source map, so stack traces, a test's location,
 * and failure code frames point at the TypeScript source. Syntax the running
 * Node.js lacks (`using`, for one) is lowered for it; the helpers that needs
 * come from e2e's own copy of `@oxc-project/runtime`, which the project need
 * not install. The nearest tsconfig.json decides the options that change what
 * runs: JSX, legacy decorators, class field semantics, and import elision.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformSync, type JsxOptions, type OxcError, type TransformOptions } from 'oxc-transform';
import { tsconfigFor, type CompilerOptions } from './tsconfig.ts';

/** The module system a compiled file runs under. */
export type ModuleFormat = 'module' | 'commonjs';

/** TypeScript targets that predate ES2022, where class fields are assigned rather than defined. */
const ASSIGNED_FIELDS_TARGET = /^es(?:3|5|6|20(?:15|16|17|18|19|20|21))$/i;

/** JSX as the tsconfig asks for it; classic `React.createElement` when it names no automatic runtime. */
function jsxOptions(options: CompilerOptions): JsxOptions {
  if (options.jsx === 'react-jsx' || options.jsx === 'react-jsxdev') {
    return { runtime: 'automatic', importSource: options.jsxImportSource ?? 'react', development: options.jsx === 'react-jsxdev' };
  }
  return {
    runtime: 'classic',
    pragma: options.jsxFactory ?? 'React.createElement',
    pragmaFrag: options.jsxFragmentFactory ?? 'React.Fragment',
  };
}

/**
 * `useDefineForClassFields` as TypeScript reads it: explicit, or false for a
 * target below ES2022. An unset target keeps define semantics, as esbuild did.
 */
function definesClassFields(options: CompilerOptions): boolean {
  if (options.useDefineForClassFields !== undefined) return options.useDefineForClassFields;
  return options.target === undefined || !ASSIGNED_FIELDS_TARGET.test(options.target);
}

/** The oxc options a tsconfig's compiler options call for. */
function transformOptions(options: CompilerOptions): TransformOptions {
  const assignsFields = !definesClassFields(options);
  return {
    jsx: jsxOptions(options),
    typescript: {
      onlyRemoveTypeImports: options.verbatimModuleSyntax === true,
      removeClassFieldsWithoutInitializer: assignsFields,
    },
    assumptions: { setPublicClassFields: assignsFields },
    ...(options.experimentalDecorators === true
      ? { decorator: { legacy: true, emitDecoratorMetadata: options.emitDecoratorMetadata === true } }
      : {}),
  };
}

/** `file:line:column: message` for one error; oxc counts UTF-8 bytes, an editor counts characters. */
function describeError(file: string, source: Buffer, error: OxcError): string {
  const start = error.labels[0]?.start;
  if (start === undefined) return `${file}: ${error.message}`;
  const lines = source.subarray(0, start).toString('utf8').split('\n');
  return `${file}:${lines.length}:${lines.at(-1)!.length + 1}: ${error.message}`;
}

/**
 * Oxc keeps a file whose only imports were type-only a module by appending
 * `export {};`, even when told the source is CommonJS, where that statement
 * is a syntax error. TypeScript emits nothing for it.
 */
function withoutModuleMarker(code: string): string {
  return code.replace(/(^|\n)export \{\};\n$/, '$1');
}

/**
 * The first statement of compiled CommonJS. The `require` Node.js hands a
 * CommonJS module an ES module imports resolves without module hooks (on
 * Node.js 22, and on 24 before 24.18), so `require('./helper')` would miss
 * `helper.ts`, a tsconfig alias, and the helpers compiled code requires from
 * e2e's install. A `require` from `createRequire` resolves through them.
 */
const HOOKED_REQUIRE = 'require = require("node:module").createRequire(__filename);';

/** A directive on a line of its own, as oxc prints the prologue: `"use strict";`. */
const DIRECTIVE = /^(["'])[^"'\\]*\1;$/;

/**
 * Compiled CommonJS with `HOOKED_REQUIRE` as its first statement: after a
 * hashbang and the directive prologue, which have to stay first, with the
 * source map moved down the line it adds.
 */
function withHookedRequire(code: string, mappings: string): { code: string; mappings: string } {
  const lines = code.split('\n');
  let at = lines[0]?.startsWith('#!') === true ? 1 : 0;
  while (at < lines.length && DIRECTIVE.test(lines[at]!)) at += 1;
  lines.splice(at, 0, HOOKED_REQUIRE);
  const lineMappings = mappings.split(';');
  while (lineMappings.length < at) lineMappings.push('');
  lineMappings.splice(at, 0, '');
  return { code: lines.join('\n'), mappings: lineMappings.join(';') };
}

const ownRequire = createRequire(import.meta.url);

/**
 * The compiled code with every runtime helper oxc imports pointed at e2e's
 * own copy, by URL for `import` and by path for `require`. Rewriting the
 * specifiers oxc wrote, rather than redirecting the package name in the
 * resolver, leaves a project's own `@oxc-project/runtime` alone.
 */
function withOwnHelpers(code: string, helpers: Readonly<Record<string, string>>, format: ModuleFormat): string {
  let rewritten = code;
  for (const specifier of new Set(Object.values(helpers))) {
    const file = ownRequire.resolve(specifier);
    rewritten = rewritten.replaceAll(JSON.stringify(specifier), JSON.stringify(format === 'module' ? pathToFileURL(file).href : file));
  }
  return rewritten;
}

/** `source`, the TypeScript or JSX in `file`, compiled to JavaScript for `format`, with an inline source map. */
export function compileTypeScript(file: string, source: string, format: ModuleFormat): string {
  const result = transformSync(file, source, {
    ...transformOptions(tsconfigFor(file)?.compilerOptions ?? {}),
    lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.jsx') ? 'jsx' : 'ts',
    sourceType: format,
    target: `node${process.versions.node}`,
    sourcemap: true,
  });
  const errors = result.errors.filter((error) => error.severity === 'Error');
  if (errors.length > 0) {
    const bytes = Buffer.from(source, 'utf8');
    throw new SyntaxError(errors.map((error) => describeError(file, bytes, error)).join('\n'));
  }
  const compiled = { code: withOwnHelpers(result.code, result.helpersUsed, format), mappings: result.map?.mappings ?? '' };
  const { code, mappings } = format === 'commonjs' ? withHookedRequire(withoutModuleMarker(compiled.code), compiled.mappings) : compiled;
  const map = {
    ...result.map,
    mappings,
    // Absolute, so a frame names the file without the loader's query, whatever characters its name holds.
    sources: [pathToFileURL(file).href],
    sourcesContent: undefined,
  };
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
}
