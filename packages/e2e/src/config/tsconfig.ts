/**
 * What the loader reads about the project besides the modules themselves:
 * the tsconfig.json that governs a file (the nearest one above it, the way
 * `tsc` finds it, with `extends` applied, or the project it references that
 * includes the file) and which candidate files exist.
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
import { createFilesMatcher, createPathsMatcher, findTsconfig, parseTsconfig, type FileMatcher, type PathsMatcher, type TsConfigJson } from 'get-tsconfig';

export type CompilerOptions = TsConfigJson.CompilerOptions;

export interface ProjectTsconfig {
  readonly compilerOptions: CompilerOptions;
  /** The candidate files a bare specifier maps to through `paths` or `baseUrl`; null when it sets neither. */
  readonly paths: PathsMatcher | null;
}

/** A tsconfig.json read once: its settings, and which files it includes. */
interface ReadTsconfig {
  readonly tsconfig: ProjectTsconfig;
  readonly includes: FileMatcher;
  /** The tsconfig.json files its `references` name. */
  readonly references: readonly string[];
}

/** Carries the tsconfig.json files the runner warned about to its workers, so each file is reported once per run. */
export const WARNED_TSCONFIGS_ENV = 'E2E_WARNED_TSCONFIGS';

/** The tsconfig.json files a warning was printed for: in this process, or in the runner that spawned it. */
const warned = new Set((process.env[WARNED_TSCONFIGS_ENV] ?? '').split(path.delimiter).filter((file) => file !== ''));

/** The tsconfig.json files warned about so far, as the value of `WARNED_TSCONFIGS_ENV` for a worker. */
export function warnedTsconfigs(): string {
  return [...warned].join(path.delimiter);
}

/** The tsconfig.json a project reference names: the file, or `tsconfig.json` in the directory. */
function referencedTsconfig(owner: string, reference: string): string {
  const target = path.resolve(path.dirname(owner), reference);
  return target.endsWith('.json') ? target : path.join(target, 'tsconfig.json');
}

/** The project as one module graph sees it. */
export class ProjectView {
  /** The nearest tsconfig.json of each directory looked up so far; undefined where none is above it. */
  private readonly nearest = new Map<string, string | undefined>();
  /** Each tsconfig.json read so far; undefined for one that could not be read. */
  private readonly read = new Map<string, ReadTsconfig | undefined>();
  /** get-tsconfig's own cache of the files it read. */
  private readonly reads = new Map<string, string>();
  /** File lookups answered so far, for a graph's view; undefined where the disk is asked each time. */
  private readonly files: Map<string, boolean> | undefined;

  constructor(memoizeFiles: boolean) {
    this.files = memoizeFiles ? new Map() : undefined;
  }

  /**
   * The tsconfig that governs `file`, or undefined when no readable
   * tsconfig.json is above it. A solution-style tsconfig.json (`files: []`
   * and `references`, as Vite writes) hands a file to the referenced
   * tsconfig that includes it, the way TypeScript's editor support does.
   */
  tsconfigFor(file: string): ProjectTsconfig | undefined {
    const directory = path.dirname(file);
    if (!this.nearest.has(directory)) this.nearest.set(directory, findTsconfig(directory, 'tsconfig.json', this.reads));
    const nearest = this.nearest.get(directory);
    const root = nearest === undefined ? undefined : this.readTsconfig(nearest);
    if (root === undefined || root.references.length === 0 || root.includes(file) !== undefined) return root?.tsconfig;
    const visited = new Set([nearest]);
    const find = (references: readonly string[]): ProjectTsconfig | undefined => {
      for (const reference of references) {
        if (visited.has(reference)) continue;
        visited.add(reference);
        const referenced = this.readTsconfig(reference);
        if (referenced === undefined) continue;
        if (referenced.includes(file) !== undefined) return referenced.tsconfig;
        const nested = find(referenced.references);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    return find(root.references) ?? root.tsconfig;
  }

  /**
   * `tsconfigPath` read with its `extends` chain, or undefined when it
   * cannot be, with a warning: an `extends` naming a package that is not
   * installed (`@tsconfig/node22`) should not stop a run, so TypeScript
   * compiles with default settings and no `paths` instead.
   */
  private readTsconfig(tsconfigPath: string): ReadTsconfig | undefined {
    if (this.read.has(tsconfigPath)) return this.read.get(tsconfigPath);
    let read: ReadTsconfig | undefined;
    try {
      const result = { path: tsconfigPath, config: parseTsconfig(tsconfigPath, this.reads) };
      read = {
        tsconfig: { compilerOptions: result.config.compilerOptions ?? {}, paths: createPathsMatcher(result) },
        includes: createFilesMatcher(result),
        references: (result.config.references ?? []).map((reference) => referencedTsconfig(tsconfigPath, reference.path)),
      };
    } catch (cause) {
      if (!warned.has(tsconfigPath)) {
        warned.add(tsconfigPath);
        const reason = cause instanceof Error ? cause.message : String(cause);
        process.emitWarning(`e2e ignores ${tsconfigPath}, which it cannot read (${reason}): TypeScript compiles with default settings and no paths`);
      }
    }
    this.read.set(tsconfigPath, read);
    return read;
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
