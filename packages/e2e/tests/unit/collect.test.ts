import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relativeToRoot, selectPositionals } from '../../src/collect/collect.ts';

// What the config globs discovered, in discovery order. `tests/agent/notes.md`
// exists on disk but is not in this list: positionals only narrow it.
const DISCOVERED = [
  'tests/a.e2e.ts',
  'tests/agent/b.e2e.ts',
  'tests/agent/nested/c.e2e.ts',
  'tests/other/d.e2e.ts',
];

let root: string;
// Windows and default macOS volumes resolve `tests/Agent` to `tests/agent`;
// Linux does not. The casing tests assert the behavior the host actually has.
let caseInsensitiveFs = false;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'e2e-collect-'));
  for (const file of [...DISCOVERED, 'tests/agent/notes.md']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  caseInsensitiveFs = existsSync(path.join(root, 'tests', 'Agent'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('selectPositionals', () => {
  it('keeps every discovered file when there are no positionals', () => {
    expect(selectPositionals(root, DISCOVERED, [])).toEqual({ files: DISCOVERED, unmatched: [] });
  });

  it('matches a file path exactly, relative or absolute', () => {
    expect(selectPositionals(root, DISCOVERED, ['tests/a.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['./tests/a.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, [path.join(root, 'tests', 'a.e2e.ts')]).files).toEqual([
      'tests/a.e2e.ts',
    ]);
  });

  it('matches every discovered file beneath a directory', () => {
    const expected = ['tests/agent/b.e2e.ts', 'tests/agent/nested/c.e2e.ts'];
    expect(selectPositionals(root, DISCOVERED, ['tests/agent']).files).toEqual(expected);
    expect(selectPositionals(root, DISCOVERED, ['tests/agent/']).files).toEqual(expected);
    expect(selectPositionals(root, DISCOVERED, ['./tests/agent']).files).toEqual(expected);
    expect(selectPositionals(root, DISCOVERED, ['.']).files).toEqual(DISCOVERED);
  });

  it('never selects a file the config globs did not discover', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/agent', 'tests/agent/notes.md']);
    expect(selection.files).toEqual(['tests/agent/b.e2e.ts', 'tests/agent/nested/c.e2e.ts']);
    expect(selection.unmatched).toEqual(['tests/agent/notes.md']);
  });

  it('matches a glob against the discovered files with the config grammar', () => {
    expect(selectPositionals(root, DISCOVERED, ['tests/*.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['tests/**/c.e2e.ts']).files).toEqual([
      'tests/agent/nested/c.e2e.ts',
    ]);
    expect(selectPositionals(root, DISCOVERED, ['tests/?.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['**/*.e2e.ts']).files).toEqual(DISCOVERED);
  });

  it('unions positionals and preserves discovery order', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/other', 'tests/a.e2e.ts', 'tests/agent/*.e2e.ts']);
    expect(selection.files).toEqual(['tests/a.e2e.ts', 'tests/agent/b.e2e.ts', 'tests/other/d.e2e.ts']);
    expect(selection.unmatched).toEqual([]);
  });

  it('reports each positional that selected nothing, as written', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/agnet', 'tests/*.spec.ts', 'tests/a.e2e.ts']);
    expect(selection.files).toEqual(['tests/a.e2e.ts']);
    expect(selection.unmatched).toEqual(['tests/agnet', 'tests/*.spec.ts']);
  });

  it('rejects a positional outside the project root', () => {
    expect(() => selectPositionals(root, DISCOVERED, ['../elsewhere.e2e.ts'])).toThrow(/outside the project root/);
    expect(() => selectPositionals(root, DISCOVERED, ['tests/../../x.e2e.ts'])).toThrow(/outside the project root/);
  });

  it('rejects a malformed glob with INVALID_GLOB', () => {
    expect(() => selectPositionals(root, DISCOVERED, ['tests/**agent/*.ts'])).toThrow(/complete path segment/);
  });

  it('follows on-disk casing for existing files and directories on a case-insensitive filesystem', (ctx) => {
    if (!caseInsensitiveFs) ctx.skip();
    expect(selectPositionals(root, DISCOVERED, ['tests/Agent']).files).toEqual([
      'tests/agent/b.e2e.ts',
      'tests/agent/nested/c.e2e.ts',
    ]);
    expect(selectPositionals(root, DISCOVERED, ['TESTS/A.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
  });

  it('treats a differently cased path as unmatched on a case-sensitive filesystem', (ctx) => {
    if (caseInsensitiveFs) ctx.skip();
    const selection = selectPositionals(root, DISCOVERED, ['tests/Agent', 'TESTS/A.e2e.ts']);
    expect(selection.files).toEqual([]);
    expect(selection.unmatched).toEqual(['tests/Agent', 'TESTS/A.e2e.ts']);
  });

  it('keeps globs case-sensitive on every filesystem', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/Agent/*.e2e.ts']);
    expect(selection.files).toEqual([]);
    expect(selection.unmatched).toEqual(['tests/Agent/*.e2e.ts']);
  });
});

describe('relativeToRoot', () => {
  it('normalizes posix paths to the wire form', () => {
    expect(relativeToRoot('/root', '/root/tests/a.e2e.ts')).toBe('tests/a.e2e.ts');
    expect(relativeToRoot('/root', './tests/agent/')).toBe('tests/agent');
    expect(relativeToRoot('/root', '/root')).toBe('.');
    expect(() => relativeToRoot('/root', '/elsewhere/a.e2e.ts')).toThrow(/outside the project root/);
  });

  // Simulated with path.win32 so the drive and UNC rules run on every host.
  it('normalizes Windows paths inside the root with / separators', () => {
    const win = path.win32;
    expect(relativeToRoot('C:\\proj', 'C:\\proj\\tests\\a.e2e.ts', win)).toBe('tests/a.e2e.ts');
    expect(relativeToRoot('C:\\proj', 'c:\\proj\\tests\\agent\\', win)).toBe('tests/agent');
    expect(relativeToRoot('C:\\proj', 'tests\\agent', win)).toBe('tests/agent');
    expect(relativeToRoot('C:\\proj', 'C:\\proj', win)).toBe('.');
  });

  it('rejects Windows paths on another drive or UNC share as outside the root', () => {
    const win = path.win32;
    expect(() => relativeToRoot('C:\\proj', 'D:\\proj\\tests\\a.e2e.ts', win)).toThrow(/outside the project root/);
    expect(() => relativeToRoot('C:\\proj', '\\\\server\\share\\tests\\a.e2e.ts', win)).toThrow(
      /outside the project root/,
    );
    expect(() => relativeToRoot('\\\\server\\share\\proj', 'C:\\proj\\tests\\a.e2e.ts', win)).toThrow(
      /outside the project root/,
    );
    expect(() => relativeToRoot('C:\\proj', 'C:\\other\\a.e2e.ts', win)).toThrow(/outside the project root/);
  });
});
