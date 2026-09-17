/** Test glob grammar. */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './errors.ts';
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
 * dialects add (braces, character classes, extglobs, a leading `!`) and the
 * forms that name no file (an absolute path, a backslash separator, a `..`
 * segment, a trailing `/` or `.`) are `INVALID_GLOB` with a hint: taken
 * literally each would match nothing, and an empty selection is a poor way
 * to learn that.
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
    throw invalidGlob(`leading "!" exclusions are unsupported, narrow the glob instead: ${pattern}`);
  }
  if (parts.includes('..')) {
    throw invalidGlob(`a ".." segment is not resolved in a glob: ${pattern}; write the path from the project root`);
  }
  return { segments: parts.map((segment) => compileSegment(segment, pattern)) };
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

/** Matches one already-normalized relative path (with `/` separators). */
export function matchesGlob(glob: CompiledGlob, relativePath: string): boolean {
  let states = initialStates(glob.segments);
  for (const part of relativePath.split('/')) states = advance(glob.segments, states, part);
  return isMatch(glob, states);
}

/**
 * Discovers regular files under `root` matching any glob. Matching is
 * case-sensitive and results are sorted by Unicode code point. The walk lists
 * the project root and then enters a directory only while some glob has a
 * segment left to satisfy beneath it, so `tests/**\/*.e2e.ts` reads `tests/`
 * and its subdirectories and nothing else of a large repository; a dot
 * directory is entered only when a segment written with a leading dot matches
 * it, and `node_modules` never. Symlinks are not followed: a symlinked
 * directory or test file is not discovered.
 */
export function discoverFiles(root: string, patterns: readonly string[]): string[] {
  const globs = patterns.map(compileGlob);
  const matched: string[] = [];
  const visit = (dir: string, relativeDir: string, states: readonly States[]): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = globs.map((glob, i) => advance(glob.segments, states[i]!, entry.name));
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isFile()) {
        if (globs.some((glob, i) => isMatch(glob, next[i]!))) matched.push(relative);
      } else if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        globs.some((glob, i) => canMatchBeneath(glob, next[i]!))
      ) {
        visit(path.join(dir, entry.name), relative, next);
      }
    }
  };
  visit(root, '', globs.map((glob) => initialStates(glob.segments)));
  return matched.toSorted(compareCodePoints);
}

/** Sorts strings by Unicode code point, the order collection is defined in. */
export function compareCodePoints(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const length = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < length; i += 1) {
    const diff = aPoints[i]!.codePointAt(0)! - bPoints[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}
