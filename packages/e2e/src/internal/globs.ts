/** Test glob grammar. */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './errors.ts';
import { escapeRegexpChar } from './regexp.ts';

interface CompiledGlob {
  /** The pattern as matched: a leading `./`, `.` segments, and doubled `/` dropped. */
  readonly pattern: string;
  readonly segments: readonly GlobSegment[];
}

type GlobSegment =
  | { kind: 'globstar' }
  | { kind: 'pattern'; regexp: RegExp; allowsDot: boolean };

/**
 * Compiles one glob string. Supported: `*` (zero or more non-`/`), `?` (one
 * non-`/`), a complete `**` segment (zero or more path segments). A leading
 * `./`, a `.` segment, and a doubled `/` are dropped. Anything else the
 * grammar lacks (braces, extglobs, `!` exclusions, `..`, a backslash, an
 * absolute path, a trailing `/`) is `INVALID_GLOB`: taken literally, each of
 * these matches nothing, and an empty selection is a poor way to learn that.
 */
export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length === 0) throw invalidGlob('empty glob pattern');
  if (pattern.startsWith('!')) throw invalidGlob(`leading '!' exclusions are unsupported: ${pattern}`);
  if (pattern.includes('\\')) throw invalidGlob(`globs use "/" as the separator on every OS: ${pattern}`);
  if (/[{}]/.test(pattern)) {
    throw invalidGlob(`brace expansion is unsupported, list one glob per alternative: ${pattern}`);
  }
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    throw invalidGlob(`globs are relative to the project root, not absolute: ${pattern}`);
  }
  if (pattern.endsWith('/')) {
    throw invalidGlob(`a glob names files, so it cannot end with "/": ${pattern}; add a file pattern such as *.e2e.ts`);
  }
  const parts = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (parts.includes('..')) throw invalidGlob(`".." is not allowed in a glob: ${pattern}`);
  if (parts.length === 0) throw invalidGlob(`the glob names no file: ${pattern}`);
  const segments = parts.map((segment): GlobSegment => {
    if (segment === '**') return { kind: 'globstar' };
    if (segment.includes('**')) throw invalidGlob(`'**' must be a complete path segment: ${pattern}`);
    return {
      kind: 'pattern',
      regexp: compileSegment(segment),
      allowsDot: segment.startsWith('.'),
    };
  });
  return { pattern: parts.join('/'), segments };
}

function invalidGlob(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_GLOB', message);
}

function compileSegment(segment: string): RegExp {
  let source = '^';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += escapeRegexpChar(ch);
  }
  return new RegExp(`${source}$`);
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
  // No pattern segment can match a dot-directory unless it was spelled with
  // a leading dot, so `.git`, `.e2e`, and friends are pruned at the walk
  // instead of being read and rejected file by file.
  const visitDotDirectories = compiled.some((glob) =>
    glob.segments.some((segment) => segment.kind === 'pattern' && segment.allowsDot),
  );
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
