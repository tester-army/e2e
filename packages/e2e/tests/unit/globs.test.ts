import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareCodePoints,
  compileGlob,
  discoverFiles,
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

  it('rejects leading ! exclusions', () => {
    expect(() => compileGlob('!tests/**')).toThrow();
  });

  it('treats braces as literal characters', () => {
    expect(matches('a{b,c}.ts', 'a{b,c}.ts')).toBe(true);
    expect(matches('a{b,c}.ts', 'ab.ts')).toBe(false);
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

    const files = discoverFiles(root, ['tests/**/*.e2e.ts', 'tests/*.e2e.ts']);
    expect(files).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/nested/c.e2e.ts']);
  });
});

describe('compareCodePoints', () => {
  it('sorts by unicode code point, not UTF-16 units', () => {
    const items = ['b', 'a', '\u{1F600}', 'z'];
    expect([...items].sort(compareCodePoints)).toEqual(['a', 'b', 'z', '\u{1F600}']);
  });
});
