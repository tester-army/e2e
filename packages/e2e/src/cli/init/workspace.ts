/** Where `e2e init` sits relative to the surrounding monorepo workspace, for its placement hints. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, matchesGlob } from '../../internal/globs.ts';

export interface Workspace {
  /** The directory holding the workspace file. */
  readonly root: string;
  /** Which file declared the members, for the hint that names it. */
  readonly file: 'pnpm-workspace.yaml' | 'package.json';
  /** Member globs as written, a leading `!` marking an exclusion. */
  readonly patterns: readonly string[];
}

const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';
const PACKAGE_FILE = 'package.json';

/**
 * Reads the `packages:` list of a `pnpm-workspace.yaml` without a YAML
 * parser: the items are the `- ` lines under that key, quotes and trailing
 * comments dropped. Anything else in the file is ignored, and a shape this
 * reader does not understand (a flow list with items, a missing key) yields
 * `undefined` so init says nothing rather than something wrong.
 */
export function parsePnpmWorkspace(content: string): readonly string[] | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('packages:'));
  if (start === -1) return undefined;
  const inline = lines[start]!.slice('packages:'.length).replace(/\s+#.*$/, '').trim();
  if (inline === '[]') return [];
  if (inline !== '') return undefined;
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '-') return undefined;
    if (!trimmed.startsWith('- ')) break;
    const item = stripQuotes(trimmed.slice(2).replace(/\s+#.*$/, '').trim());
    if (item === '') return undefined;
    patterns.push(item);
  }
  // A bare `packages:` with no sequence under it is not an empty list, it is a shape this reader does not know.
  return patterns.length === 0 ? undefined : patterns;
}

/**
 * Reads the `workspaces` field of a `package.json`: an array of globs (npm,
 * yarn, bun) or the object form with a `packages` array (yarn 1). A manifest
 * without the field, or one that does not parse, declares no workspace.
 */
export function parsePackageWorkspaces(content: string): readonly string[] | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const field = (manifest as { workspaces?: unknown }).workspaces;
  const list = Array.isArray(field) ? field : (field as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) return undefined;
  return list;
}

/**
 * Whether `relativeDir` (`/`-separated, relative to the workspace root) is a
 * member: matched by an include pattern and by no `!` exclusion. Workspace
 * globs may use braces, character classes, and extglobs, which the runner's
 * glob grammar does not read; one such pattern (or one the grammar rejects)
 * makes the answer `undefined`, since a verdict on a list this cannot read
 * would sometimes be a confident, wrong warning.
 */
export function isWorkspaceMember(patterns: readonly string[], relativeDir: string): boolean | undefined {
  let included = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith('!');
    const glob = excluded ? pattern.slice(1) : pattern;
    if (/[{[(]/.test(glob)) return undefined;
    let compiled;
    try {
      compiled = compileGlob(glob);
    } catch {
      return undefined;
    }
    if (!matchesGlob(compiled, relativeDir)) continue;
    if (excluded) return false;
    included = true;
  }
  return included;
}

/**
 * The nearest workspace at or above `dir`: `pnpm-workspace.yaml` wins over a
 * `package.json` with `workspaces` in the same directory. The walk stops at
 * the first `pnpm-workspace.yaml` even when it cannot be read, since an outer
 * workspace has nothing to say about a directory that file governs.
 */
export function findWorkspace(dir: string): Workspace | undefined {
  let current = dir;
  for (;;) {
    const pnpmFile = path.join(current, PNPM_WORKSPACE_FILE);
    if (existsSync(pnpmFile)) {
      const content = readText(pnpmFile);
      const patterns = content === undefined ? undefined : parsePnpmWorkspace(content);
      return patterns === undefined ? undefined : { root: current, file: PNPM_WORKSPACE_FILE, patterns };
    }
    const packageFile = path.join(current, PACKAGE_FILE);
    if (existsSync(packageFile)) {
      const content = readText(packageFile);
      if (content === undefined) return undefined;
      const patterns = parsePackageWorkspaces(content);
      if (patterns !== undefined) return { root: current, file: PACKAGE_FILE, patterns };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A file's text, or `undefined` when it cannot be read (a directory by that name, no permission). */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1);
  }
  return value;
}
