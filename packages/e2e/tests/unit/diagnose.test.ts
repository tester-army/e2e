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

  it('says an existing CommonJS-scoped TypeScript file the loader could not transform is there, and why it failed', () => {
    const pkg = path.join(dir, 'node_modules', 'dep');
    mkdirSync(path.join(pkg, 'src'), { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dep' }));
    const file = path.join(pkg, 'src', 'a.ts');
    writeFileSync(file, 'export const v = 1;');
    const cause = nodeError('MODULE_NOT_FOUND', `Cannot find module '${file}?namespace=e2e'\nRequire stack:\n- ${importer}`);
    expect(explainModuleError(cause, importer)).toContain(
      `\n${file} exists: ${path.join(pkg, 'package.json')} declares no "type": "module", so the file loads as CommonJS`,
    );
    const gone = nodeError('MODULE_NOT_FOUND', `Cannot find module '${path.join(pkg, 'src', 'b.ts')}?namespace=e2e'`);
    expect(explainModuleError(gone, importer)).toBe(gone.message);
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

  it('explains removed, misspelled, and type-only exports of e2e', () => {
    const missing = (name: string) =>
      new SyntaxError(`The requested module 'e2e' does not provide an export named '${name}'`);
    expect(explainModuleError(missing('defineConfig'), importer)).toContain(
      'defineConfig was removed in e2e 0.5: default-export the object and end it with satisfies E2EConfig',
    );
    expect(explainModuleError(missing('expct'), importer)).toContain('did you mean "expect"?');
    expect(explainModuleError(missing('E2EConfig'), importer)).toContain(
      "import type { E2EConfig } from 'e2e'",
    );
    expect(explainModuleError(missing('somethingElse'), importer)).toContain('e2e exports test, expect');
    const other = new SyntaxError("The requested module 'lodash' does not provide an export named 'nope'");
    expect(explainModuleError(other, importer)).toBe(other.message);
  });

  it('names the removal for a dropped export without a release number, never the type-only import that fails the same way', () => {
    const missing = (specifier: string, name: string) =>
      new SyntaxError(`The requested module '${specifier}' does not provide an export named '${name}'`);
    for (const name of ['BLOCKABLE_CODES', 'RUNTIME_CODES', 'buildTraceEntry', 'readTraceEntry']) {
      const explained = explainModuleError(missing('e2e', name), importer);
      expect(explained).toContain(`${name} was removed from e2e:`);
      expect(explained).not.toMatch(/\d+\.\d+/);
      expect(explained).not.toContain('import type');
    }
    for (const name of ['isDefinedTool', 'toolAppliesTo']) {
      expect(explainModuleError(missing('e2e/agent', name), importer)).toContain(`${name} was removed from e2e/agent:`);
    }
    expect(explainModuleError(missing('e2e', 'BLOCKABLE_CODES'), importer)).toBe(
      "The requested module 'e2e' does not provide an export named 'BLOCKABLE_CODES'; BLOCKABLE_CODES was removed from e2e: a blocked verdict carries any code the errors reference marks blocked, and the set was never usable outside the runner",
    );
    const unknown = missing('e2e/agent', 'somethingElse');
    expect(explainModuleError(unknown, importer)).toBe(unknown.message);
  });

  it('puts the hint on its own line after a multi-line loader message', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0', devDependencies: { ai: '^7' } }));
    const cause = nodeError(
      'ERR_MODULE_NOT_FOUND',
      `Cannot find package 'ai' imported from ${importer}\nDid you mean to import "file:///somewhere/else.js"?`,
    );
    expect(explainModuleError(cause, importer)).toBe(
      `${cause.message}\nai is declared in ${path.join(dir, 'package.json')} but is not installed: run npm install`,
    );
  });

  it('passes any other failure through unchanged', () => {
    expect(explainModuleError(new Error('boom'), importer)).toBe('boom');
    expect(explainModuleError('text', importer)).toBe('text');
  });
});
