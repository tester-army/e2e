/**
 * Shared file and git reads for the release check scripts: the tag lookup,
 * the source walk and import collection, the changelog read, and the
 * pending changesets. One place, so the check scripts and their tests do
 * not each reimplement them.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseChangesetFile } from '@changesets/parse';
import { addEngineImports, engineImports, type EngineImportMap, type ImportKind } from './engine-exports.ts';
import { REPO_ROOT } from './public-packages.ts';

/** Reads `path` at `tag` (`git show`), undefined when the tag or the file does not exist. */
export function showAtTag(tag: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${tag}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** The tags matching `pattern` (`git tag --list`), empty when git cannot list them. */
export function listTags(pattern: string): string[] {
  try {
    return execFileSync('git', ['tag', '--list', pattern], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  } catch {
    return [];
  }
}

/** The TypeScript files under `dirPath`, recursively; unreadable entries are skipped. */
function sourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) out.push(full);
      } catch {
        continue;
      }
    }
  };
  walk(dirPath);
  return out;
}

/** The named `e2e` imports in a package's `src/` tree, keyed by subpath. `packagePath` is the path to the package's `package.json`. */
export function collectEngineImports(packagePath: string): EngineImportMap {
  const imports = new Map<string, Map<string, ImportKind>>();
  for (const file of sourceFiles(join(dirname(packagePath), 'src'))) {
    addEngineImports(imports, engineImports(readFileSync(file, 'utf8')));
  }
  return imports;
}

/** The CHANGELOG.md beside `packagePath`, undefined when it cannot be read. */
export function readChangelog(packagePath: string): string | undefined {
  try {
    return readFileSync(join(dirname(packagePath), 'CHANGELOG.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/** The pending changesets: every `.md` file in `.changeset` except the README, parsed. */
export function pendingChangesets(): { files: string[]; changesets: ReturnType<typeof parseChangesetFile>[] } {
  const dir = join(REPO_ROOT, '.changeset');
  const files = readdirSync(dir).filter((file) => file.endsWith('.md') && file !== 'README.md');
  return { files, changesets: files.map((file) => parseChangesetFile(readFileSync(join(dir, file), 'utf8'))) };
}
