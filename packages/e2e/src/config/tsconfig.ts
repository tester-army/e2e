/**
 * The tsconfig.json that governs a project file: the nearest one above it,
 * the way `tsc` finds it, with `extends` applied. The loader reads its
 * `paths` and `baseUrl` to resolve imports, and the compiler options that
 * change what a transform emits (JSX, decorators, class fields, import
 * elision).
 */

import path from 'node:path';
import { createPathsMatcher, getTsconfig, type PathsMatcher, type TsConfigJson } from 'get-tsconfig';

export type CompilerOptions = TsConfigJson.CompilerOptions;

export interface ProjectTsconfig {
  readonly compilerOptions: CompilerOptions;
  /** The candidate files a bare specifier maps to through `paths` or `baseUrl`; null when it sets neither. */
  readonly paths: PathsMatcher | null;
}

/** The tsconfig of each directory looked up so far, by directory; undefined where none applies. */
let byDirectory = new Map<string, ProjectTsconfig | undefined>();
/** One entry per tsconfig file, shared by every directory under it. */
let byFile = new Map<string, ProjectTsconfig>();
/** get-tsconfig's own cache of the files it read. */
let reads = new Map<string, unknown>();

/** The tsconfig that governs `file`, or undefined when no tsconfig.json is above it. */
export function tsconfigFor(file: string): ProjectTsconfig | undefined {
  const directory = path.dirname(file);
  if (byDirectory.has(directory)) return byDirectory.get(directory);
  const found = getTsconfig(directory, 'tsconfig.json', reads);
  let tsconfig: ProjectTsconfig | undefined;
  if (found !== null) {
    tsconfig = byFile.get(found.path);
    if (tsconfig === undefined) {
      tsconfig = { compilerOptions: found.config.compilerOptions ?? {}, paths: createPathsMatcher(found) };
      byFile.set(found.path, tsconfig);
    }
  }
  byDirectory.set(directory, tsconfig);
  return tsconfig;
}

/** Drops every tsconfig read so far, so the next lookup sees the files as they are now. */
export function forgetTsconfigs(): void {
  byDirectory = new Map();
  byFile = new Map();
  reads = new Map();
}
