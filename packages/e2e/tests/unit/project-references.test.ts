/** Nested solution references select the project that owns a source file. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectView } from '../../src/config/tsconfig.ts';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'e2e-project-references-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function write(file: string, content: object): void { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(content)); }
describe('nested solution references', () => {
  it('uses a transitively referenced project’s alias settings', () => {
    write('tsconfig.json', { files: [], references: [{ path: 'configs/solution.json' }] });
    write('configs/solution.json', { files: [], references: [{ path: 'app.json' }] });
    write('configs/app.json', { compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['lib/*'] } }, include: ['../tests/*.ts'] });
    const selected = new ProjectView(false).tsconfigFor(path.join(root, 'tests/example.ts'));
    expect(selected?.paths?.('@lib/helper')).toEqual([path.join(root, 'lib/helper')]);
  });
  it('skips reference cycles and retains root settings if no project includes the file', () => {
    write('tsconfig.json', { files: [], compilerOptions: { strict: true }, references: [{ path: 'configs/solution.json' }] });
    write('configs/solution.json', { files: [], references: [{ path: '../tsconfig.json' }] });
    expect(new ProjectView(false).tsconfigFor(path.join(root, 'unmatched.ts'))?.compilerOptions.strict).toBe(true);
  });
  it('preserves direct reference order and the nearest owning config', () => {
    write('tsconfig.json', { files: [], references: [{ path: 'configs/first.json' }, { path: 'configs/second.json' }] });
    write('configs/first.json', { compilerOptions: { strict: true }, include: ['../tests/*.ts'] });
    write('configs/second.json', { compilerOptions: { strict: false }, include: ['../tests/*.ts'] });
    const view = new ProjectView(false);
    expect(view.tsconfigFor(path.join(root, 'tests/example.ts'))?.compilerOptions.strict).toBe(true);
    write('tests/tsconfig.json', { compilerOptions: { strict: false }, include: ['*.ts'] });
    expect(new ProjectView(false).tsconfigFor(path.join(root, 'tests/example.ts'))?.compilerOptions.strict).toBe(false);
  });
});
