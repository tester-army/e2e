import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineImportProblems, engineImports, resolveEntryExports, resolveModule, subpathEntryFile, type EngineImportCheck, type EngineImportMap, type ImportKind } from './engine-exports.ts';

describe('engineImports', () => {
  it('reads named, aliased, and type-only imports from e2e entries', () => {
    const imports = engineImports(
      `import { stepTimeout, EngineError as EngineErr, type EngineDoctorCheck } from 'e2e/engine';\nimport type { StepExecutor } from 'e2e';\nimport { test as base } from 'e2e';\n`,
    );
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
    assert.deepEqual(
      imports.get(''),
      new Map<string, ImportKind>([
        ['StepExecutor', 'type'],
        ['test', 'value'],
      ]),
    );
  });

  it('records a namespace import as unverifiable, not as names', () => {
    const imports = engineImports(`import * as engine from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
  });

  it('records a value import of a name over a type import of the same name', () => {
    const imports = engineImports(`import { type EngineError } from 'e2e/engine';\nimport { EngineError } from 'e2e/engine';\n`);
    assert.equal(imports.get('engine')?.get('EngineError'), 'value');
  });

  it('ignores comments inside import lists', () => {
    const imports = engineImports(`import { stepTimeout /* the timeout */, /* leading */ EngineError, type EngineDoctorCheck // trailing\n } from 'e2e/engine';\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
  });

  it('ignores an import in a JSDoc example', () => {
    const imports = engineImports(
      `/**\n * @example\n * import { x } from 'e2e/engine';\n */\nimport { stepTimeout } from 'e2e/engine';\n`,
    );
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['stepTimeout', 'value']]));
  });

  it('reads names re-exported from e2e entries as imports', () => {
    const imports = engineImports(`export { stepTimeout, type EngineDoctorCheck } from 'e2e/engine';\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineDoctorCheck', 'type'],
      ]),
    );
  });

  it('records a star re-export from an e2e entry as unverifiable', () => {
    const imports = engineImports(`export * from 'e2e/engine';\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
  });

  it('reads names destructured from a dynamic import', () => {
    // A `type` modifier is not valid syntax in a destructuring pattern, so
    // destructured names are values.
    const imports = engineImports(`const { stepTimeout, EngineError: err } = await import('e2e/engine');\n`);
    assert.deepEqual(
      imports.get('engine'),
      new Map<string, ImportKind>([
        ['stepTimeout', 'value'],
        ['EngineError', 'value'],
      ]),
    );
  });

  it('records a bare dynamic import as unverifiable, not as names', () => {
    const imports = engineImports(`await import('e2e/engine');\n`);
    assert.deepEqual(imports.get('engine'), new Map<string, ImportKind>([['*', 'value']]));
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
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['EngineErr', 'stepTimeout']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['Kind', 'Local', 'NodeRef']);
  });

  it('does not count a type-star re-export as a value export', () => {
    const files = new Map([
      ['src/engine/index.ts', `export type * from './contract.ts';\nexport { parseKey } from './contract.ts';\n`],
      [
        'src/engine/contract.ts',
        `export function isKeyModifier(value: unknown): boolean { return false; }\nexport function parseKey(value: string): string { return value; }\nexport type KeyModifier = 'Shift';\nexport const KEY_MODIFIERS = ['Shift'] as const;\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['parseKey']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['KeyModifier']);
  });

  it('exports only the namespace name for export star as', () => {
    const files = new Map([
      ['src/engine/index.ts', `export * as engine from './engine.ts';\n`],
      ['src/engine/engine.ts', `export function stepTimeout(): void {}\nexport class EngineError extends Error {}\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['engine']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads async functions and declare const enums as declarations', () => {
    const files = new Map([
      [
        'src/engine/index.ts',
        `export async function runCheck(): Promise<void> {}\nexport declare const enum Mode { A = 'a' }\nexport declare function helper(): void;\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['Mode', 'helper', 'runCheck']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), ['Mode']);
  });

  it('ignores a commented-out export', () => {
    const files = new Map([['src/engine/index.ts', `export function kept(): void {}\n// export function gone(): void {}\n`]]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['kept']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('reads names bound by a destructured export const', () => {
    const files = new Map([['src/collect/registry.ts', `export const { describe, beforeEach, afterEach } = test;\n`]]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/collect/registry.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['afterEach', 'beforeEach', 'describe']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('does not leak types nested inside an exported namespace', () => {
    const files = new Map([
      [
        'src/types.ts',
        `export namespace StandardSchemaV1 {\n  export interface Props { x: string }\n  export type Result = { ok: boolean };\n}\n`,
      ],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/types.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['StandardSchemaV1']);
    assert.deepEqual([...(exported?.types ?? [])].toSorted(), []);
  });

  it('ignores comments inside export lists', () => {
    const files = new Map([
      ['src/engine/index.ts', `export { stepTimeout /* the timeout */, EngineError } from './errors.ts';\n`],
      ['src/engine/errors.ts', `export function stepTimeout(): void {}\nexport class EngineError extends Error {}\n`],
    ]);
    const exported = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.deepEqual([...(exported?.values ?? [])].toSorted(), ['EngineError', 'stepTimeout']);
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
  const check = (floor: string, imports: EngineImportMap): EngineImportCheck => ({
    packageName: '@e2e-dev/web',
    packagePath: 'packages/web/package.json',
    sibling: 'e2e',
    floor,
    imports,
  });
  const exported = (values: readonly string[], types: readonly string[] = []) => ({ values: new Set(values), types: new Set(types) });
  const named = (entries: readonly (readonly [string, ImportKind])[]): EngineImportMap =>
    new Map([['engine', new Map(entries)]]);

  it('fails an import the floor version does not export', () => {
    const { problems } = engineImportProblems(
      [check('0.22.0', named([['stepTimeout', 'value'], ['EngineError', 'value']]))],
      () => exported(['EngineError']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine, but e2e@0\.22\.0 does not export it/);
  });

  it('passes when the floor version exports every import', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', named([['stepTimeout', 'value']]))],
      () => exported(['stepTimeout', 'EngineError']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
  });

  it('passes a type import satisfied by a type-only export', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['KeyModifier', 'type']]))],
      () => exported(['parseKey'], ['KeyModifier']),
    );
    assert.deepEqual(problems, []);
  });

  it('fails a value import satisfied only by a type-only export', () => {
    const { problems } = engineImportProblems(
      [check('0.23.0', named([['isKeyModifier', 'value'], ['parseKey', 'value'], ['KeyModifier', 'type']]))],
      () => exported(['parseKey'], ['KeyModifier', 'isKeyModifier']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `isKeyModifier` from e2e\/engine/);
    assert.match(problems[0]!, /does not export it/);
  });

  it('reports a floor with no tag record as unverifiable, not a problem', () => {
    const { problems, unverifiable } = engineImportProblems([check('0.15.0', named([['EngineError', 'value']]))], () => undefined);
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /cannot be verified, no tag record/);
  });

  it('reports a namespace import as unverifiable', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => exported([]),
    );
    assert.deepEqual(problems, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });

  it('still validates named imports beside a namespace import', () => {
    const { problems, unverifiable } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value'], ['stepTimeout', 'value']])]]))],
      () => exported(['EngineError']),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /imports `stepTimeout` from e2e\/engine/);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0]!, /imported as a namespace/);
  });

  it('counts only the checks verified against a tag record', () => {
    const { problems, verified } = engineImportProblems(
      [
        check('0.23.0', named([['stepTimeout', 'value']])),
        check('0.15.0', named([['EngineError', 'value']])),
      ],
      (_sibling, _subpath, version) => (version === '0.23.0' ? exported(['stepTimeout']) : undefined),
    );
    assert.deepEqual(problems, []);
    assert.equal(verified, 1);
  });

  it('does not count a namespace-only check as verified', () => {
    const { verified } = engineImportProblems(
      [check('0.23.0', new Map([['engine', new Map<string, ImportKind>([['*', 'value']])]]))],
      () => exported(['stepTimeout']),
    );
    assert.equal(verified, 0);
  });
});

describe('floor export checks with in-memory fixtures', () => {
  const exported = (values: readonly string[], types: readonly string[] = []) => ({ values: new Set(values), types: new Set(types) });

  it('verifies every import against fixture export sets for two floors', () => {
    const checks: EngineImportCheck[] = [
      {
        packageName: '@e2e-dev/web',
        packagePath: 'packages/web/package.json',
        sibling: 'e2e',
        floor: '0.23.0',
        imports: new Map([['engine', new Map<string, ImportKind>([['stepTimeout', 'value'], ['EngineDoctorCheck', 'type']])]]),
      },
      {
        packageName: '@e2e-dev/acp',
        packagePath: 'packages/acp/package.json',
        sibling: 'e2e',
        floor: '0.22.0',
        imports: new Map([['agent', new Map<string, ImportKind>([['acp', 'value']])]]),
      },
    ];
    const { problems, unverifiable, verified } = engineImportProblems(checks, (_sibling, subpath, version) =>
      subpath === 'engine' && version === '0.23.0' ? exported(['stepTimeout'], ['EngineDoctorCheck']) : exported(['acp']),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(unverifiable, []);
    assert.equal(verified, 2);
  });

  it('catches the original bug: web imports stepTimeout, which the earlier fixture entry does not export', () => {
    const earlier = new Map([
      ['src/engine/index.ts', `export { EngineError } from './errors.ts';\nexport type { NodeRef } from './contract.ts';\n`],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\n`],
    ]);
    const later = new Map([
      [
        'src/engine/index.ts',
        `export { EngineError } from './errors.ts';\nexport { stepTimeout } from './timing.ts';\nexport type { NodeRef, EngineDoctorCheck } from './contract.ts';\n`,
      ],
      ['src/engine/errors.ts', `export class EngineError extends Error {}\n`],
      ['src/engine/timing.ts', `export function stepTimeout(): void {}\n`],
      ['src/engine/contract.ts', `export type NodeRef = string;\nexport type EngineDoctorCheck = { ok: boolean };\n`],
    ]);
    const atEarlier = resolveEntryExports((path) => earlier.get(path), 'src/engine/index.ts');
    const atLater = resolveEntryExports((path) => later.get(path), 'src/engine/index.ts');
    assert.equal(atEarlier?.values.has('stepTimeout'), false);
    assert.equal(atEarlier?.types.has('EngineDoctorCheck'), false);
    assert.equal(atLater?.values.has('stepTimeout'), true);
    assert.equal(atLater?.types.has('EngineDoctorCheck'), true);
    const imports: EngineImportMap = new Map([['engine', new Map<string, ImportKind>([['stepTimeout', 'value']])]]);
    const check = (floor: string): EngineImportCheck => ({ packageName: '@e2e-dev/web', packagePath: 'packages/web/package.json', sibling: 'e2e', floor, imports });
    const { problems: earlierProblems } = engineImportProblems([check('0.22.0')], () => atEarlier);
    assert.equal(earlierProblems.length, 1);
    assert.match(earlierProblems[0]!, /imports `stepTimeout` from e2e\/engine/);
    const { problems: laterProblems } = engineImportProblems([check('0.23.0')], () => atLater);
    assert.deepEqual(laterProblems, []);
  });

  it('does not count a type-star re-export as a value export in fixture entries', () => {
    const files = new Map([
      ['src/engine/index.ts', `export type * from './contract.ts';\nexport { parseKey } from './contract.ts';\n`],
      [
        'src/engine/contract.ts',
        `export function isKeyModifier(value: unknown): boolean { return false; }\nexport function parseKey(value: string): string { return value; }\nexport type KeyModifier = 'Shift';\n`,
      ],
    ]);
    const exportedAt = resolveEntryExports((path) => files.get(path), 'src/engine/index.ts');
    assert.equal(exportedAt?.values.has('isKeyModifier'), false);
    assert.equal(exportedAt?.types.has('isKeyModifier'), false);
    assert.equal(exportedAt?.values.has('parseKey'), true);
    assert.equal(exportedAt?.types.has('KeyModifier'), true);
  });
});
