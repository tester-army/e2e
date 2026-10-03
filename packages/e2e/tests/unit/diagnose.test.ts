import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainModuleError, RUNTIME_EXPORTS } from '../../src/config/diagnose.ts';

let dir: string;
let importer: string;

/** A loader failure as Node raises it: an Error carrying a `code`. */
function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-diagnose-'));
  importer = path.join(dir, 'e2e.config.ts');
  writeFileSync(importer, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('explainModuleError', () => {
  it('lists the runtime exports of e2e exactly', async () => {
    const module = await import('../../src/index.ts');
    expect([...RUNTIME_EXPORTS].toSorted()).toEqual(Object.keys(module).toSorted());
  });

  it('tells a declared-but-uninstalled package apart from a missing one, naming the manager', () => {
    const cause = nodeError('ERR_MODULE_NOT_FOUND', `Cannot find package 'e2e' imported from ${importer}`);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'e2e': '^0.5.0' } }));
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(explainModuleError(cause, importer)).toBe(
      `Cannot find package 'e2e' imported from ${importer}; e2e is declared in ${path.join(dir, 'package.json')} but is not installed: run pnpm install`,
    );

    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.0.0' }));
    const subpath = nodeError('ERR_MODULE_NOT_FOUND', `Cannot find package '@e2e-dev/web/extra' imported from ${importer}`);
    expect(explainModuleError(subpath, importer)).toContain('; add it to the project: bun add -d @e2e-dev/web');
  });

  it('leaves relative and absolute module paths to the loader message', () => {
    const cause = nodeError('ERR_MODULE_NOT_FOUND', `Cannot find module '${path.join(dir, 'helpers.js')}' imported from ${importer}`);
    expect(explainModuleError(cause, importer)).toBe(cause.message);
  });

  it('lists the subpaths a package exports and suggests the closest one', () => {
    const manifestDir = path.join(dir, 'node_modules', 'e2e');
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, 'package.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'e2e', exports: { '.': './dist/index.js', './agent': './dist/agent.js', './engine': './dist/engine.js' } }),
    );
    const cause = nodeError(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `Package subpath './agnet' is not defined by "exports" in ${manifestPath} imported from ${importer}`,
    );
    expect(explainModuleError(cause, importer)).toBe(
      `${cause.message}; e2e exports e2e, e2e/agent, e2e/engine; did you mean "e2e/agent"?`,
    );
  });

  it('names the importing line and the import type fix for a type imported as a value', () => {
    const cause = new SyntaxError("The requested module './types' does not provide an export named 'Options'");
    cause.stack = `${path.join(dir, 'svc.ts')}:1\nimport { Options } from './types';\n         ^\nSyntaxError: ${cause.message}`;
    expect(explainModuleError(cause, importer)).toBe(
      `The requested module './types' does not provide an export named 'Options' (${path.join(dir, 'svc.ts')}:1); if Options is a type (an interface or a type alias), import it with import type { Options }: e2e compiles each file on its own, without type information, so an import of a type has to say so, as under TypeScript's isolatedModules; with emitDecoratorMetadata, the same holds for a type a decorated member's annotation names`,
    );
  });

  it('explains removed, misspelled, and type-only exports, and passes an unknown name through', () => {
    const missing = (specifier: string, name: string) =>
      new SyntaxError(`The requested module '${specifier}' does not provide an export named '${name}'`);
    const removed = explainModuleError(missing('e2e/agent', 'createAgent'), importer);
    expect(removed).toContain('createAgent was removed from e2e/agent:');
    expect(removed).toContain('agents: { default: { model, system, tools } }');
    expect(removed).not.toContain('import type');
    expect(explainModuleError(missing('e2e', 'expct'), importer)).toContain('did you mean "expect"?');
    expect(explainModuleError(missing('e2e', 'E2EConfig'), importer)).toContain("import type { E2EConfig } from 'e2e'");
    const unknown = missing('e2e/agent', 'somethingElse');
    expect(explainModuleError(unknown, importer)).toBe(unknown.message);
    const other = missing('lodash', 'nope');
    expect(explainModuleError(other, importer)).toBe(other.message);
  });

  it('passes any other failure through unchanged', () => {
    expect(explainModuleError(new Error('boom'), importer)).toBe('boom');
    expect(explainModuleError('text', importer)).toBe('text');
  });
});
