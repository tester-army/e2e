import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDevDependencyCommand,
  detectPackageManager,
  execCommand,
  runScriptCommand,
  type PackageManager,
} from '../../src/internal/package-manager.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-pm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectPackageManager', () => {
  it('prefers the packageManager field, then a lockfile, then the invoking manager, then npm', () => {
    expect(detectPackageManager(dir, 'pnpm@10.0.0', {})).toBe('pnpm');
    expect(detectPackageManager(dir, 'unknown@1', {})).toBe('npm');
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir, undefined, {})).toBe('yarn');
    rmSync(path.join(dir, 'yarn.lock'));
    expect(detectPackageManager(dir, undefined, { npm_config_user_agent: 'bun/1.2.0' })).toBe('bun');
    expect(detectPackageManager(dir, undefined, { npm_config_user_agent: 'cargo/1' })).toBe('npm');
    expect(detectPackageManager(dir, undefined, {})).toBe('npm');
  });
});

describe('manager commands', () => {
  it('spells the script run, the binary exec, and the dev dependency add for each manager', () => {
    expect((['npm', 'pnpm', 'yarn', 'bun'] as const satisfies readonly PackageManager[]).map((manager) => [
      runScriptCommand(manager, 'test:e2e'),
      execCommand(manager, 'e2e guide'),
      addDevDependencyCommand(manager, 'ai'),
    ])).toEqual([
      ['npm run test:e2e', 'npm exec -- e2e guide', 'npm install --save-dev ai'],
      ['pnpm test:e2e', 'pnpm exec e2e guide', 'pnpm add -D ai'],
      ['yarn test:e2e', 'yarn e2e guide', 'yarn add -D ai'],
      ['bun run test:e2e', 'bun run e2e guide', 'bun add -d ai'],
    ]);
  });
});
