/**
 * The example files under `docs/examples/`, and the ones a page map has
 * forgotten.
 *
 * `check-docs-examples.ts` asserts that every code block a docs page or the
 * consumer skill shows from `docs/examples/` matches the file it came from,
 * but its page map was hand-kept: a new example that no page showed was never
 * read, so the check passed while the invariant ("`docs/examples/` is shown
 * verbatim on docs pages and in `skills/e2e/`", `AGENTS.md`) silently broke.
 * Deriving the file list from the filesystem, rather than trusting the map to
 * remember itself, is what `error-codes.ts` does for the source roots the
 * error reference is checked against.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './public-packages.ts';

/** The directory every example lives under, project-relative with `/` separators. */
const EXAMPLES_DIR = 'docs/examples';

/**
 * Every example file, project-relative with `/` separators, sorted: the
 * `.ts` files under `docs/examples/`, nested folders included. The
 * `tsconfig.json` beside them is not an example.
 */
export function exampleFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk(EXAMPLES_DIR);
  return files.toSorted();
}

/**
 * The examples `mapped` does not carry, by path: what the check would
 * otherwise never read. Empty when every example is a key of the page map.
 */
export function unmappedExamples(mapped: Iterable<string>): string[] {
  const known = new Set(mapped);
  return exampleFiles().filter((file) => !known.has(file));
}
