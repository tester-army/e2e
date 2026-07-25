/** Test glob grammar per 05-config.md. */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from './errors.js';

interface CompiledGlob {
  readonly segments: readonly GlobSegment[];
}

type GlobSegment =
  | { kind: 'globstar' }
  | { kind: 'pattern'; regexp: RegExp; allowsDot: boolean };

/**
 * Compiles one glob string. Supported: `*` (zero or more non-`/`), `?` (one
 * non-`/`), a complete `**` segment (zero or more path segments). Braces,
 * extglobs, and `!` exclusions are unsupported.
 */
export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length === 0) throw new ConfigurationError('INVALID_GLOB', 'empty glob pattern');
  if (pattern.startsWith('!')) {
    throw new ConfigurationError('INVALID_GLOB', `leading '!' exclusions are unsupported: ${pattern}`);
  }
  const segments = pattern.split('/').map((segment): GlobSegment => {
    if (segment === '**') return { kind: 'globstar' };
    if (segment.includes('**')) {
      throw new ConfigurationError(
        'INVALID_GLOB',
        `'**' must be a complete path segment: ${pattern}`,
      );
    }
    return {
      kind: 'pattern',
      regexp: compileSegment(segment),
      allowsDot: segment.startsWith('.'),
    };
  });
  return { segments };
}

function compileSegment(segment: string): RegExp {
  let source = '^';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += escapeRegexp(ch);
  }
  return new RegExp(`${source}$`);
}

function escapeRegexp(ch: string): string {
  return /[a-zA-Z0-9_\-]/.test(ch) ? ch : `\\${ch}`;
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
  const matched = new Set<string>();
  walk(root, '', (relative) => {
    if (compiled.some((glob) => matchesGlob(glob, relative))) matched.add(relative);
  });
  return [...matched].sort(compareCodePoints);
}

function walk(absoluteDir: string, relativeDir: string, onFile: (relative: string) => void): void {
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
      walk(path.join(absoluteDir, entry.name), relative, onFile);
    } else if (entry.isFile()) {
      onFile(relative);
    }
  }
}

/** Sorts strings by Unicode code point as required by 11-lifecycle.md. */
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
