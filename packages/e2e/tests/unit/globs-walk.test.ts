/** The discovery walk reads only what a glob can match beneath. Pruning has no visible result of its own, so the directories read are recorded. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { discoverFiles } from '../../src/internal/globs.ts';

const { readDirectories } = vi.hoisted(() => ({ readDirectories: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // `readdirSync` is overloaded, so the recorder is typed loosely and cast back.
  const readdirSync = (...args: unknown[]): unknown => {
    readDirectories.push(String(args[0]));
    return (actual.readdirSync as (...inner: unknown[]) => unknown)(...args);
  };
  return { ...actual, readdirSync: readdirSync as unknown as typeof actual.readdirSync };
});

const DIRECTORIES = ['tests/sub', 'tests/.hidden', 'apps/web/src/components', 'build/deep', '.git/objects', 'node_modules/pkg', 'linked-target'];
const FILES = [
  'tests/a.e2e.ts',
  'tests/sub/b.e2e.ts',
  'tests/.hidden/h.e2e.ts',
  'apps/web/src/components/c.e2e.ts',
  'build/deep/d.e2e.ts',
  '.git/objects/blob',
  'node_modules/pkg/n.e2e.ts',
  'linked-target/t.e2e.ts',
];

let root: string;
// Creating a symlink needs a privilege on Windows; the symlink case skips where it cannot be set up.
let symlinks = false;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'e2e-walk-'));
  for (const dir of DIRECTORIES) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of FILES) writeFileSync(path.join(root, file), '');
  try {
    symlinkSync(path.join(root, 'linked-target'), path.join(root, 'tests', 'linked-dir'));
    symlinkSync(path.join(root, 'tests', 'a.e2e.ts'), path.join(root, 'tests', 'linked.e2e.ts'));
    symlinks = true;
  } catch {
    symlinks = false;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The files a discovery finds and the root-relative directories it read to find them, `/`-separated on every OS. */
function discover(patterns: readonly string[]): { files: string[]; dirs: string[] } {
  readDirectories.length = 0;
  const files = discoverFiles(root, patterns);
  const dirs = readDirectories
    .map((dir) => path.relative(root, dir).split(path.sep).join('/') || '.')
    .toSorted();
  return { files, dirs };
}

describe('discoverFiles walk', () => {
  it('lists the root, then reads only the directories a glob can match beneath', () => {
    expect(discover(['tests/**/*.e2e.ts'])).toEqual({
      files: ['tests/a.e2e.ts', 'tests/sub/b.e2e.ts'],
      dirs: ['.', 'tests', 'tests/sub'],
    });
    expect(discover(['tests/*.e2e.ts'])).toEqual({ files: ['tests/a.e2e.ts'], dirs: ['.', 'tests'] });
    expect(discover(['apps/*/src/**/*.e2e.ts'])).toEqual({
      files: ['apps/web/src/components/c.e2e.ts'],
      dirs: ['.', 'apps', 'apps/web', 'apps/web/src', 'apps/web/src/components'],
    });
    expect(discover(['tests/a.e2e.ts']).dirs).toEqual(['.', 'tests']);
    expect(discover(['tests/**'])).toEqual({ files: ['tests/a.e2e.ts', 'tests/sub/b.e2e.ts'], dirs: ['.', 'tests', 'tests/sub'] });
  });

  it('stops where no file could match: a glob naming a directory, or a directory that does not exist', () => {
    expect(discover(['tests/sub'])).toEqual({ files: [], dirs: ['.', 'tests'] });
    expect(discover(['nope/**/*.e2e.ts'])).toEqual({ files: [], dirs: ['.'] });
  });

  it('enters a dot directory only when a segment spelled with the dot matches it, and node_modules never', () => {
    expect(discover(['**/*.e2e.ts'])).toEqual({
      files: ['apps/web/src/components/c.e2e.ts', 'build/deep/d.e2e.ts', 'linked-target/t.e2e.ts', 'tests/a.e2e.ts', 'tests/sub/b.e2e.ts'],
      dirs: ['.', 'apps', 'apps/web', 'apps/web/src', 'apps/web/src/components', 'build', 'build/deep', 'linked-target', 'tests', 'tests/sub'],
    });
    expect(discover(['tests/.hidden/*.e2e.ts'])).toEqual({
      files: ['tests/.hidden/h.e2e.ts'],
      dirs: ['.', 'tests', 'tests/.hidden'],
    });
    expect(discover(['**/.hidden/*.e2e.ts']).files).toEqual(['tests/.hidden/h.e2e.ts']);
    expect(discover(['node_modules/**/*.e2e.ts'])).toEqual({ files: [], dirs: ['.'] });
  });

  it('does not follow symlinks to directories or files', (ctx) => {
    if (!symlinks) ctx.skip();
    const { files, dirs } = discover(['tests/**/*.e2e.ts', 'tests/**/*.ts']);
    expect(files).toEqual(['tests/a.e2e.ts', 'tests/sub/b.e2e.ts']);
    expect(dirs).not.toContain('tests/linked-dir');
  });
});
