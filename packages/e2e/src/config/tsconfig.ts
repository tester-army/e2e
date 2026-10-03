/**
 * What the loader reads about the project besides the modules themselves:
 * the tsconfig.json that governs a file (the nearest one above it, the way
 * `tsc` finds it, with `extends` applied) and which candidate files exist.
 *
 * Both are kept with the module graph that read them, the way the graph's
 * modules are: a fresh graph (a config loaded with `graph: true`, which
 * carries `e2e-graph` on every project file) reads its tsconfig.json and
 * file lookups once, as they are when it loads. Every other load in the
 * process shares one view, whose tsconfig.json is read once (collecting
 * fifty test files reads the `extends` chain once) and whose file lookups
 * ask the disk each time, as Node.js's own resolution does, so a test file
 * imported again sees files added or removed since.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { createPathsMatcher, getTsconfig, type PathsMatcher, type TsConfigJson } from 'get-tsconfig';

export type CompilerOptions = TsConfigJson.CompilerOptions;

export interface ProjectTsconfig {
  readonly compilerOptions: CompilerOptions;
  /** The candidate files a bare specifier maps to through `paths` or `baseUrl`; null when it sets neither. */
  readonly paths: PathsMatcher | null;
}

/** The project as one module graph sees it. */
export class ProjectView {
  /** The tsconfig of each directory looked up so far; undefined where none applies. */
  private readonly byDirectory = new Map<string, ProjectTsconfig | undefined>();
  /** One entry per tsconfig file, shared by every directory under it. */
  private readonly byFile = new Map<string, ProjectTsconfig>();
  /** get-tsconfig's own cache of the files it read. */
  private readonly reads = new Map<string, unknown>();
  /** File lookups answered so far, for a graph's view; undefined where the disk is asked each time. */
  private readonly files: Map<string, boolean> | undefined;

  constructor(memoizeFiles: boolean) {
    this.files = memoizeFiles ? new Map() : undefined;
  }

  /** The tsconfig that governs `file`, or undefined when no tsconfig.json is above it. */
  tsconfigFor(file: string): ProjectTsconfig | undefined {
    const directory = path.dirname(file);
    if (this.byDirectory.has(directory)) return this.byDirectory.get(directory);
    const found = getTsconfig(directory, 'tsconfig.json', this.reads);
    let tsconfig: ProjectTsconfig | undefined;
    if (found !== null) {
      tsconfig = this.byFile.get(found.path);
      if (tsconfig === undefined) {
        tsconfig = { compilerOptions: found.config.compilerOptions ?? {}, paths: createPathsMatcher(found) };
        this.byFile.set(found.path, tsconfig);
      }
    }
    this.byDirectory.set(directory, tsconfig);
    return tsconfig;
  }

  /** Whether `file` is a regular file. */
  isFile(file: string): boolean {
    let known = this.files?.get(file);
    if (known === undefined) {
      known = statSync(file, { throwIfNoEntry: false })?.isFile() === true;
      this.files?.set(file, known);
    }
    return known;
  }
}

/** One view per graph key; the empty key is every load outside a fresh graph. */
const views = new Map<string, ProjectView>();

/** The view of the module graph `graph` names (the `e2e-graph` value of a URL), or the shared one for null. */
export function projectView(graph: string | null): ProjectView {
  const key = graph ?? '';
  let view = views.get(key);
  if (view === undefined) {
    view = new ProjectView(graph !== null);
    views.set(key, view);
  }
  return view;
}
