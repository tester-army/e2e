import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateCheck, type UpdateCheckOptions } from '../../src/cli/update-check.ts';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const temporaries: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-update-check-'));
  temporaries.push(dir);
  return dir;
}

/** A registry that answers `latest` with `version`, or fails when it is undefined. */
function registry(version: string | undefined) {
  return vi.fn<typeof fetch>(async () =>
    version === undefined ? Response.error() : Response.json({ name: 'e2e', version }),
  );
}

/** A check on a terminal outside CI, with its output captured. */
function setup(overrides: Partial<UpdateCheckOptions> = {}) {
  const lines: string[] = [];
  const options: UpdateCheckOptions = {
    version: '0.21.2',
    env: {},
    interactive: true,
    configDir: tempDir(),
    cwd: tempDir(),
    now: () => NOW,
    write: (text) => void lines.push(text),
    ...overrides,
  };
  return { options, output: () => stripVTControlCharacters(lines.join('')) };
}

/** `apps/web` with its own package.json under `root`. */
function workspacePackage(root: string): string {
  const dir = path.join(root, 'apps', 'web');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

function record(configDir: string): unknown {
  return JSON.parse(readFileSync(path.join(configDir, 'update-check.json'), 'utf8'));
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('update check', () => {
  it('names the newer release and the install command for the project', async () => {
    const fetch = registry('0.22.0');
    const { options, output } = setup({ fetch });
    writeFileSync(path.join(options.cwd!, 'pnpm-lock.yaml'), '');
    const check = new UpdateCheck(options);
    check.start('run');
    await check.notify();
    expect(fetch).toHaveBeenCalledOnce();
    expect(output()).toContain('0.21.2 → 0.22.0');
    expect(output()).toContain('pnpm add -D e2e@latest');
    expect(record(options.configDir!)).toEqual({ checkedAt: NOW, latest: '0.22.0' });
  });

  it.each<[string, (root: string) => string, string]>([
    [
      'a workspace package, from the lockfile at the root',
      (root) => {
        writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
        return workspacePackage(root);
      },
      'pnpm add -D e2e@latest',
    ],
    [
      'a workspace package, from the packageManager field at the root',
      (root) => {
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.5.0' }));
        return workspacePackage(root);
      },
      'yarn add -D e2e@latest',
    ],
    [
      'the root of a pnpm workspace',
      (root) => {
        writeFileSync(path.join(root, 'package.json'), '{}');
        writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
        writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
        return root;
      },
      'pnpm add -D e2e@latest -w',
    ],
  ])('names the install command for %s', async (_name, project, command) => {
    const { options, output } = setup({ fetch: registry('0.22.0') });
    const check = new UpdateCheck({ ...options, cwd: project(options.cwd!) });
    check.start('run');
    await check.notify();
    expect(output()).toContain(`Run ${command} to update.`);
  });

  it('reminds from the saved answer without asking again within a day', async () => {
    const { options, output } = setup({ fetch: registry('0.23.0') });
    writeFileSync(path.join(options.configDir!, 'update-check.json'), JSON.stringify({ checkedAt: NOW - DAY_MS + 1, latest: '0.22.0' }));
    const check = new UpdateCheck(options);
    check.start('run');
    await check.notify();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(output()).toContain('0.22.0');
  });

  it('asks again after a day, and keeps the last answer when the registry fails', async () => {
    const { options, output } = setup({ fetch: registry(undefined) });
    writeFileSync(path.join(options.configDir!, 'update-check.json'), JSON.stringify({ checkedAt: NOW - DAY_MS, latest: '0.22.0' }));
    const check = new UpdateCheck(options);
    check.start('run');
    await check.notify();
    expect(options.fetch).toHaveBeenCalledOnce();
    expect(output()).toContain('0.22.0');
    expect(record(options.configDir!)).toEqual({ checkedAt: NOW, latest: '0.22.0' });
  });

  it.each(['0.21.2', '0.21.1', 'garbage'])('prints nothing when latest is %s', async (latest) => {
    const { options, output } = setup({ fetch: registry(latest) });
    const check = new UpdateCheck(options);
    check.start('run');
    await check.notify();
    expect(output()).toBe('');
  });

  it.each<[string, Partial<UpdateCheckOptions>, string]>([
    ['in CI', { env: { CI: 'true' } }, 'run'],
    ['with E2E_UPDATE_CHECK_DISABLED', { env: { E2E_UPDATE_CHECK_DISABLED: '1' } }, 'run'],
    ['with NO_UPDATE_NOTIFIER', { env: { NO_UPDATE_NOTIFIER: '1' } }, 'run'],
    ['with E2E_TELEMETRY_DISABLED', { env: { E2E_TELEMETRY_DISABLED: '1' } }, 'run'],
    ['with DO_NOT_TRACK', { env: { DO_NOT_TRACK: '1' } }, 'run'],
    ['off a terminal', { interactive: false }, 'run'],
    ['from a checkout', { checkout: true }, 'run'],
    ['for mcp', {}, 'mcp'],
  ])('neither asks nor prints %s', async (_name, overrides, command) => {
    const { options, output } = setup({ fetch: registry('0.22.0'), ...overrides });
    const check = new UpdateCheck(options);
    check.start(command);
    await check.notify();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(output()).toBe('');
  });

  it('prints nothing for an invocation that never started a command', async () => {
    const { options, output } = setup({ fetch: registry('0.22.0') });
    await new UpdateCheck(options).notify();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(output()).toBe('');
  });
});
