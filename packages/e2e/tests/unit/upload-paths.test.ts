/**
 * The upload policy: a model-named path reaches the engine only when it is a
 * regular file inside the project root and not hidden. Everything else fails
 * closed, with the code that says whether the path was refused or merely wrong.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeUploadPaths } from '../../src/agent/upload-paths.ts';

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'e2e-upload-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside.txt');
  mkdirSync(path.join(root, 'fixtures', '.hidden'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'a.txt'), 'a');
  writeFileSync(path.join(root, 'fixtures', '.hidden', 'b.txt'), 'b');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, path.join(root, 'fixtures', 'link.txt'));
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

const code = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe('authorizeUploadPaths', () => {
  it('resolves project-relative paths to regular files inside the root and keeps them as given', () => {
    const authorized = authorizeUploadPaths(['fixtures/a.txt'], root);
    expect(authorized.given).toEqual(['fixtures/a.txt']);
    expect(authorized.resolved).toEqual([path.join(root, 'fixtures', 'a.txt')]);
  });

  it('refuses a path that leaves the project, by dots or by a symlink', () => {
    expect(code(() => authorizeUploadPaths(['../outside.txt'], root))).toBe('POLICY_DENIED');
    expect(code(() => authorizeUploadPaths([outside], root))).toBe('POLICY_DENIED');
    expect(code(() => authorizeUploadPaths(['fixtures/link.txt'], root))).toBe('POLICY_DENIED');
  });

  it('refuses hidden files and anything under a hidden directory', () => {
    expect(code(() => authorizeUploadPaths(['.env'], root))).toBe('POLICY_DENIED');
    expect(code(() => authorizeUploadPaths(['fixtures/.hidden/b.txt'], root))).toBe('POLICY_DENIED');
  });

  it('reports a missing file or a directory as a wrong argument, not a policy refusal', () => {
    expect(code(() => authorizeUploadPaths(['fixtures/missing.txt'], root))).toBe('INVALID_ARGUMENT');
    expect(code(() => authorizeUploadPaths(['fixtures'], root))).toBe('INVALID_ARGUMENT');
  });

  it('requires a non-empty list of non-empty strings, bounded', () => {
    expect(code(() => authorizeUploadPaths([], root))).toBe('INVALID_ARGUMENT');
    expect(code(() => authorizeUploadPaths(['fixtures/a.txt', ''], root))).toBe('INVALID_ARGUMENT');
    expect(code(() => authorizeUploadPaths('fixtures/a.txt', root))).toBe('INVALID_ARGUMENT');
    expect(code(() => authorizeUploadPaths(Array.from({ length: 17 }, () => 'fixtures/a.txt'), root))).toBe('INVALID_ARGUMENT');
  });

  it('checks every path before any is accepted', () => {
    expect(code(() => authorizeUploadPaths(['fixtures/a.txt', '.env'], root))).toBe('POLICY_DENIED');
  });
});
