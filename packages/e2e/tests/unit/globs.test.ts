import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareCodePoints } from '../../src/internal/compare.ts';
import {
  compileGlob,
  compileGlobList,
  discoverFiles,
  GLOB_SYNTAX,
  literalPrefix,
  matchesGlob,
} from '../../src/internal/globs.ts';

function matches(pattern: string, candidate: string): boolean {
  return matchesGlob(compileGlob(pattern), candidate);
}

describe('glob grammar', () => {
  it('* matches zero or more non-/ characters', () => {
    expect(matches('tests/*.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
    expect(matches('tests/*.e2e.ts', 'tests/.e2e.ts')).toBe(false); // dot segment rule
    expect(matches('tests/*.e2e.ts', 'tests/sub/a.e2e.ts')).toBe(false);
  });

  it('? matches exactly one non-/ character', () => {
    expect(matches('a?.ts', 'ab.ts')).toBe(true);
    expect(matches('a?.ts', 'a.ts')).toBe(false);
    expect(matches('a?.ts', 'a/b.ts')).toBe(false);
  });

  it('a complete ** segment matches zero or more path segments', () => {
    expect(matches('tests/**/*.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
    expect(matches('tests/**/*.e2e.ts', 'tests/x/y/a.e2e.ts')).toBe(true);
    expect(matches('**/*.ts', 'deep/nested/file.ts')).toBe(true);
  });

  it('rejects ** that is not a complete segment', () => {
    expect(() => compileGlob('tests/**foo/*.ts')).toThrow();
  });

  it('rejects a "!" in one glob: an exclusion is a list entry that starts with it', () => {
    expect(() => compileGlob('!tests/**')).toThrow(/written once, at the very start of a tests entry/);
    expect(() => compileGlob('./!tests/**')).toThrow(/written once, at the very start of a tests entry/);
  });

  it('splits a glob list into including globs and "!" exclusions', () => {
    const { include, exclude } = compileGlobList(['tests/**/*.e2e.ts', '!tests/wip/**', '!./tests/slow.e2e.ts']);
    expect(include.map(literalPrefix)).toEqual([['tests']]);
    expect(exclude.map(literalPrefix)).toEqual([['tests', 'wip'], ['tests', 'slow.e2e.ts']]);
    expect(() => compileGlobList(['tests/**', '!'])).toThrow(/"!" excludes nothing/);
    expect(() => compileGlobList(['!!tests/**'])).toThrow(/written once/);
    expect(() => compileGlobList(['!tests/{a,b}/**'])).toThrow(/brace expansion is unsupported/);
  });

  it('drops a leading ./, a . segment, and a doubled /', () => {
    expect(literalPrefix(compileGlob('./tests/./sub//**/*.e2e.ts'))).toEqual(['tests', 'sub']);
    expect(matches('./tests/**/*.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
    expect(matches('tests//*.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
    expect(matches('tests/./*.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
  });

  it('matches a segment without wildcards by name, dots included', () => {
    expect(matches('tests/a.e2e.ts', 'tests/a.e2e.ts')).toBe(true);
    expect(matches('tests/a.e2e.ts', 'tests/b.e2e.ts')).toBe(false);
    expect(matches('foo..e2e.ts', 'foo..e2e.ts')).toBe(true);
    expect(matches('tests/..foo/*.ts', 'tests/..foo/a.ts')).toBe(true);
    expect(literalPrefix(compileGlob('tests/a.e2e.ts'))).toEqual(['tests', 'a.e2e.ts']);
    expect(literalPrefix(compileGlob('**/*.e2e.ts'))).toEqual([]);
  });

  it('rejects what the grammar lacks instead of matching nothing', () => {
    expect(() => compileGlob('/abs/tests/*.ts')).toThrow(/relative to the project root/);
    expect(() => compileGlob('C:/tests/*.ts')).toThrow(/relative to the project root/);
    expect(() => compileGlob('tests/**/')).toThrow(/cannot end with "\/"/);
    expect(() => compileGlob('tests/.')).toThrow(/cannot end with "\."/);
    expect(() => compileGlob('tests/{a,b}.ts')).toThrow(/brace expansion is unsupported/);
    expect(() => compileGlob('tests/*.e2e.[jt]s')).toThrow(/character classes are unsupported/);
    expect(() => compileGlob('tests/@(a|b).e2e.ts')).toThrow(/extglobs are unsupported/);
    expect(() => compileGlob('tests/**/!(bak).e2e.ts')).toThrow(/extglobs are unsupported/);
    expect(() => compileGlob('tests\\**\\*.ts')).toThrow(/"\/" as the separator/);
    expect(() => compileGlob('../tests/*.ts')).toThrow(/a "\.\." segment is not resolved/);
    expect(() => compileGlob('a/../tests/*.ts')).toThrow(/a "\.\." segment is not resolved/);
    expect(() => compileGlob('./')).toThrow(/is the project root, not a file pattern/);
    expect(() => compileGlob('.')).toThrow(/is the project root, not a file pattern/);
  });

  it('tells a glob from a path by the syntax the grammar reads or rejects', () => {
    for (const glob of ['tests/*.e2e.ts', 'tests/?.ts', 'tests/{a,b}.ts', 'tests/*.[jt]s', 'tests/@(a|b).ts', '!(x).ts']) {
      expect(GLOB_SYNTAX.test(glob)).toBe(true);
    }
    for (const name of ['tests/a.e2e.ts', 'app/(auth)/login.e2e.ts', 'tests/a b.e2e.ts', 'tests/foo..e2e.ts']) {
      expect(GLOB_SYNTAX.test(name)).toBe(false);
    }
  });

  it('is case-sensitive', () => {
    expect(matches('Tests/*.ts', 'tests/a.ts')).toBe(false);
  });

  it('does not match dot segments unless the pattern segment starts with a dot', () => {
    expect(matches('**/*.ts', '.hidden/a.ts')).toBe(false);
    expect(matches('.hidden/*.ts', '.hidden/a.ts')).toBe(true);
    expect(matches('tests/*.ts', 'tests/.a.ts')).toBe(false);
    expect(matches('tests/.*.ts', 'tests/.a.ts')).toBe(true);
  });
});

describe('discoverFiles', () => {
  it('matches, unions, de-duplicates, and sorts by code point', () => {
    const root = path.join(tmpdir(), `e2e-globs-${Date.now()}`);
    mkdirSync(path.join(root, 'tests', 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'tests', 'b.e2e.ts'), '');
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), '');
    writeFileSync(path.join(root, 'tests', 'nested', 'c.e2e.ts'), '');
    writeFileSync(path.join(root, 'tests', 'skip.txt'), '');
    mkdirSync(path.join(root, '.hidden'), { recursive: true });
    writeFileSync(path.join(root, '.hidden', 'h.e2e.ts'), '');

    const files = discoverFiles(root, ['tests/**/*.e2e.ts', 'tests/*.e2e.ts']);
    expect(files).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/nested/c.e2e.ts']);
    // The `./` spelling selects the same files; the `.hidden` file stays out because no segment spells a dot.
    expect(discoverFiles(root, ['./tests/**/*.e2e.ts'])).toEqual(files);
  });
});

describe('compareCodePoints', () => {
  it('sorts by unicode code point, not UTF-16 units', () => {
    const items = ['b', 'a', '\u{1F600}', 'z'];
    expect([...items].toSorted(compareCodePoints)).toEqual(['a', 'b', 'z', '\u{1F600}']);
  });
});
