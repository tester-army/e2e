/** Test glob grammar. */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './errors.ts';
import { compareCodePoints } from './compare.ts';
import { escapeRegexpChar } from './regexp.ts';

interface CompiledGlob {
  readonly segments: readonly GlobSegment[];
}

/**
 * One `/`-separated part of a glob: `**`, a name matched exactly, or a
 * wildcard pattern (`*`, `?`) compiled to a regexp. Names stay names, so the
 * directory a glob starts in can be read off its segments.
 */
type GlobSegment =
  | { kind: 'globstar' }
  | { kind: 'literal'; name: string }
  | { kind: 'wildcard'; regexp: RegExp; allowsDot: boolean };

/**
 * Syntax that marks a string as a glob rather than a path: the grammar's
 * wildcards, and the forms `compileGlob` rejects with a hint (braces,
 * character classes, extglobs), so `e2e run 'tests/{a,b}.e2e.ts'` is told
 * what is wrong instead of being read as a file name.
 */
export const GLOB_SYNTAX = /[*?{}[\]]|[+@!]\(/;

/**
 * Compiles one glob string. Supported: `*` (zero or more non-`/`), `?` (one
 * non-`/`), a complete `**` segment (zero or more path segments). A leading
 * `./`, a `.` segment, and a doubled `/` are dropped. The syntax other glob
 * dialects add (braces, character classes, extglobs, a `!` anywhere but the
 * start of a glob list entry, see `compileGlobList`) and the forms that name
 * no file (an absolute path, a backslash separator, a `..` segment, a
 * trailing `/` or `.`) are `INVALID_GLOB` with a hint: taken literally each
 * would match nothing, and an empty selection is a poor way to learn that.
 */
export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length === 0) throw invalidGlob('empty glob pattern');
  if (pattern.includes('\\')) throw invalidGlob(`globs use "/" as the separator on every OS: ${pattern}`);
  if (/[{}]/.test(pattern)) {
    throw invalidGlob(`brace expansion is unsupported, list one glob per alternative: ${pattern}`);
  }
  if (/[[\]]/.test(pattern)) {
    throw invalidGlob(`character classes are unsupported, use ? or list one glob per alternative: ${pattern}`);
  }
  if (/[?*+@!]\(/.test(pattern)) {
    throw invalidGlob(`extglobs are unsupported, list one glob per alternative: ${pattern}`);
  }
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    throw invalidGlob(`globs are relative to the project root, not absolute: ${pattern}`);
  }
  const written = pattern.split('/');
  const parts = written.filter((segment) => segment !== '' && segment !== '.');
  if (parts.length === 0) {
    throw invalidGlob(`"${pattern}" is the project root, not a file pattern; add one such as **/*.e2e.ts`);
  }
  const last = written.at(-1);
  if (last === '' || last === '.') {
    throw invalidGlob(
      `a glob names files, so it cannot end with "${last === '' ? '/' : '.'}": ${pattern}; add a file pattern such as *.e2e.ts`,
    );
  }
  if (parts[0]!.startsWith('!')) {
    throw invalidGlob(`a "!" exclusion is written once, at the very start of a tests entry: ${pattern}`);
  }
  if (parts.includes('..')) {
    throw invalidGlob(`a ".." segment is not resolved in a glob: ${pattern}; write the path from the project root`);
  }
  return { segments: parts.map((segment) => compileSegment(segment, pattern)) };
}

/** A glob list split into the globs that select files and the `!`-prefixed ones that take files out again. */
export interface CompiledGlobList {
  readonly include: readonly CompiledGlob[];
  readonly exclude: readonly CompiledGlob[];
}

/**
 * Compiles a glob list in which a leading `!` marks an exclusion. A file is
 * selected when an including glob matches it and no excluding glob does,
 * whatever order the list is written in.
 */
export function compileGlobList(patterns: readonly string[]): CompiledGlobList {
  const include: CompiledGlob[] = [];
  const exclude: CompiledGlob[] = [];
  for (const pattern of patterns) {
    if (!pattern.startsWith('!')) {
      include.push(compileGlob(pattern));
      continue;
    }
    if (pattern === '!') throw invalidGlob('"!" excludes nothing; write the glob to exclude after it, such as !tests/wip/**');
    exclude.push(compileGlob(pattern.slice(1)));
  }
  return { include, exclude };
}

function invalidGlob(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_GLOB', message);
}

const WILDCARD = /[*?]/;

/** One segment as a matcher; `**` inside a name is a whole-segment `**` mistyped. */
function compileSegment(segment: string, pattern: string): GlobSegment {
  if (segment === '**') return { kind: 'globstar' };
  if (segment.includes('**')) throw invalidGlob(`'**' must be a complete path segment: ${pattern}`);
  if (!WILDCARD.test(segment)) return { kind: 'literal', name: segment };
  let source = '^';
  for (const ch of segment) {
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += escapeRegexpChar(ch);
  }
  return { kind: 'wildcard', regexp: new RegExp(`${source}$`), allowsDot: segment.startsWith('.') };
}

/** The names a glob starts with before its first wildcard or `**`: the directory a scan for it can stay inside. */
export function literalPrefix(glob: CompiledGlob): string[] {
  const names: string[] = [];
  for (const segment of glob.segments) {
    if (segment.kind !== 'literal') break;
    names.push(segment.name);
  }
  return names;
}

/**
 * Matching runs a glob as a small state machine over a path's segments. A
 * state is the index of the segment to satisfy next, `segments.length` once
 * the glob is fully matched. A `**` keeps its own index while it consumes
 * parts and also lets the segment after it start, so one step function serves
 * the matcher and the discovery walk alike: the walk carries each glob's
 * states down the tree instead of matching every directory from the root.
 */
type States = ReadonlySet<number>;

/** The states a glob starts in: its first segment, and past any leading `**`. */
function initialStates(segments: readonly GlobSegment[]): States {
  return pastGlobstars(segments, new Set([0]));
}

/** Adds, for every `**` state, the state after it: `**` matches zero parts too. Set iteration visits entries added during it. */
function pastGlobstars(segments: readonly GlobSegment[], states: Set<number>): Set<number> {
  for (const index of states) {
    if (segments[index]?.kind === 'globstar') states.add(index + 1);
  }
  return states;
}

/** The states after one more path part. A part no state accepts empties the set; a dot name needs a segment spelled with the dot. */
function advance(segments: readonly GlobSegment[], states: States, part: string): States {
  const next = new Set<number>();
  const dot = part.startsWith('.');
  for (const index of states) {
    const segment = segments[index];
    // A fully matched glob names a file; nothing follows it.
    if (segment === undefined) continue;
    switch (segment.kind) {
      case 'globstar':
        if (!dot) next.add(index);
        break;
      case 'literal':
        if (part === segment.name) next.add(index + 1);
        break;
      case 'wildcard':
        if ((segment.allowsDot || !dot) && segment.regexp.test(part)) next.add(index + 1);
        break;
    }
  }
  return pastGlobstars(segments, next);
}

/** Whether the parts consumed so far are a file the glob names. */
function isMatch(glob: CompiledGlob, states: States): boolean {
  return states.has(glob.segments.length);
}

/** Whether a file beneath the directory consumed so far could still match: a segment is left to satisfy. */
function canMatchBeneath(glob: CompiledGlob, states: States): boolean {
  for (const index of states) {
    if (index < glob.segments.length) return true;
  }
  return false;
}

/** Whether the glob sits on its trailing `**`, which matches every file beneath whose parts do not start with a dot. */
function matchesAllBeneath(glob: CompiledGlob, states: States): boolean {
  const last = glob.segments.length - 1;
  return glob.segments[last]?.kind === 'globstar' && states.has(last);
}

/** Whether a segment the glob has left to satisfy is spelled with a leading dot, so it could match a dot-named part beneath. */
function reachesDotBeneath(glob: CompiledGlob, states: States): boolean {
  for (const index of states) {
    for (const segment of glob.segments.slice(index)) {
      if (segment.kind === 'literal' ? segment.name.startsWith('.') : segment.kind === 'wildcard' && segment.allowsDot) return true;
    }
  }
  return false;
}

/** Matches one already-normalized relative path (with `/` separators). */
export function matchesGlob(glob: CompiledGlob, relativePath: string): boolean {
  let states = initialStates(glob.segments);
  for (const part of relativePath.split('/')) states = advance(glob.segments, states, part);
  return isMatch(glob, states);
}

/**
 * Discovers regular files under `root` matching any including glob and no
 * `!` exclusion. Matching is case-sensitive and results are sorted by Unicode
 * code point. The walk lists the project root and then enters a directory
 * only while some including glob has a segment left to satisfy beneath it and
 * no exclusion takes every file it could, so `tests/**\/*.e2e.ts` reads
 * `tests/` and its subdirectories and nothing else of a large repository, and
 * `!tests/wip/**` never reads `tests/wip/`; a dot directory is entered only
 * when a segment written with a leading dot matches it, and `node_modules`
 * never. Symlinks are not followed: a symlinked directory or test file is not
 * discovered.
 */
export function discoverFiles(root: string, patterns: readonly string[]): string[] {
  const { include, exclude } = compileGlobList(patterns);
  const matched: string[] = [];
  const visit = (dir: string, relativeDir: string, states: readonly States[], excluded: readonly States[]): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = include.map((glob, i) => advance(glob.segments, states[i]!, entry.name));
      const nextExcluded = exclude.map((glob, i) => advance(glob.segments, excluded[i]!, entry.name));
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isFile()) {
        if (include.some((glob, i) => isMatch(glob, next[i]!)) && !exclude.some((glob, i) => isMatch(glob, nextExcluded[i]!))) {
          matched.push(relative);
        }
      } else if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        include.some((glob, i) => canMatchBeneath(glob, next[i]!)) &&
        !(
          exclude.some((glob, i) => matchesAllBeneath(glob, nextExcluded[i]!)) &&
          !include.some((glob, i) => reachesDotBeneath(glob, next[i]!))
        )
      ) {
        visit(path.join(dir, entry.name), relative, next, nextExcluded);
      }
    }
  };
  visit(
    root,
    '',
    include.map((glob) => initialStates(glob.segments)),
    exclude.map((glob) => initialStates(glob.segments)),
  );
  return matched.toSorted(compareCodePoints);
}
