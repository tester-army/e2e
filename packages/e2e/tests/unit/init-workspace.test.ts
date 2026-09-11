import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkspace, isWorkspaceMember, parsePackageWorkspaces, parsePnpmWorkspace } from '../../src/cli/init/workspace.ts';

describe('parsePnpmWorkspace', () => {
  it('reads the packages list with quotes, comments, and exclusions as written', () => {
    const yaml = [
      '# members',
      'packages:',
      "  - 'apps/*'",
      '  - "packages/*" # every library',
      '',
      "  - '!packages/e2e-tests'",
      '  - !tools/*',
      'minimumReleaseAge: 1440',
      'catalog:',
      '  - not-a-package',
    ].join('\n');
    expect(parsePnpmWorkspace(yaml)).toEqual(['apps/*', 'packages/*', '!packages/e2e-tests', '!tools/*']);
  });

  it('treats an empty flow list as a workspace with no members', () => {
    expect(parsePnpmWorkspace('packages: []\n')).toEqual([]);
  });

  it('yields no workspace for shapes it does not read', () => {
    expect(parsePnpmWorkspace('catalog:\n  react: ^19\n')).toBeUndefined();
    expect(parsePnpmWorkspace("packages: ['apps/*']\n")).toBeUndefined();
    expect(parsePnpmWorkspace('packages:\n  -\n')).toBeUndefined();
    expect(parsePnpmWorkspace('packages:\nminimumReleaseAge: 1440\n')).toBeUndefined();
  });
});

describe('parsePackageWorkspaces', () => {
  it('reads the array and the yarn 1 object form', () => {
    expect(parsePackageWorkspaces('{ "workspaces": ["apps/*", "packages/*"] }')).toEqual(['apps/*', 'packages/*']);
    expect(parsePackageWorkspaces('{ "workspaces": { "packages": ["apps/*"], "nohoist": ["**/x"] } }')).toEqual(['apps/*']);
  });

  it('yields no workspace without the field, with a non-string entry, or with broken JSON', () => {
    expect(parsePackageWorkspaces('{ "name": "app" }')).toBeUndefined();
    expect(parsePackageWorkspaces('{ "workspaces": ["apps/*", 1] }')).toBeUndefined();
    expect(parsePackageWorkspaces('{ not json')).toBeUndefined();
  });
});

describe('isWorkspaceMember', () => {
  const patterns = ['apps/*', 'packages/**', '!packages/e2e-tests'];

  it('matches a directory one include glob names', () => {
    expect(isWorkspaceMember(patterns, 'apps/web')).toBe(true);
    expect(isWorkspaceMember(patterns, 'packages/tools/cli')).toBe(true);
  });

  it('rejects an excluded directory and one no glob names', () => {
    expect(isWorkspaceMember(patterns, 'packages/e2e-tests')).toBe(false);
    expect(isWorkspaceMember(patterns, 'tools/e2e')).toBe(false);
    expect(isWorkspaceMember(patterns, 'apps/web/tests')).toBe(false);
    expect(isWorkspaceMember([], 'apps/web')).toBe(false);
  });

  it('gives no verdict when a pattern uses syntax the glob grammar does not read', () => {
    expect(isWorkspaceMember(['packages/{web,api}'], 'packages/web')).toBeUndefined();
    expect(isWorkspaceMember(['apps/*', 'packages/[a-m]*'], 'apps/web')).toBeUndefined();
    expect(isWorkspaceMember(['apps/*', '!(legacy)/*'], 'apps/web')).toBeUndefined();
    expect(isWorkspaceMember(['apps/*', 'packages/**bad'], 'apps/web')).toBeUndefined();
  });
});

describe('findWorkspace', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops at an unreadable pnpm-workspace.yaml without consulting the workspace above it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-workspace-'));
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    const nested = path.join(dir, 'packages', 'suite');
    // A directory by the file's name: existsSync says yes, readFileSync throws EISDIR.
    mkdirSync(path.join(nested, 'pnpm-workspace.yaml'), { recursive: true });
    expect(findWorkspace(nested)).toBeUndefined();
    expect(findWorkspace(path.join(dir, 'packages'))).toEqual({ root: dir, file: 'pnpm-workspace.yaml', patterns: ['packages/*'] });
  });
});
