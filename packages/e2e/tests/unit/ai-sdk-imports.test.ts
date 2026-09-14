/**
 * `ai` is an optional peer dependency, and the CLI loads most of `src` for
 * every command. A static value import of it anywhere but the loader turns a
 * missing package into a module-resolution crash before argv is parsed, which
 * is what `npx e2e init` in a fresh project hits: it runs before `ai` is
 * installed. Type imports erase and are fine; anything that needs the SDK at
 * runtime goes through `loadAiSdk()`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const LOADER = 'agent/ai-sdk.ts';

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

/** The value imports of `ai` in one module's source, as written. */
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(SRC, path.join(entry.parentPath, entry.name)));
}

describe('the ai package', () => {
  it('is reached at runtime only through the lazy loader', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === LOADER) continue;
      for (const found of valueImportsOfAi(readFileSync(path.join(SRC, file), 'utf8'))) {
        offenders.push(`${file}: ${found}`);
      }
    }
    expect(offenders, 'route runtime uses of the AI SDK through loadAiSdk()').toEqual([]);
  });

  it('is told apart from type imports and from prose that mentions it', () => {
    expect(valueImportsOfAi("import { asSchema, type Tool } from 'ai';")).toEqual(["import { asSchema, type Tool } from 'ai'"]);
    expect(valueImportsOfAi("import ai from 'ai';\nexport * from 'ai';")).toHaveLength(2);
    expect(valueImportsOfAi("const sdk = await import('ai');")).toEqual(["import('ai')"]);
    expect(valueImportsOfAi("import type { Tool } from 'ai';")).toEqual([]);
    expect(valueImportsOfAi("import { type Tool, type ToolSet } from 'ai';")).toEqual([]);
    expect(valueImportsOfAi("type Sdk = typeof import('ai');")).toEqual([]);
    expect(valueImportsOfAi(`  import: "import { gateway } from 'ai';",`)).toEqual([]);
    expect(valueImportsOfAi("`import a provider, e.g. gateway('x') from 'ai'`")).toEqual([]);
  });
});
