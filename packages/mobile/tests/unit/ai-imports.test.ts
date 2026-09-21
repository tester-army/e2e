/**
 * `ai` is an optional peer dependency, and `@e2edev/mobile/tools` loads
 * with the project's config. A value import of the package anywhere in `src`
 * turns a project without it into a module-resolution crash at config load;
 * type imports erase and are fine, and the tool pack needs nothing else.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** A top-level static import or re-export from `ai`: the clause is what sits between the keyword and `from`. */
const STATIC = /^\s*(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]ai(?:\/[^'"]*)?['"]/gm;
/** A dynamic import of `ai`, unless it sits in a `typeof import('ai')` type position. */
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]ai(?:\/[^'"]*)?['"]\s*\)/g;

function isTypeOnly(typeKeyword: string | undefined, clause: string): boolean {
  if (typeKeyword !== undefined) return true;
  const braced = /^\{([\s\S]*)\}$/.exec(clause);
  if (braced === null) return false;
  return braced[1]!
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== '')
    .every((specifier) => specifier.startsWith('type '));
}

function valueImportsOfAi(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STATIC)) {
    if (!isTypeOnly(match[1], match[2]!)) found.push(match[0].trim());
  }
  for (const match of source.matchAll(DYNAMIC)) {
    if (match[1] === undefined) found.push(match[0]);
  }
  return found;
}

describe('the ai package', () => {
  it('is never imported at run time', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = path.join(entry.parentPath, entry.name);
      for (const found of valueImportsOfAi(readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC, file)}: ${found}`);
      }
    }
    expect(offenders, 'import only types from ai; the engine must load without it').toEqual([]);
  });

  it('is told apart from type imports', () => {
    expect(valueImportsOfAi("import { tool } from 'ai';")).toEqual(["import { tool } from 'ai'"]);
    expect(valueImportsOfAi("const sdk = await import('ai');")).toEqual(["import('ai')"]);
    expect(valueImportsOfAi("import type { Tool } from 'ai';")).toEqual([]);
    expect(valueImportsOfAi("import { type Tool, type ToolSet } from 'ai';")).toEqual([]);
    expect(valueImportsOfAi("type Sdk = typeof import('ai');")).toEqual([]);
  });
});
