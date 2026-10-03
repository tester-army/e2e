/**
 * What a package's `src` may reach at runtime: a relative module, a `node:`
 * builtin, one of its `dependencies`, or a peer. A devDependency, a sibling
 * package, or a typo resolves on this checkout, where the workspace hoists
 * everything, and fails the first project to install the tarball. Optional
 * peers are stricter: `ai` is loaded lazily by one module and each
 * `@ai-sdk/*` provider by the `e2e/oauth/*` constructor that wraps it, so the
 * CLI boots (and `npx e2e init` runs) before any of them is installed, and
 * the mobile tool pack names `ai` in types only. `copilot()` loads
 * `@ai-sdk/openai` lazily too, only for the models Copilot serves over its
 * Responses API, and `opencodeConsole()` loads every SDK but
 * `@ai-sdk/openai-compatible` lazily. Type imports erase and are
 * exempt, as is the scaffold text `e2e init` writes from template literals.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

/** One package, and the modules under its `src` each optional peer may be loaded from. */
interface Scope {
  readonly dir: string;
  readonly optionalPeerHomes: Readonly<Record<string, readonly string[]>>;
}

const SCOPES: readonly Scope[] = [
  {
    dir: 'e2e',
    optionalPeerHomes: {
      ai: ['agent/ai-sdk.ts'],
      '@ai-sdk/anthropic': ['oauth/opencode-console.ts'],
      '@ai-sdk/google': ['oauth/opencode-console.ts'],
      '@ai-sdk/openai': ['oauth/chatgpt.ts', 'oauth/copilot.ts', 'oauth/opencode-console.ts'],
      '@ai-sdk/openai-compatible': ['oauth/copilot.ts', 'oauth/opencode-console.ts'],
      '@ai-sdk/xai': ['oauth/grok.ts'],
    },
  },
  { dir: 'web', optionalPeerHomes: {} },
  { dir: 'mobile', optionalPeerHomes: { ai: [] } },
  { dir: 'github', optionalPeerHomes: {} },
];

/** A block comment, a template literal, or a line comment: where an import statement is only quoted. */
const QUOTED = /\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\[\s\S])*`|\/\/.*/g;
/** A static import, re-export, or side-effect import; the clause is what sits between the keyword and `from`, absent for a side effect. */
const STATIC = /^\s*(?:import|export)\s+(type\s+)?(?:(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+)?['"]([^'"]+)['"]/gm;
/** A dynamic import, unless it sits in a `typeof import('x')` type position. */
const DYNAMIC = /(typeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function isTypeOnly(typeKeyword: string | undefined, clause: string | undefined): boolean {
  if (typeKeyword !== undefined) return true;
  if (clause === undefined) return false;
  const braced = /^\{([\s\S]*)\}$/.exec(clause);
  if (braced === null) return false;
  return braced[1]!
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== '')
    .every((specifier) => specifier.startsWith('type '));
}

interface ValueImport {
  readonly specifier: string;
  readonly text: string;
}

/** Every specifier a module loads at runtime, with the statement as written; type positions and quoted text are left out. */
function valueImports(source: string): ValueImport[] {
  const code = source.replace(QUOTED, ' ');
  const found: ValueImport[] = [];
  for (const match of code.matchAll(STATIC)) {
    if (!isTypeOnly(match[1], match[2])) found.push({ specifier: match[3]!, text: match[0].trim() });
  }
  for (const match of code.matchAll(DYNAMIC)) {
    if (match[1] === undefined) found.push({ specifier: match[2]!, text: match[0] });
  }
  return found;
}

/** The package a specifier names: its first segment, or two for a scoped package. */
function packageOf(specifier: string): string {
  const segments = specifier.split('/');
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

function sourceFiles(src: string): string[] {
  return readdirSync(src, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(src, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

function manifestOf(scope: Scope): Manifest {
  return JSON.parse(readFileSync(path.join(PACKAGES, scope.dir, 'package.json'), 'utf8')) as Manifest;
}

/** Why one runtime import in `file` is out of bounds, or undefined when the manifest covers it. */
function objection(scope: Scope, manifest: Manifest, file: string, specifier: string): string | undefined {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')) return undefined;
  const name = packageOf(specifier);
  if (builtinModules.includes(name)) return `${name} is a builtin; import it as node:${name}`;
  if (manifest.dependencies?.[name] !== undefined) return undefined;
  if (manifest.peerDependencies?.[name] === undefined) return `${name} is neither a dependency nor a peer of ${manifest.name}`;
  const homes = scope.optionalPeerHomes[name];
  if (homes === undefined || homes.includes(file)) return undefined;
  return homes.length === 0 ? `${name} is an optional peer of ${manifest.name}; import its types only` : `${name} is an optional peer of ${manifest.name}; load it from ${homes.join(', ')} only`;
}

function offenders(scope: Scope): string[] {
  const manifest = manifestOf(scope);
  const src = path.join(PACKAGES, scope.dir, 'src');
  const out: string[] = [];
  for (const file of sourceFiles(src)) {
    for (const { specifier, text } of valueImports(readFileSync(path.join(src, file), 'utf8'))) {
      const why = objection(scope, manifest, file, specifier);
      if (why !== undefined) out.push(`${scope.dir}/src/${file}: ${text} (${why})`);
    }
  }
  return out;
}

describe.each(SCOPES)('packages/$dir/src', (scope) => {
  it('loads at runtime only what its manifest declares, optional peers from their one home', () => {
    expect(offenders(scope), 'declare the dependency, or import types only').toEqual([]);
  });

  it('names where every optional peer is loaded from', () => {
    const optional = Object.entries(manifestOf(scope).peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)
      .toSorted();
    expect(Object.keys(scope.optionalPeerHomes).toSorted()).toEqual(optional);
  });
});

describe('the ai package', () => {
  it('is reached at runtime only through the lazy loader', () => {
    const loader = readFileSync(path.join(PACKAGES, 'e2e/src/agent/ai-sdk.ts'), 'utf8');
    const packages = valueImports(loader).filter((found) => !found.specifier.startsWith('.'));
    expect(packages).toEqual([{ specifier: 'ai', text: "import('ai')" }]);
  });
});

describe('the scan', () => {
  const specifiers = (source: string) => valueImports(source).map((found) => found.specifier);

  it('tells runtime imports from type imports, comments, and template text', () => {
    expect(specifiers("import { asSchema, type Tool } from 'ai';")).toEqual(['ai']);
    expect(specifiers("import ai from 'ai';\nexport * from 'ai';\nexport { tool } from 'ai';")).toEqual(['ai', 'ai', 'ai']);
    expect(specifiers("import 'tsx/esm/api';")).toEqual(['tsx/esm/api']);
    expect(specifiers("const sdk = await import('ai');")).toEqual(['ai']);
    expect(specifiers("import type { Tool } from 'ai';")).toEqual([]);
    expect(specifiers("import { type Tool, type ToolSet } from 'ai';")).toEqual([]);
    expect(specifiers("export type { Tool } from 'ai';")).toEqual([]);
    expect(specifiers("type Sdk = typeof import('ai');")).toEqual([]);
    expect(specifiers(`  import: "import { gateway } from 'ai';",`)).toEqual([]);
    expect(specifiers("`import a provider, e.g. gateway('x') from 'ai'`")).toEqual([]);
    expect(specifiers("/** Loads `ai` once: `await import('ai')`. */\nimport { slot } from './slot.ts';")).toEqual(['./slot.ts']);
    expect(specifiers("// falls back to import('ai')\nimport { z } from 'zod';")).toEqual(['zod']);
    expect(specifiers("const example = `import { test } from '@e2e-dev/web';\nimport { expect } from 'e2e';\n`;")).toEqual([]);
  });

  it('objects to a devDependency, a bare builtin, and an optional peer outside its home', () => {
    const e2e = SCOPES[0]!;
    const manifest = manifestOf(e2e);
    expect(objection(e2e, manifest, 'run/steps.ts', 'node:path')).toBeUndefined();
    expect(objection(e2e, manifest, 'run/steps.ts', '../internal/ids.ts')).toBeUndefined();
    expect(objection(e2e, manifest, 'run/steps.ts', 'commander')).toBeUndefined();
    expect(objection(e2e, manifest, 'agent/ai-sdk.ts', 'ai')).toBeUndefined();
    expect(objection(e2e, manifest, 'run/steps.ts', 'ai')).toBe('ai is an optional peer of e2e; load it from agent/ai-sdk.ts only');
    expect(objection(e2e, manifest, 'run/steps.ts', 'path')).toBe('path is a builtin; import it as node:path');
    expect(objection(e2e, manifest, 'run/steps.ts', 'playwright')).toBe('playwright is neither a dependency nor a peer of e2e');
    expect(objection(e2e, manifest, 'run/steps.ts', '@e2e-dev/web')).toBe('@e2e-dev/web is neither a dependency nor a peer of e2e');
    const mobile = SCOPES[2]!;
    expect(objection(mobile, manifestOf(mobile), 'tools.ts', 'ai')).toBe('ai is an optional peer of @e2e-dev/mobile; import its types only');
  });
});
