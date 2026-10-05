import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDevDependencyCommand, detectPackageManager, execCommand, runScriptCommand } from '../../src/internal/package-manager.ts';

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

describe('runScriptCommand', () => {
  it('spells the script run for each manager', () => {
    expect(runScriptCommand('npm', 'test:e2e')).toBe('npm run test:e2e');
    expect(runScriptCommand('pnpm', 'test:e2e')).toBe('pnpm test:e2e');
    expect(runScriptCommand('yarn', 'test:e2e')).toBe('yarn test:e2e');
    expect(runScriptCommand('bun', 'test:e2e')).toBe('bun run test:e2e');
  });
});

describe('execCommand', () => {
  it('runs the installed binary with each manager', () => {
    expect(execCommand('npm', 'e2e guide')).toBe('npm exec -- e2e guide');
    expect(execCommand('pnpm', 'e2e guide')).toBe('pnpm exec e2e guide');
    expect(execCommand('yarn', 'e2e guide')).toBe('yarn e2e guide');
    expect(execCommand('bun', 'e2e guide')).toBe('bun run e2e guide');
  });
});

describe('addDevDependencyCommand', () => {
  it('spells the add command for each manager', () => {
    expect(addDevDependencyCommand('npm', 'ai')).toBe('npm install --save-dev ai');
    expect(addDevDependencyCommand('pnpm', 'ai')).toBe('pnpm add -D ai');
    expect(addDevDependencyCommand('yarn', 'ai')).toBe('yarn add -D ai');
    expect(addDevDependencyCommand('bun', 'ai')).toBe('bun add -d ai');
  });
});
