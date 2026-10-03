/**
 * Compiles a TypeScript or JSX file to JavaScript this Node.js runs, with
 * oxc. The output carries an inline source map, so stack traces, a test's
 * location, and failure code frames point at the source. Syntax the running
 * Node.js lacks (`using`, for one) is lowered for it, with helpers from e2e's
 * own copy of `@oxc-project/runtime`, which the project need not install.
 * The caller passes the compiler options that change what runs: JSX, legacy
 * decorators, class field semantics, and import elision.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformSync, type JsxOptions, type OxcError, type TransformOptions } from 'oxc-transform';
import { importedCommonJsRequireRunsHooks } from '../internal/node-version.ts';
import type { CompiledExtension } from './compiled-files.ts';
import type { CompilerOptions } from './tsconfig.ts';

/** The first ECMAScript edition that defines class fields rather than assigning them. */
const DEFINED_FIELDS_SINCE = 2022;

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
 * The ECMAScript year a tsconfig `target` names, or undefined for `ESNext`
 * and an unset target. `ES6` is 2015; `ES3` and `ES5` count as 2009, the
 * year of ES5.
 */
function targetYear(target: string | undefined): number | undefined {
  const edition = /^es(\d+)$/i.exec(target ?? '')?.[1];
  if (edition === undefined) return undefined;
  const number = Number(edition);
  if (number === 6) return 2015;
  return number < 2015 ? 2009 : number;
}

/**
 * `useDefineForClassFields` as TypeScript reads it: explicit, or false for a
 * target below ES2022. An unset target keeps define semantics, as esbuild did.
 */
function definesClassFields(options: CompilerOptions): boolean {
  if (options.useDefineForClassFields !== undefined) return options.useDefineForClassFields;
  const year = targetYear(options.target);
  return year === undefined || year >= DEFINED_FIELDS_SINCE;
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
 * is a syntax error and TypeScript emits nothing. It is an oxc bug, not yet
 * reported upstream (oxc 0.152.0, `crates/oxc_transformer/src/typescript/
 * annotations.rs`, the `no_modules_remaining && some_modules_deleted`
 * branch); the statement is always the last line oxc prints.
 */
function withoutModuleMarker(code: string): string {
  return code.replace(/(^|\n)export \{\};\n$/, '$1');
}

/**
 * A `require` that runs resolve hooks, for compiled CommonJS on a Node.js
 * whose `require` in a CommonJS module an ES module imported does not (see
 * `importedCommonJsRequireRunsHooks`). Without it, `require('./helper')`
 * from such a module misses `helper.ts`, a tsconfig alias, and the helpers
 * compiled code requires from e2e's install.
 */
const HOOKED_REQUIRE = 'require = require("node:module").createRequire(__filename);';

/** What may come before and between directives: whitespace and comments. */
const TRIVIA = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
/** One directive: a string literal statement, `"use strict";`. */
const DIRECTIVE = /"(?:[^"\\\n]|\\.)*";|'(?:[^'\\\n]|\\.)*';/y;

/** Where the directive prologue of compiled `code` ends, past its last `;`, or undefined when it has none. */
function prologueEnd(code: string): number | undefined {
  let at = code.startsWith('#!') ? code.indexOf('\n') + 1 || code.length : 0;
  let end: number | undefined;
  for (;;) {
    TRIVIA.lastIndex = at;
    TRIVIA.exec(code);
    DIRECTIVE.lastIndex = TRIVIA.lastIndex;
    if (DIRECTIVE.exec(code) === null) return end;
    at = DIRECTIVE.lastIndex;
    end = at;
  }
}

/**
 * Compiled CommonJS whose `require` runs resolve hooks. The statement
 * follows the last directive on its line, so the prologue stays first and
 * no mapped position moves. With no directive it takes a line of its own at
 * the top (after a hashbang), and the source map gains an unmapped line
 * there.
 */
function withHookedRequire(code: string, mappings: string): { code: string; mappings: string } {
  const end = prologueEnd(code);
  if (end !== undefined) return { code: `${code.slice(0, end)} ${HOOKED_REQUIRE}${code.slice(end)}`, mappings };
  const line = code.startsWith('#!') ? 1 : 0;
  const lines = code.split('\n');
  lines.splice(line, 0, HOOKED_REQUIRE);
  const mappedLines = mappings.split(';');
  mappedLines.splice(line, 0, '');
  return { code: lines.join('\n'), mappings: mappedLines.join(';') };
}

const ownRequire = createRequire(import.meta.url);
/** Each helper's file in e2e's copy of `@oxc-project/runtime`, resolved once. */
const helperFiles = new Map<string, string>();

/**
 * The compiled code with each runtime helper it imports or requires taken
 * from e2e's own copy: by URL for `import`, by path for `require`. Oxc 0.152
 * has no option to name the helper source, so the import and require
 * specifiers it printed (`helpersUsed`) are rewritten; a redirect of the
 * package name in the resolver would also catch a project's own
 * `@oxc-project/runtime` imports.
 */
function withOwnHelpers(code: string, helpers: Readonly<Record<string, string>>, format: CompiledExtension['format']): string {
  let rewritten = code;
  for (const specifier of new Set(Object.values(helpers))) {
    let file = helperFiles.get(specifier);
    if (file === undefined) {
      file = ownRequire.resolve(specifier);
      helperFiles.set(specifier, file);
    }
    const written = JSON.stringify(specifier);
    rewritten =
      format === 'module'
        ? rewritten.replaceAll(` from ${written};`, ` from ${JSON.stringify(pathToFileURL(file).href)};`)
        : rewritten.replaceAll(`require(${written})`, `require(${JSON.stringify(file)})`);
  }
  return rewritten;
}

/**
 * `source`, the content of `file`, compiled to JavaScript for its kind with
 * `compilerOptions`, with an inline source map.
 */
export function compileTypeScript(file: string, source: string, kind: CompiledExtension, compilerOptions: CompilerOptions): string {
  const result = transformSync(file, source, {
    ...transformOptions(compilerOptions),
    lang: kind.lang,
    sourceType: kind.format,
    target: `node${process.versions.node}`,
    sourcemap: true,
  });
  const errors = result.errors.filter((error) => error.severity === 'Error');
  if (errors.length > 0) {
    const bytes = Buffer.from(source, 'utf8');
    throw new SyntaxError(errors.map((error) => describeError(file, bytes, error)).join('\n'));
  }
  let code = withOwnHelpers(result.code, result.helpersUsed, kind.format);
  let mappings = result.map?.mappings ?? '';
  if (kind.format === 'commonjs') {
    code = withoutModuleMarker(code);
    if (!importedCommonJsRequireRunsHooks()) ({ code, mappings } = withHookedRequire(code, mappings));
  }
  const map = {
    ...result.map,
    mappings,
    // Absolute, so a frame names the file without the loader's query, whatever characters its name holds.
    sources: [pathToFileURL(file).href],
    sourcesContent: undefined,
  };
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
}
