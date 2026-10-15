/**
 * Compiles a TypeScript or JSX file to JavaScript this Node.js runs, with
 * oxc. The output carries an inline source map, so stack traces, a test's
 * location, and failure code frames point at the source. Syntax the running
 * Node.js lacks (`using`, for one) is lowered for it, with helpers from e2e's
 * own copy of `@oxc-project/runtime`, which the project need not install.
 * The caller passes the compiler options that change what runs: JSX, legacy
 * decorators, class field semantics, and import elision.
 */

import remapping, { type SourceMapInput } from '@jridgewell/remapping';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type * as OxcParser from 'oxc-parser';
import type { JsxOptions, OxcError, TransformOptions } from 'oxc-transform';
import type * as OxcTransform from 'oxc-transform';
import { InfrastructureError } from '../internal/errors.ts';
import { HOOKED_REQUIRE_KEY, type CompiledExtension } from './compiled-files.ts';
import type { CompilerOptions } from './tsconfig.ts';

const ownRequire = createRequire(import.meta.url);

/** oxc's transformer and parser, loaded on first use. */
let compiler: { transform: typeof OxcTransform; parser: typeof OxcParser } | undefined;

/**
 * oxc, loaded when the first file compiles rather than when e2e loads, so
 * a command that compiles nothing (`--version`, `--help`) still runs
 * without oxc's native binding. npm leaves that binding out with
 * `--omit=optional`, and from a lockfile written on another platform
 * (npm/cli#4828); the error names it and the way back.
 */
function oxc(): { transform: typeof OxcTransform; parser: typeof OxcParser } {
  if (compiler !== undefined) return compiler;
  try {
    compiler = { transform: ownRequire('oxc-transform') as typeof OxcTransform, parser: ownRequire('oxc-parser') as typeof OxcParser };
  } catch (cause) {
    const reason = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0];
    // napi-rs's loader says so when no platform package is installed.
    const missingBinding = /Cannot find native binding/.test(String((cause as Error | undefined)?.message));
    const platform = `${process.platform}-${process.arch}`;
    const fix = missingBinding
      ? `its native bindings for ${platform} (@oxc-transform/binding-${platform}* and @oxc-parser/binding-${platform}*) are not installed. npm skips it with --omit=optional, or when package-lock.json was written on another platform (npm/cli#4828): install again without --omit=optional, or delete package-lock.json and node_modules and run npm install`
      : `it could not be loaded (${reason})`;
    throw new InfrastructureError('TYPESCRIPT_COMPILER_UNAVAILABLE', `e2e compiles TypeScript with oxc, and ${fix}`, { cause });
  }
  return compiler;
}

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

/** `file:line:column: message` for one oxc-transform error; it counts UTF-8 bytes, an editor counts characters. */
function describeError(file: string, source: Buffer, error: OxcError): string {
  const start = error.labels[0]?.start;
  if (start === undefined) return `${file}: ${error.message}`;
  return `${file}:${position(source.subarray(0, start).toString('utf8'))}: ${error.message}`;
}

/** `line:column` just past `text`, both counted from 1. */
function position(text: string): string {
  const lines = text.split('\n');
  return `${lines.length}:${lines.at(-1)!.length + 1}`;
}

/**
 * Syntax oxc 0.153 passes through unchanged that Node.js cannot run, found
 * before compiling so the error names the line and the fix instead of a
 * bare `SyntaxError` from Node.js with no location. Each check only parses
 * a file whose text could hold the construct.
 */
function rejectUnsupportedSyntax(file: string, source: string, kind: CompiledExtension, options: CompilerOptions): void {
  const legacyDecorators = options.experimentalDecorators === true;
  const commonJs = kind.format === 'commonjs';
  // A decorator's `@` starts a line or follows whitespace or punctuation, which rules out a package import ('@scope/pkg').
  const mayHold =
    (commonJs && /\b(?:import|export)\b/.test(source)) || /\baccessor\b/.test(source) || (!legacyDecorators && /(?:^|[\s(,;{}])@[A-Za-z_$]/m.test(source));
  if (!mayHold) return;
  const parsed = oxc().parser.parseSync(file, source, { lang: kind.lang, sourceType: kind.format });
  const problems: { start: number; message: string }[] = [];
  if (commonJs) {
    for (const declaration of parsed.module.staticImports) {
      if (declaration.entries.length === 0 || declaration.entries.some((entry) => !entry.isType)) {
        problems.push({ start: declaration.start, message: 'a .cts file is CommonJS, and e2e does not turn an import declaration into require(): write `import name = require(...)`, or `import type` for types' });
      }
    }
    for (const declaration of parsed.module.staticExports) {
      // `export interface`, `export type`, and `export declare` emit nothing, as tsc allows in .cts.
      if (declaration.entries.every((entry) => entry.isType)) continue;
      problems.push({ start: declaration.start, message: 'a .cts file is CommonJS, and e2e does not turn an export declaration into module.exports: write `export = ...`' });
    }
  }
  const { Visitor } = oxc().parser;
  new Visitor({
    AccessorProperty(node) {
      problems.push({ start: node.start, message: '`accessor` class fields (auto-accessors) are not supported: oxc, which compiles e2e\'s TypeScript, does not lower them yet; write a getter and setter over a private field' });
    },
    Decorator(node) {
      if (!legacyDecorators) {
        problems.push({ start: node.start, message: 'decorators need `"experimentalDecorators": true` in tsconfig.json: e2e compiles TypeScript\'s legacy decorators, and Node.js does not run standard decorators yet' });
      }
    },
  }).visit(parsed.program);
  if (problems.length > 0) {
    throw new SyntaxError(problems.map(({ start, message }) => `${file}:${position(source.slice(0, start))}: ${message}`).join('\n'));
  }
}

/**
 * A `require` that runs resolve hooks, for compiled CommonJS. The `require`
 * Node.js hands a CommonJS module an ES module imported skips them: before
 * nodejs/node#62920 (24.18.0, 26.2.0; not in Node.js 22), and on every
 * version once a `module.register` loader is in the chain too (Yarn PnP,
 * tsx through NODE_OPTIONS). Without it, `require('./helper')` from such a
 * module misses `helper.ts`, a tsconfig alias, and the helpers compiled code
 * requires from e2e's install. The loader puts the function on `globalThis`
 * when it registers (`esm-hooks.ts`): the `require` such a module starts
 * with cannot load another ES module, e2e's included.
 */
const HOOKED_REQUIRE = `require = globalThis[Symbol.for(${JSON.stringify(HOOKED_REQUIRE_KEY)})](__filename);`;

/**
 * Compiled CommonJS as Node.js can run it, read from oxc's own parse of
 * the output:
 * - Oxc keeps a file whose only imports were type-only a module by printing
 *   `export {};`, even for CommonJS, where that statement is a syntax error
 *   and TypeScript emits nothing. It is an oxc bug, not yet reported
 *   upstream (oxc 0.153.0, `crates/oxc_transformer/src/typescript/
 *   annotations.rs`, the `no_modules_remaining && some_modules_deleted`
 *   branch). The statement is blanked out, so nothing after it moves.
 * - `HOOKED_REQUIRE` follows the last directive on
 *   its line, so the prologue stays first and no mapped position moves; with
 *   no directive it takes a line of its own at the top (after a hashbang),
 *   and the source map gains an unmapped line there.
 */
function runnableCommonJs(file: string, code: string, mappings: string): { code: string; mappings: string } {
  const { program } = oxc().parser.parseSync(file, code, { lang: 'js', sourceType: 'commonjs' });
  let runnable = code;
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration === null && statement.source === null && statement.specifiers.length === 0) {
      runnable = `${runnable.slice(0, statement.start)}${' '.repeat(statement.end - statement.start)}${runnable.slice(statement.end)}`;
    }
  }
  const directives = program.body.filter((statement) => statement.type === 'ExpressionStatement' && typeof statement.directive === 'string');
  const last = directives.at(-1);
  if (last !== undefined) return { code: `${runnable.slice(0, last.end)} ${HOOKED_REQUIRE}${runnable.slice(last.end)}`, mappings };
  const line = program.hashbang === null ? 0 : 1;
  const lines = runnable.split('\n');
  lines.splice(line, 0, HOOKED_REQUIRE);
  const mappedLines = mappings.split(';');
  mappedLines.splice(line, 0, '');
  return { code: lines.join('\n'), mappings: mappedLines.join(';') };
}

/** Each helper's file in e2e's copy of `@oxc-project/runtime`, resolved once. */
const helperFiles = new Map<string, string>();

/**
 * The compiled code with each runtime helper it imports or requires taken
 * from e2e's own copy: by URL for `import`, by path for `require`. Oxc 0.153
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

/** An inline source map at the end of `source`, as another loader earlier in the chain leaves one. */
const INLINE_MAP = /\n\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)\s*$/;

/**
 * `source`, the content of `file` as the next loader handed it over,
 * compiled to JavaScript for its kind with `compilerOptions`, with an
 * inline source map. When an earlier loader already compiled the file and
 * left its own inline map, the two are composed, so positions still lead to
 * the file on disk.
 */
export function compileTypeScript(file: string, source: string, kind: CompiledExtension, compilerOptions: CompilerOptions): string {
  rejectUnsupportedSyntax(file, source, kind, compilerOptions);
  const result = oxc().transform.transformSync(file, source, {
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
  if (kind.format === 'commonjs') ({ code, mappings } = runnableCommonJs(file, code, mappings));
  // Absolute, so a frame names the file without the loader's query, whatever characters its name holds.
  const own = { version: 3 as const, mappings, names: result.map?.names ?? [], sources: [pathToFileURL(file).href] };
  const incoming = INLINE_MAP.exec(source)?.[1];
  const map = incoming === undefined ? own : remapping([own, JSON.parse(Buffer.from(incoming, 'base64').toString('utf8')) as SourceMapInput], () => null);
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
}
