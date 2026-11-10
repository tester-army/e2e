import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { engineImportProblems, engineImports, resolveEntryExports, resolveModule, subpathEntryFile, tagExportsAt, type EngineImportCheck } from './engine-exports.ts';
import { peerFloor } from './peer-ranges.ts';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

/** Reads `path` at `tag` (`git show`), undefined when the tag or the file does not exist. */
function showAtTag(tag: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${tag}:${path}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** The TypeScript files under `dirPath`, recursively. */
function sourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) out.push(full);
    }
  };
  walk(dirPath);
  return out;
}

describe('engineImports', () => {
  it('reads named, aliased, and type-only imports from e2e entries', () => {
    const imports = engineImports(
      `import { stepTimeout, EngineError as EngineErr, type EngineDoctorCheck } from 'e2e/engine';\nimport type { StepExecutor } from 'e2e';\nimport { test as base } from 'e2e';\n`,
    );
    assert.deepEqual(imports.get('engine'), new Set(['stepTimeout', 'EngineError', 'EngineDoctorCheck']));
    assert.deepEqual(imports.get(''), new Set(['StepExecutor', 'test']));
  });

  it('records a namespace import as unverifiable, not as names', () => {
    const imports = engineImports(`import * as engine from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Set(['*']));
  });

  it('ignores imports from other packages', () => {
    assert.equal(engineImports(`import { z } from 'zod';\n`).size, 0);
  });
});

describe('exportedNames and resolveEntryExports', () => {
  it('reads named exports, aliases, declarations, and export-star chains', () => {
    const files = new Map([
      [
        'src/engine/index.ts',
        `export { stepTimeout } from './timing.ts';\nexport { EngineError as EngineErr } from './errors.ts';\nexport type * from './contract.ts';\nexport interface Local { x: string }\n`,
      ],
      ['src/engine/timing.ts', `export function stepTimeout(): void {}\n`],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\nexport * from './kinds.ts';\n`],
      ['src/engine/kinds.ts', `export type Kind = 'a';\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported ?? [])].toSorted(), ['EngineErr', 'Kind', 'Local', 'NodeRef', 'stepTimeout']);
  });

  it('answers undefined when an entry file cannot be read', () => {
    assert.equal(resolveEntryExports(() => undefined, 'src/engine/index.ts'), undefined);
  });

  it('resolves relative module specifiers', () => {
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', '../internal/time.ts'), 'packages/e2e/src/internal/time.ts');
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', './contract.ts'), 'packages/e2e/src/engine/contract.ts');
    assert.equal(resolveModule('packages/e2e/src/engine/index.ts', 'zod'), undefined);
  });

  it('reads the entry file off a sibling package.json', () => {
    const packageJson = JSON.stringify({ exports: { './engine': { types: './dist/engine/index.d.ts', default: './dist/engine/index.js' } } });
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'engine'), 'packages/e2e/src/engine/index.ts');
    assert.equal(subpathEntryFile('not json', 'packages/e2e', 'engine'), undefined);
    assert.equal(subpathEntryFile(packageJson, 'packages/e2e', 'missing'), undefined);
  });
});

describe('engineImportProblems', () => {
  const check = (floor: string, imports: Map<string, Set<string>>): EngineImportCheck => ({
    packageName: '@e2e-dev/web',
    packagePath: 'packages/web/package.json',
    sibling: 'e2e',
    floor,
    imports,
  });

  it('fails an import the floor version does not export', () => {
    const exported = new Set(['EngineError']);
    const { problems } = engineImportProblems([check('0.22.0', new Map([['engine', new Set(['stepTimeout', 'EngineError'])]]))], () => exported);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine, but e2e@0\.22\.0 does not export it/);
  });

  it('passes when the floor version exports every import', () => {
    const exported = new Set(['stepTimeout', 'EngineError']);
    const { problems, unverifiable } = engineImportProblems([check('0.23.0', new Map([['engine', new Set(['stepTimeout'])]]))], () => exported);
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
  });

  it('reports a floor with no tag record as unverifiable, not a problem', () => {
    const { problems, unverifiable } = engineImportProblems([check('0.15.0', new Map([['engine', new Set(['EngineError'])]]))], () => undefined);
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /cannot be verified, no tag record/);
  });

  it('reports a namespace import as unverifiable', () => {
    const { problems, unverifiable } = engineImportProblems([check('0.23.0', new Map([['engine', new Set(['*'])]]))], () => new Set());
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });
});

describe('imports at their floors on this repo', () => {
  it('has every e2e import exported at the package floor version (#1657)', () => {
    const checks: EngineImportCheck[] = [];
    for (const { path, manifest } of publicPackages()) {
      const range = manifest.peerDependencies?.['e2e'];
      if (range === undefined) continue;
      const floor = peerFloor(range);
      if (floor === undefined) continue;
      const imports = new Map<string, Set<string>>();
      for (const file of sourceFiles(join(dirname(path), 'src'))) {
        for (const [subpath, names] of engineImports(readFileSync(file, 'utf8'))) {
          let set = imports.get(subpath);
          if (set === undefined) {
            set = new Set<string>();
            imports.set(subpath, set);
          }
          for (const name of names) set.add(name);
        }
      }
      if (imports.size === 0) continue;
      checks.push({ packageName: manifest.name, packagePath: relative(REPO_ROOT, path), sibling: 'e2e', floor, imports });
    }
    const siblingDirs = new Map(publicPackages().map(({ manifest, path }) => [manifest.name, relative(REPO_ROOT, dirname(path))]));
    const { problems } = engineImportProblems(checks, (sibling, subpath, version) => {
      const siblingDir = siblingDirs.get(sibling);
      if (siblingDir === undefined) return undefined;
      return tagExportsAt(showAtTag, `${sibling}@${version}`, siblingDir, subpath);
    });
    assert.deepEqual(problems, []);
  });

  it('catches the original bug: web imports stepTimeout, which e2e@0.22.0 does not export', () => {
    const exported = tagExportsAt(showAtTag, 'e2e@0.22.0', 'packages/e2e', 'engine');
    assert.equal(exported?.has('stepTimeout'), false);
    assert.equal(exported?.has('EngineDoctorCheck'), false);
    const atNext = tagExportsAt(showAtTag, 'e2e@0.23.0', 'packages/e2e', 'engine');
    assert.equal(atNext?.has('stepTimeout'), true);
    assert.equal(atNext?.has('EngineDoctorCheck'), true);
  });
});
