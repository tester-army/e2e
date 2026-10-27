/**
 * Reading a repository through git, shared by `diff.ts` and the config
 * graph it runs in a child process (`config-graph.ts`). Node's type
 * stripping runs this from source in tests, so it holds to erasable
 * TypeScript.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** NUL-separated fields of `git ... -z` output: paths arrive unquoted, whatever characters they hold. */
export function fields(output: string): string[] {
  return output.split('\0').filter((field) => field !== '');
}

/**
 * A repository path on one side of the diff, by its repo-relative POSIX path:
 * a file's text, a symlink's target (undefined when it leaves the
 * repository or dangles), or undefined when neither is there.
 */
export type TreeEntry = { readonly text: string } | { readonly target: string | undefined } | undefined;
export type TreeSide = (file: string) => TreeEntry;

export function outside(file: string): boolean {
  return file === '..' || file.startsWith('../');
}

/** The repository at `commit`, read lazily: a file's text, or a symlink's target. */
export function treeAt(commit: string, top: string): TreeSide {
  // `ls-tree -r -z` records read `<mode> <type> <object>\t<path>`; mode 120000 is a symlink, whose blob is its target.
  const modes = new Map(
    fields(git(['ls-tree', '-r', '-z', commit], top)).map((record) => {
      const tab = record.indexOf('\t');
      return [record.slice(tab + 1), record.slice(0, record.indexOf(' '))] as const;
    }),
  );
  const entries = new Map<string, TreeEntry>();
  return (file) => {
    const mode = modes.get(file);
    if (mode === undefined || !(mode === '120000' || mode.startsWith('100'))) return undefined;
    if (!entries.has(file)) {
      const text = git(['show', `${commit}:${file}`], top);
      const target = mode === '120000' && !text.startsWith('/') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), text)) : undefined;
      entries.set(file, mode === '120000' ? { target: target === undefined || outside(target) ? undefined : target } : { text });
    }
    return entries.get(file);
  };
}
