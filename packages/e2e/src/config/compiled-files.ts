/**
 * The files e2e's loader compiles, and the one policy both of its hooks
 * follow: TypeScript and JSX are compiled wherever they are; the project's
 * tsconfig.json governs a file the project owns (outside `node_modules`),
 * while an installed package's source compiles with defaults, as its author
 * shipped it without the project's settings.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The module system a compiled file runs under. */
export type ModuleFormat = 'module' | 'commonjs';

/** What the loader knows about one compiled extension. */
export interface CompiledExtension {
  /** The syntax oxc parses. */
  readonly lang: 'ts' | 'tsx' | 'jsx';
  readonly format: ModuleFormat;
}

/** Every extension the loader compiles. */
const COMPILED: Readonly<Record<string, CompiledExtension>> = {
  '.ts': { lang: 'ts', format: 'module' },
  '.tsx': { lang: 'tsx', format: 'module' },
  '.jsx': { lang: 'jsx', format: 'module' },
  '.mts': { lang: 'ts', format: 'module' },
  '.cts': { lang: 'ts', format: 'commonjs' },
};

/** The files TypeScript tries, in order, for an import that writes each JavaScript extension. */
const WRITTEN: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.ts', '.jsx', '.js'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

/** A file inside an installed package. */
const INSTALLED = /\/node_modules\//;

/** Whether the `file:` URL `url` is the project's own, outside `node_modules`. */
export function isProjectFile(url: URL): boolean {
  return url.protocol === 'file:' && !INSTALLED.test(url.pathname);
}

/** A file the loader compiles. */
export interface CompiledSource {
  readonly file: string;
  readonly kind: CompiledExtension;
  /** Whether the project's tsconfig.json governs it; false for an installed package's source. */
  readonly project: boolean;
}

/** The compiled file `url` names, or undefined for any other module. */
export function compiledSource(url: string | undefined): CompiledSource | undefined {
  if (url?.startsWith('file:') !== true) return undefined;
  const parsed = new URL(url);
  const kind = COMPILED[path.extname(parsed.pathname)];
  return kind === undefined ? undefined : { file: fileURLToPath(parsed), kind, project: isProjectFile(parsed) };
}

/**
 * The files TypeScript tries, in order, for an import that wrote
 * `extension` (`x.ts`, `x.tsx`, `x.js`, `x.jsx` for `./x.js`). Empty for an
 * extension TypeScript does not swap.
 */
export function writtenCandidates(extension: string): readonly string[] {
  return WRITTEN[extension] ?? [];
}

/** Tried, in order, after an extensionless path and after a directory's `index`: what `./x.js` would find, then JSON. */
export const IMPLIED_EXTENSIONS: readonly string[] = [...writtenCandidates('.js'), '.json'];

/** The `globalThis` symbol key of the `require` compiled CommonJS uses where Node.js's skips resolve hooks. */
export const HOOKED_REQUIRE_KEY = 'e2e.hooked-require.v1';
