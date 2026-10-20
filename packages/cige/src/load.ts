/**
 * Reads CIGE files from disk. Everything here is synchronous, because a test
 * file registers its tests while it evaluates: `cigeSuite` loads the cases
 * during collection, and the reporter loads the same globs again once the
 * run is over to read what the report alone does not carry.
 */

import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sizeProblems } from './render.ts';
import { CigeValidationError, parseCige, type CigeCase } from './schema.ts';

/** Where relative globs and paths resolve from: a directory path or a `file:` URL. */
export type CigeRoot = string | URL;

export interface LoadOptions {
  /** The directory globs resolve against; default the working directory. */
  readonly root?: CigeRoot;
}

function rootDir(root: CigeRoot | undefined): string {
  if (root === undefined) return process.cwd();
  return root instanceof URL ? fileURLToPath(root) : path.resolve(root);
}

function display(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative === '' || relative.startsWith('..') ? file : relative;
}

/** Reads, validates, and normalizes one `.cige.json` file, with its `Context.prompts` read beside it. */
export function loadCigeFile(file: string | URL): CigeCase {
  const absolute = file instanceof URL ? fileURLToPath(file) : path.resolve(file);
  const source = display(absolute);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (cause) {
    throw new CigeValidationError(source, [cause instanceof Error ? cause.message : String(cause)]);
  }
  const parsed = parseCige(raw, source);
  const fragments = parsed.context.prompts.map((prompt) => {
    const target = path.resolve(path.dirname(absolute), prompt);
    try {
      return readFileSync(target, 'utf8');
    } catch {
      throw new CigeValidationError(source, [`Context.prompts: cannot read ${JSON.stringify(prompt)} (${display(target)})`]);
    }
  });
  const testCase: CigeCase = { ...parsed, file: absolute, context: { ...parsed.context, fragments } };
  const problems = sizeProblems(testCase);
  if (problems.length > 0) throw new CigeValidationError(source, problems);
  return testCase;
}

/**
 * Loads every file the globs select, sorted by path, and refuses two cases
 * that share an id: the id is what tags the test and names its run summary.
 */
export function loadCigeCases(globs: string | readonly string[], options: LoadOptions = {}): CigeCase[] {
  const cwd = rootDir(options.root);
  const patterns = typeof globs === 'string' ? [globs] : [...globs];
  const files = [...new Set(globSync(patterns, { cwd }).map((match) => path.resolve(cwd, match)))].toSorted();
  const cases = files.map((file) => loadCigeFile(file));
  const byId = new Map<string, CigeCase>();
  for (const testCase of cases) {
    const other = byId.get(testCase.id);
    if (other !== undefined) {
      throw new CigeValidationError(display(testCase.file ?? testCase.id), [
        `id "${testCase.id}" is already the id of ${display(other.file ?? other.id)}; set a distinct "id"`,
      ]);
    }
    byId.set(testCase.id, testCase);
  }
  return cases;
}
