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

/** Whether a segment can match a name that starts with a dot: only one spelled with the dot can. */
function spellsDot(segment: GlobSegment): boolean {
  if (segment.kind === 'literal') return segment.name.startsWith('.');
  return segment.kind === 'wildcard' && segment.allowsDot;
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

/** Matches one already-normalized relative path (with `/` separators). */
export function matchesGlob(glob: CompiledGlob, relativePath: string): boolean {
  const parts = relativePath.split('/');
  return matchFrom(glob.segments, 0, parts, 0);
}

function matchFrom(
  segments: readonly GlobSegment[],
  segmentIndex: number,
  parts: readonly string[],
  partIndex: number,
): boolean {
  if (segmentIndex === segments.length) return partIndex === parts.length;
  const segment = segments[segmentIndex]!;
  if (segment.kind === 'globstar') {
    for (let skip = 0; skip <= parts.length - partIndex; skip += 1) {
      for (let i = 0; i < skip; i += 1) {
        const part = parts[partIndex + i]!;
        if (part.startsWith('.')) return false;
      }
      if (matchFrom(segments, segmentIndex + 1, parts, partIndex + skip)) return true;
    }
    return false;
  }
  if (partIndex >= parts.length) return false;
  const part = parts[partIndex]!;
  if (segment.kind === 'literal') {
    return part === segment.name && matchFrom(segments, segmentIndex + 1, parts, partIndex + 1);
  }
  if (part.startsWith('.') && !segment.allowsDot) return false;
  if (!segment.regexp.test(part)) return false;
  return matchFrom(segments, segmentIndex + 1, parts, partIndex + 1);
}

/**
 * Discovers regular files under `root` matching any glob. Matching is
 * case-sensitive, does not follow directory symlinks, and results are sorted
 * by Unicode code point.
 */
export function discoverFiles(root: string, patterns: readonly string[]): string[] {
  const compiled = patterns.map(compileGlob);
  // No segment can match a dot directory unless it was spelled with the dot,
  // so `.git`, `.e2e`, and friends are pruned at the walk instead of being
  // read and rejected file by file.
  const visitDotDirectories = compiled.some((glob) => glob.segments.some(spellsDot));
  const matched = new Set<string>();
  walk(root, '', visitDotDirectories, (relative) => {
    if (compiled.some((glob) => matchesGlob(glob, relative))) matched.add(relative);
  });
  return [...matched].toSorted(compareCodePoints);
}

function walk(
  absoluteDir: string,
  relativeDir: string,
  visitDotDirectories: boolean,
  onFile: (relative: string) => void,
): void {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      if (!visitDotDirectories && entry.name.startsWith('.')) continue;
      walk(path.join(absoluteDir, entry.name), relative, visitDotDirectories, onFile);
    } else if (entry.isFile()) {
      onFile(relative);
    }
  }
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
