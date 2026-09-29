import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collect, excludingEntry, relativeToRoot, selectPositionals } from '../../src/collect/collect.ts';
import { resolveConfig } from '../../src/config/resolve.ts';

// What the config globs discovered, in discovery order. `tests/agent/notes.md`
// exists on disk but is not in this list: positionals only narrow it.
const DISCOVERED = [
  'tests/a.e2e.ts',
  'tests/agent/b.e2e.ts',
  'tests/agent/nested/c.e2e.ts',
  'tests/lit{x}.e2e.ts',
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
    expect(selectPositionals(root, DISCOVERED, [])).toEqual({ files: DISCOVERED, unmatched: [], lines: new Map() });
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
    const selection = selectPositionals(root, DISCOVERED, ['tests/agent', 'tests/agent/notes.md', 'notes.md', 'notes']);
    expect(selection.files).toEqual(['tests/agent/b.e2e.ts', 'tests/agent/nested/c.e2e.ts']);
    expect(selection.unmatched).toEqual(['tests/agent/notes.md', 'notes.md', 'notes']);
  });

  it('matches a bare file name anywhere beneath the root', () => {
    expect(selectPositionals(root, DISCOVERED, ['a.e2e.ts']).files).toEqual(['tests/a.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['c.e2e.ts']).files).toEqual(['tests/agent/nested/c.e2e.ts']);
  });

  it('matches a file name with every extension dropped', () => {
    expect(selectPositionals(root, DISCOVERED, ['b']).files).toEqual(['tests/agent/b.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['d']).files).toEqual(['tests/other/d.e2e.ts']);
    // With a dot the positional is a file name, so its extensions have to be spelled out.
    expect(selectPositionals(root, DISCOVERED, ['b.e2e']).unmatched).toEqual(['b.e2e']);
  });

  it('matches a trailing run of path segments', () => {
    expect(selectPositionals(root, DISCOVERED, ['agent/b.e2e.ts']).files).toEqual(['tests/agent/b.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['nested/c.e2e.ts']).files).toEqual(['tests/agent/nested/c.e2e.ts']);
    expect(selectPositionals(root, DISCOVERED, ['./agent/b.e2e.ts']).files).toEqual(['tests/agent/b.e2e.ts']);
  });

  it('never matches a name inside a path segment', () => {
    const selection = selectPositionals(root, DISCOVERED, ['ests/a.e2e.ts', 'e2e.ts', '.e2e.ts', 'gent/b.e2e.ts']);
    expect(selection.files).toEqual([]);
    expect(selection.unmatched).toEqual(['ests/a.e2e.ts', 'e2e.ts', '.e2e.ts', 'gent/b.e2e.ts']);
  });

  it('splits a trailing :line off any positional form and keeps the lines per file', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/a.e2e.ts:12', 'b:7', 'agent/b.e2e.ts:9', 'tests/other/*.e2e.ts:3']);
    expect(selection.files).toEqual(['tests/a.e2e.ts', 'tests/agent/b.e2e.ts', 'tests/other/d.e2e.ts']);
    expect(selection.unmatched).toEqual([]);
    expect([...selection.lines]).toEqual([
      ['tests/a.e2e.ts', [12]],
      ['tests/agent/b.e2e.ts', [7, 9]],
      ['tests/other/d.e2e.ts', [3]],
    ]);
  });

  it('selects a file whole when any positional names it without a line', () => {
    const selection = selectPositionals(root, DISCOVERED, ['tests/a.e2e.ts:12', 'tests/a.e2e.ts', 'd.e2e.ts:4']);
    expect(selection.files).toEqual(['tests/a.e2e.ts', 'tests/other/d.e2e.ts']);
    expect([...selection.lines]).toEqual([['tests/other/d.e2e.ts', [4]]]);
  });

  it('reads :0 and a path that exists on disk as the path itself', () => {
    expect(selectPositionals(root, DISCOVERED, ['tests/a.e2e.ts:0']).unmatched).toEqual(['tests/a.e2e.ts:0']);
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts:1'), '');
    try {
      const literal = selectPositionals(root, [...DISCOVERED, 'tests/a.e2e.ts:1'], ['tests/a.e2e.ts:1']);
      expect(literal.files).toEqual(['tests/a.e2e.ts:1']);
      expect(literal.lines.size).toBe(0);
    } finally {
      rmSync(path.join(root, 'tests', 'a.e2e.ts:1'));
    }
  });

  it('keeps names case-sensitive on every filesystem', () => {
    const selection = selectPositionals(root, DISCOVERED, ['A.e2e.ts', 'B', 'Agent/b.e2e.ts']);
    expect(selection.files).toEqual([]);
    expect(selection.unmatched).toEqual(['A.e2e.ts', 'B', 'Agent/b.e2e.ts']);
  });

  it('unions names with the other forms and preserves discovery order', () => {
    const selection = selectPositionals(root, DISCOVERED, ['d.e2e.ts', 'tests/agent/*.e2e.ts', 'a']);
    expect(selection.files).toEqual(['tests/a.e2e.ts', 'tests/agent/b.e2e.ts', 'tests/other/d.e2e.ts']);
    expect(selection.unmatched).toEqual([]);
  });

  it('matches a glob against the discovered files with the config grammar', () => {
    expect(selectPositionals(root, DISCOVERED, ['tests/*.e2e.ts']).files).toEqual(['tests/a.e2e.ts', 'tests/lit{x}.e2e.ts']);
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
    expect(() => selectPositionals(root, DISCOVERED, ['tests/{a,b}.e2e.ts'])).toThrow(/brace expansion/);
    expect(() => selectPositionals(root, DISCOVERED, ['tests/*.e2e.[jt]s'])).toThrow(/character classes/);
  });

  it('selects an existing file by its path whatever its name is spelled with', () => {
    expect(selectPositionals(root, DISCOVERED, ['tests/lit{x}.e2e.ts']).files).toEqual(['tests/lit{x}.e2e.ts']);
    // The same spelling for a file that does not exist is read as a glob, and told why it cannot be one.
    expect(() => selectPositionals(root, DISCOVERED, ['tests/lit{y}.e2e.ts'])).toThrow(/brace expansion/);
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

describe('collect', () => {
  it('names look-alike files under the directory a ./-prefixed glob starts in', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-near-miss-'));
    try {
      mkdirSync(path.join(projectRoot, 'tests'));
      writeFileSync(path.join(projectRoot, 'tests', 'login.test.ts'), '');
      const config = resolveConfig(
        { targets: [{ name: 'web', platform: 'web' }], tests: './tests/**/*.e2e.ts' },
        { projectRoot, env: {} as NodeJS.ProcessEnv },
      );
      const collection = await collect(config);
      expect(collection.files).toEqual([]);
      expect(collection.nearMisses).toEqual(['tests/login.test.ts']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('collects no file that a "!" exclusion names, and never offers one as a look-alike', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-exclude-'));
    try {
      for (const file of ['tests/wip/b.e2e.ts', 'tests/wip/c.test.ts', 'tests/login.test.ts']) {
        mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
        writeFileSync(path.join(projectRoot, file), '');
      }
      const resolve = (): ReturnType<typeof resolveConfig> =>
        resolveConfig(
          { targets: [{ name: 'web', platform: 'web' }], tests: ['tests/**/*.e2e.ts', '!tests/wip/**'] },
          { projectRoot, env: {} as NodeJS.ProcessEnv },
        );
      const empty = await collect(resolve());
      expect(empty.files).toEqual([]);
      expect(empty.nearMisses).toEqual(['tests/login.test.ts']);
      writeFileSync(path.join(projectRoot, 'tests', 'a.e2e.ts'), '');
      expect((await collect(resolve())).files.map((file) => file.file)).toEqual(['tests/a.e2e.ts']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
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

describe('excludingEntry', () => {
  const tests = ['tests/**/*.e2e.ts', '!tests/agent/**'];

  it('names the ! entry that takes out the file a positional names', () => {
    expect(excludingEntry(root, tests, 'tests/agent/b.e2e.ts')).toBe('!tests/agent/**');
    expect(excludingEntry(root, tests, 'tests/agent/b.e2e.ts:3')).toBe('!tests/agent/**');
    expect(excludingEntry(root, tests, 'tests/a.e2e.ts')).toBeUndefined();
    expect(excludingEntry(root, tests, 'tests/agent/*.e2e.ts')).toBeUndefined();
    expect(excludingEntry(root, tests, 'tests/agent/notes.md')).toBeUndefined();
  });

  it('compares an existing file in its on-disk casing on a case-insensitive filesystem', (ctx) => {
    if (!caseInsensitiveFs) ctx.skip();
    expect(excludingEntry(root, tests, 'Tests/Agent/b.e2e.ts')).toBe('!tests/agent/**');
  });
});
